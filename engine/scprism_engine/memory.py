"""Memory — the three-tier memory system (Harness Layer 1, ADR-014).

**Agent = Model + Harness**, and memory is the harness tier that gives the loop
durable state without letting a hallucination poison the source of truth. Three
tiers (specs/03 Layer 1):

  * **L1 — profile.** Static facts about *who the user is* (name, role, the
    governance domain they operate in). Config-provided, never mutated by a run.
  * **L2 — working memory.** Per-task scratch state, **strictly session
    isolated**: two agents governing different policies concurrently physically
    cannot read each other's working memory (separate namespaces, no shared
    key-space). This is the anti-cross-contamination invariant of specs/03.
  * **L3 — vault.** The git-synced markdown vault on disk — the single source of
    truth (CLAUDE invariant). Everything else is derived/regenerable from it.

Three capabilities this module adds on top of the tiers:

  * **Write-validation gate** — ``validate_write(path, content, rules)`` dry-runs
    every vault write against the rule files BEFORE it persists (ADR-014). A
    contradiction / hallucination is rejected *with a reason*; it never reaches
    L3. Fails closed. Wired through ``writeback.persist_vault_write``.
  * **Token-budget management** — ``select_context(items, budget)`` never injects
    the whole vault; it packs the highest-value items that fit a fixed budget.
    Injection provably never exceeds the budget.
  * **Query candidates** — the store assembles L1+L2+L3 candidates for a task so
    the loop can inject memory under budget at plan time.

Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

# ---------------------------------------------------------------------------
# Token accounting — one deterministic estimate shared across the harness
# (~4 chars/token, matches the gateway's estimate).
# ---------------------------------------------------------------------------


def est_tokens(text: str) -> int:
    """Deterministic ~4-chars/token estimate (min 1 for non-empty)."""
    text = text or ""
    if not text:
        return 0
    return max(1, len(text) // 4)


# ---------------------------------------------------------------------------
# Tiers.
# ---------------------------------------------------------------------------
L1 = "L1"  # profile — static, who the user is
L2 = "L2"  # working memory — per-task, session isolated
MAX_INDEXED_DOCS = 2000  # ahead-of-every-turn bound on the index build
L3 = "L3"  # vault — markdown source of truth on disk

def _is_machine_written(rel: str) -> bool:
    """Engine output, not user knowledge — kept out of recall.

    Mirrors the keyword scan's skip rule so both paths surface the same set:
    verdicts are the engine's own conclusions and dotted trees are machinery.
    Recalling our own verdicts back into a prompt is a feedback loop, not
    memory.
    """
    parts = (rel or "").replace("\\", "/").split("/")
    return any(p == "verdicts" or p.startswith(".") for p in parts)



TIERS = (L1, L2, L3)


@dataclass
class MemoryItem:
    """One candidate memory fact considered for injection.

    Attributes:
        id: stable identifier (deduplication key).
        tier: L1 / L2 / L3 — provenance of the fact.
        content: the text that would be injected into context.
        priority: higher = more valuable; drives budget packing.
        source: where it came from (profile key, session id, vault path).
    """

    id: str
    tier: str
    content: str
    priority: float = 1.0
    source: str = ""

    @property
    def tokens(self) -> int:
        return est_tokens(self.content)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "tokens": self.tokens,
            "priority": self.priority,
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# L2 — working memory, session isolated.
# ---------------------------------------------------------------------------
class WorkingMemory:
    """A per-session scratch namespace.

    A ``WorkingMemory`` view is bound to exactly one ``session_id`` and holds its
    own private dict. There is no API to reach another session's dict from here —
    that is the physical guarantee behind "two concurrent tasks cannot read each
    other's working memory" (specs/03 Layer 1).
    """

    def __init__(self, session_id: str) -> None:
        if not session_id or not str(session_id).strip():
            raise ValueError("working memory requires a non-empty session_id")
        self.session_id = session_id
        self._data: Dict[str, Any] = {}

    def put(self, key: str, value: Any) -> None:
        self._data[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def keys(self) -> List[str]:
        return list(self._data.keys())

    def items(self) -> List[MemoryItem]:
        """Working facts as injectable candidates (moderate priority)."""
        out: List[MemoryItem] = []
        for k, v in self._data.items():
            out.append(
                MemoryItem(
                    id=f"L2:{self.session_id}:{k}",
                    tier=L2,
                    content=f"{k}: {v}",
                    priority=2.0,
                    source=f"working/{self.session_id}",
                )
            )
        return out


# ---------------------------------------------------------------------------
# Write-validation gate (ADR-014 / specs/04 §6).
# ---------------------------------------------------------------------------
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)


def parse_frontmatter(content: str) -> Dict[str, str]:
    """Parse a minimal YAML frontmatter block (``key: value`` lines) to a dict.

    Deterministic and dependency-free — only the flat ``key: value`` subset OKF
    v0.1 needs (specs/04 §9). Returns {} when there is no frontmatter block.
    """
    m = _FRONTMATTER_RE.match(content or "")
    if not m:
        return {}
    out: Dict[str, str] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        out[key.strip()] = value.strip().strip("'\"")
    return out


@dataclass
class RuleFact:
    """One asserted key=value drawn from an existing rule file (for contradiction
    detection)."""

    key: str
    value: str
    source: str


class RuleSet:
    """The existing governed facts a write is validated against.

    Built from the vault's ``policies/`` and ``rules/`` markdown frontmatter. A
    new write that asserts a *different* value for a key an existing rule file
    already fixes is a contradiction and is rejected (ADR-014).
    """

    def __init__(self, facts: Optional[Iterable[RuleFact]] = None) -> None:
        # key -> RuleFact (first writer wins; the vault is authoritative).
        self.facts: Dict[str, RuleFact] = {}
        for f in facts or []:
            self.facts.setdefault(f.key, f)

    @classmethod
    def from_vault(cls, vault: str, subdirs: Tuple[str, ...] = ("policies", "rules")) -> "RuleSet":
        facts: List[RuleFact] = []
        for sub in subdirs:
            d = os.path.join(vault, sub)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                if not name.endswith(".md"):
                    continue
                path = os.path.join(d, name)
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        fm = parse_frontmatter(fh.read())
                except OSError:
                    continue
                rel = os.path.join(sub, name)
                for k, v in fm.items():
                    if k in ("type", "title", "description", "tags", "timestamp", "resource"):
                        continue  # OKF metadata, not a governed assertion
                    facts.append(RuleFact(key=k, value=v, source=rel))
        return cls(facts)

    def contradiction(self, path: str, frontmatter: Mapping[str, str]) -> Optional[str]:
        """Return a reason string if ``frontmatter`` contradicts a known rule."""
        rel = _relpath(path)
        for k, v in frontmatter.items():
            if k in ("type", "title", "description", "tags", "timestamp", "resource"):
                continue
            existing = self.facts.get(k)
            if existing is None:
                continue
            # A file may restate its own value; a *different* file asserting a
            # *different* value is the contradiction.
            if existing.source != rel and str(existing.value) != str(v):
                return (
                    f"contradicts rule '{existing.source}': it fixes "
                    f"{k}={existing.value!r}, this write asserts {k}={v!r}"
                )
        return None


def _relpath(path: str) -> str:
    """Best-effort vault-relative path for messages (keeps last two segments)."""
    parts = os.path.normpath(path).split(os.sep)
    return os.path.join(*parts[-2:]) if len(parts) >= 2 else path


# Required OKF frontmatter (specs/04 §9): every bundle file declares a `type`.
REQUIRED_FRONTMATTER_KEYS = ("type",)


def validate_write(
    path: str,
    content: str,
    rules: Optional[Any] = None,
) -> Dict[str, Any]:
    """Dry-run a vault write against the rule schema BEFORE it persists.

    Returns ``{"ok": bool, "reason": str}``. The write is REJECTED (ok=False)
    — fails closed — when:

      1. required OKF frontmatter is missing (no ``type``);
      2. a ``policies/*`` write carries no ``max_`` guardrail key (a governance
         policy must bound something — that is what makes it enforceable);
      3. it contradicts a value an existing rule file already fixes (ADR-014).

    ``rules`` may be a ``RuleSet``, an iterable of ``RuleFact``, or None. A clean
    write returns ``{"ok": True, "reason": "validated"}``.
    """
    if not path or not str(path).strip():
        return {"ok": False, "reason": "empty write path — rejected"}
    if content is None or not str(content).strip():
        return {"ok": False, "reason": "empty content — rejected"}

    fm = parse_frontmatter(content)

    # (1) required frontmatter.
    for key in REQUIRED_FRONTMATTER_KEYS:
        if key not in fm or not fm[key]:
            return {
                "ok": False,
                "reason": (
                    f"missing required frontmatter '{key}' (OKF v0.1) — "
                    f"rejected before persisting"
                ),
            }

    # (2) policies must carry a max_ guardrail.
    norm = _relpath(path).replace(os.sep, "/")
    if "policies/" in norm or norm.startswith("policies"):
        if not any(k.startswith("max_") for k in fm):
            return {
                "ok": False,
                "reason": (
                    "policy write carries no 'max_' guardrail key — a policy "
                    "must bound something to be enforceable; rejected"
                ),
            }

    # (3) contradiction with existing rule files.
    ruleset = rules if isinstance(rules, RuleSet) else RuleSet(rules)
    reason = ruleset.contradiction(path, fm)
    if reason:
        return {"ok": False, "reason": reason}

    return {"ok": True, "reason": "validated"}


# ---------------------------------------------------------------------------
# Token-budget management.
# ---------------------------------------------------------------------------
def select_context(items: Iterable[MemoryItem], budget: int) -> List[MemoryItem]:
    """Pick the highest-value memory items that fit a fixed token budget.

    Never injects the whole vault: items are ranked by value density
    (priority per token, then priority, then smaller-first) and greedily packed
    until the next item would exceed ``budget``. The returned selection's total
    token cost is **guaranteed** ``<= budget`` (specs/03 Layer 1 acceptance).
    """
    budget = max(0, int(budget))
    ranked = sorted(
        (i for i in items if i.tokens > 0),
        key=lambda i: (-(i.priority / i.tokens), -i.priority, i.tokens, i.id),
    )
    chosen: List[MemoryItem] = []
    spent = 0
    for item in ranked:
        if spent + item.tokens <= budget:
            chosen.append(item)
            spent += item.tokens
    return chosen


def injected_tokens(items: Iterable[MemoryItem]) -> int:
    return sum(i.tokens for i in items)


# ---------------------------------------------------------------------------
# The store — assembles the three tiers.
# ---------------------------------------------------------------------------
@dataclass
class VaultWrite:
    """A markdown write the loop wants to persist to the vault (passes the gate
    before it lands)."""

    path: str  # vault-relative
    content: str


class MemoryStore:
    """Three-tier memory: L1 profile (static), L2 working (session isolated),
    L3 vault (markdown on disk).

    ``candidates(session_id, intent)`` assembles injectable items from all three
    tiers so the loop can pack them under budget. Working-memory namespaces are
    created on demand and never shared across sessions.
    """

    def __init__(
        self,
        profile: Optional[Mapping[str, Any]] = None,
        vault: Optional[str] = None,
    ) -> None:
        self.profile: Dict[str, Any] = dict(profile or {})
        self.vault = vault
        self._working: Dict[str, WorkingMemory] = {}

    # -- L2 : session-isolated working memory ------------------------------
    def working(self, session_id: str) -> WorkingMemory:
        """Return the working-memory namespace for ``session_id`` (created once).

        Distinct session ids get distinct, non-overlapping namespaces — the
        isolation guarantee.
        """
        wm = self._working.get(session_id)
        if wm is None:
            wm = WorkingMemory(session_id)
            self._working[session_id] = wm
        return wm

    def has_session(self, session_id: str) -> bool:
        return session_id in self._working

    def drop_session(self, session_id: str) -> None:
        """Forget a task's working memory (per-task lifetime)."""
        self._working.pop(session_id, None)

    # -- L1 : profile ------------------------------------------------------
    def profile_items(self) -> List[MemoryItem]:
        """Static profile facts, highest priority (they define the user)."""
        out: List[MemoryItem] = []
        for k, v in self.profile.items():
            out.append(
                MemoryItem(
                    id=f"L1:{k}",
                    tier=L1,
                    content=f"{k}: {v}",
                    priority=3.0,
                    source="profile",
                )
            )
        return out

    # -- L3 : vault --------------------------------------------------------
    def vault_items(self, intent: str, limit: int = 12) -> List[MemoryItem]:
        """Relevant vault pages as candidates, scored by lexical overlap.

        Ranked by Okapi BM25 over the WHOLE document, with a TF-IDF rerank —
        the cascade that has lived in ``retrieval.py`` since it was written and
        was constructed only in tests.

        This used to read the first 400 bytes of each page and score keyword
        overlap against its title and first line. Everything past that window
        was invisible: a decision recorded in a note's third paragraph could
        not be recalled no matter how exactly the task named it. Precision in
        retrieval is what makes cost fall, and a 400-byte skim is not
        retrieval.

        Bounded, because this runs ahead of every turn: the index build is
        capped, and ANY failure degrades to the old keyword scan rather than
        failing the run. A slower correct answer is worth having; a run that
        dies because a vault grew is not.
        """
        if not self.vault or not os.path.isdir(self.vault):
            return []
        ranked = self._bm25_items(intent, limit)
        if ranked is not None:
            return ranked
        return self._keyword_items(intent, limit)

    def _bm25_items(self, intent: str, limit: int) -> Optional[List[MemoryItem]]:
        """Full-text recall, or None to fall back to the keyword scan."""
        try:
            from .retrieval import RetrievalIndex, _parse_vault

            docs = [
                d
                for d in _parse_vault(self.vault)
                if not _is_machine_written(getattr(d, "relpath", "") or getattr(d, "id", ""))
            ]
            if not docs or len(docs) > MAX_INDEXED_DOCS:
                return None
            index = RetrievalIndex(docs)
            hits = index.bm25(intent, k=max(limit * 4, 20))
            if not hits:
                return []
            reranked = index.rerank(intent, [h.doc_id for h in hits], k=limit) or hits[:limit]
        except Exception:
            # Never fatal ahead of a turn — degrade to the cheap scan.
            return None

        out: List[MemoryItem] = []
        for rank, hit in enumerate(reranked[:limit]):
            rel = str(hit.doc_id)
            out.append(
                MemoryItem(
                    id=f"L3:{rel}",
                    tier=L3,
                    content=f"[{rel}] {getattr(hit, 'title', '') or rel}",
                    priority=1.0 + float(len(reranked) - rank),
                    source=rel,
                )
            )
        return out

    def _keyword_items(self, intent: str, limit: int = 12) -> List[MemoryItem]:
        """The original cheap scan — the fallback when indexing is unavailable
        or the vault is too large to index ahead of every turn."""
        if not self.vault or not os.path.isdir(self.vault):
            return []
        terms = _terms(intent)
        scored: List[Tuple[float, MemoryItem]] = []
        for root, _dirs, files in os.walk(self.vault):
            # Skip machine-written trees (verdicts / spans / tmp).
            base = os.path.basename(root)
            if base in ("verdicts",) or base.startswith("."):
                continue
            for name in files:
                if not name.endswith(".md"):
                    continue
                path = os.path.join(root, name)
                rel = os.path.relpath(path, self.vault)
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        head = fh.read(400)
                except (OSError, UnicodeDecodeError, ValueError):
                    # A single undecodable file must never kill recall — this
                    # runs ahead of every turn. `.md` is a convention, not a
                    # guarantee; a binary file with that suffix used to raise
                    # UnicodeDecodeError straight out of the scan.
                    continue
                fm = parse_frontmatter(head)
                title = fm.get("title", name[:-3])
                overlap = len(terms & _terms(f"{rel} {title} {head}"))
                if overlap == 0:
                    continue
                item = MemoryItem(
                    id=f"L3:{rel}",
                    tier=L3,
                    content=f"[{rel}] {title}",
                    priority=1.0 + float(overlap),
                    source=rel,
                )
                scored.append((float(overlap), item))
        scored.sort(key=lambda t: (-t[0], t[1].id))
        return [it for _s, it in scored[:limit]]

    # -- assembly ----------------------------------------------------------
    def candidates(self, session_id: Optional[str], intent: str) -> List[MemoryItem]:
        """All injectable candidates across the three tiers for one task."""
        items: List[MemoryItem] = list(self.profile_items())
        if session_id and self.has_session(session_id):
            items.extend(self.working(session_id).items())
        items.extend(self.vault_items(intent))
        return items


def _terms(text: str) -> set:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))
