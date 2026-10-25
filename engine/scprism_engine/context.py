"""Context routing & compression — Harness Layer 6 (specs/03, ADR-016).

"The layer nobody admits matters": the overnight loop burns tokens
catastrophically without it. Three deterministic, offline-safe capabilities
(model routing is NOT here — it already lives in the gateway; this module
references it, never duplicates it):

  * **Progressive disclosure** — ``disclose(task, catalog)``. An agent sees rule
    / skill *names* at startup and loads a skill's full instructions ONLY when a
    task matches its triggers. One agent carries dozens of skills and pays for
    the one in use (specs/03 Layer 6 acceptance: full instructions absent from
    context until the matching task runs).
  * **Compression triggers** — ``compress(history, trigger)``. Trim old tool
    outputs, summarise long history, dedupe repeated context — fired at three
    points: after N turns, at ~80% of the window, at an explicit checkpoint.
    ``check_trigger`` decides *when*; ``compress`` does the *what*.
  * **Query reformulation** — ``reformulate(intent, vault_structure)``. Before
    retrieval, rewrite raw intent into a query bound to the vault's structure
    (entity names, section conventions) so the retriever isn't drowned in noise
    (specs/04 §4). Rule-based and deterministic; a gateway hook is optional.

**Cache-boundary hard constraint (ADR-016):** compression must never reorder or
mutate cached/stable content mid-task — that would force a full recompute and
erase the prompt-cache saving. ``compress`` takes ``stable_prefix`` and only
ever touches the live tail after it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .memory import est_tokens

# ---------------------------------------------------------------------------
# 1. Progressive disclosure.
# ---------------------------------------------------------------------------


@dataclass
class CatalogEntry:
    """One skill/rule the agent knows the NAME of at startup.

    ``instructions`` (the heavy body) is loaded into context only when a task
    matches ``triggers`` — that is the whole point of progressive disclosure.
    """

    name: str
    triggers: List[str] = field(default_factory=list)
    instructions: str = ""
    summary: str = ""
    # Roles this skill is scoped to (P3-1). EMPTY = GLOBAL (reaches every role,
    # exactly as before this field existed). A non-empty list restricts the
    # skill to those roles when ``disclose`` is asked for a specific role.
    roles: List[str] = field(default_factory=list)
    # Tier 3 of progressive disclosure (Agent Skills): a folder skill's bundled
    # ``references/*.md``, as relpath -> CONTENT. Read eagerly at load time
    # under the same symlink/containment/size guards as the skill file itself —
    # storing paths and opening them later would reopen the TOCTOU those guards
    # exist to close. Empty for a flat skill. Kept OUT of ``instructions`` so it
    # costs nothing until the body actually cites it.
    resources: Dict[str, str] = field(default_factory=dict)
    # The skill's own `allowed-tools` declaration (Agent Skills, experimental),
    # already reduced to capability names this engine can enforce. None = the
    # skill said nothing we understand, which must leave the grant ALONE. It can
    # only ever NARROW: see capabilities.skill_narrowing for the hard rule.
    allowed_tools: Optional[frozenset] = None
    #: The declaration exactly as the file wrote it — for the span and the UI,
    #: attributed to the file. Never quoted back to the model.
    allowed_tools_raw: str = ""

    def matches(self, task_terms: set) -> bool:
        for trig in self.triggers:
            t = trig.lower().strip()
            if not t:
                continue
            # Multi-word trigger: all its words must be present. Single word:
            # direct membership.
            words = set(re.findall(r"[a-z0-9]+", t))
            if words and words <= task_terms:
                return True
        return False

    def allows_role(self, role: str) -> bool:
        """Role filter, layered ON TOP of ``matches`` (P3-1).

        ``role=""`` disables the filter — every entry is allowed (today's
        behavior). Otherwise a GLOBAL entry (no ``roles``) is allowed for any
        role, and a role-tagged entry is allowed only when ``role`` is one of
        its ``roles`` (case-insensitive). Never touches trigger matching.
        """
        if not role:
            return True
        if not self.roles:
            return True
        r = role.strip().lower()
        return any(r == x.strip().lower() for x in self.roles)


@dataclass
class DisclosedSkill:
    """A skill whose full instructions were loaded for a matching task."""

    name: str
    instructions: str
    tokens: int
    matched_on: str = ""
    # Carried through from CatalogEntry so the prompt builder can expand a
    # cited reference without going back to disk (and without I/O in what is
    # deliberately a pure function). Defaulted, so every existing construction
    # site still builds.
    resources: Dict[str, str] = field(default_factory=dict)
    # The skill's own `allowed-tools` declaration, carried so the capability
    # gate can narrow this turn to what the LANDED skills permit. None = the
    # skill declared nothing this engine understands, which must leave the
    # grant alone. It can only ever subtract; see capabilities.skill_narrowing.
    allowed_tools: Optional[frozenset] = None
    allowed_tools_raw: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "tokens": self.tokens, "matched_on": self.matched_on}


def catalog_names(catalog: Iterable[CatalogEntry]) -> List[str]:
    """The startup view: names only, no instruction bodies loaded."""
    return [e.name for e in catalog]


def disclose(
    task: str, catalog: Sequence[CatalogEntry], role: str = ""
) -> List[DisclosedSkill]:
    """Load full instructions ONLY for catalog entries the task matches.

    Non-matching entries contribute zero instruction tokens to context — their
    bodies are never loaded. Returns the disclosed skills (possibly empty).

    ``role`` (P3-1) is an ADDITIONAL filter on top of trigger matching: with the
    default ``role=""`` every trigger match discloses (today's behavior); with a
    role given, an entry discloses only if it is GLOBAL (no ``roles``) or lists
    that role (case-insensitive). Trigger matching is unchanged either way.
    """
    terms = _terms(task)
    out: List[DisclosedSkill] = []
    for entry in catalog:
        if not entry.allows_role(role):
            continue
        if entry.matches(terms):
            matched = next(
                (
                    trig
                    for trig in entry.triggers
                    if set(re.findall(r"[a-z0-9]+", trig.lower())) <= terms
                ),
                "",
            )
            out.append(
                DisclosedSkill(
                    name=entry.name,
                    instructions=entry.instructions,
                    tokens=est_tokens(entry.instructions),
                    matched_on=matched,
                    # Tier 3 travels with the skill so the prompt builder can
                    # expand a cited reference without doing I/O.
                    resources=dict(entry.resources),
                    allowed_tools=entry.allowed_tools,
                    allowed_tools_raw=getattr(entry, "allowed_tools_raw", ""),
                )
            )
    return out


# ---------------------------------------------------------------------------
# 2. Compression triggers.
# ---------------------------------------------------------------------------
TRIGGER_TURNS = "turns"          # after N turns
TRIGGER_WINDOW = "window"        # ~80% of the context window
TRIGGER_CHECKPOINT = "checkpoint"  # explicit checkpoint

TRIGGERS = (TRIGGER_TURNS, TRIGGER_WINDOW, TRIGGER_CHECKPOINT)


@dataclass
class CompressionPolicy:
    """When compression fires (specs/03 Layer 6): after N turns, at ~fraction of
    the window, or at an explicit checkpoint."""

    n_turns: int = 8
    window_tokens: int = 100_000
    window_fraction: float = 0.8
    keep_recent: int = 3  # tool outputs newer than this are never trimmed

    def check_trigger(
        self,
        history: Sequence[Dict[str, Any]],
        *,
        checkpoint: bool = False,
    ) -> Optional[str]:
        """Return which trigger fires for ``history`` now, else None.

        Checkpoint wins (explicit intent), then window pressure (~80%), then the
        turn count. Deterministic.
        """
        if checkpoint:
            return TRIGGER_CHECKPOINT
        total = history_tokens(history)
        if total >= self.window_tokens * self.window_fraction:
            return TRIGGER_WINDOW
        if len(history) >= self.n_turns:
            return TRIGGER_TURNS
        return None


@dataclass
class Compacted:
    """Result of a compression pass — carries the audit of what fired."""

    entries: List[Dict[str, Any]]
    trigger: str
    ops: List[str] = field(default_factory=list)
    tokens_before: int = 0
    tokens_after: int = 0
    stable_prefix: int = 0

    @property
    def saved(self) -> int:
        return max(0, self.tokens_before - self.tokens_after)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trigger": self.trigger,
            "ops": list(self.ops),
            "tokens_before": self.tokens_before,
            "tokens_after": self.tokens_after,
            "saved": self.saved,
            "stable_prefix": self.stable_prefix,
        }


def history_tokens(history: Iterable[Dict[str, Any]]) -> int:
    return sum(est_tokens(str(e.get("content", ""))) for e in history)


def compress(
    history: Sequence[Dict[str, Any]],
    trigger: str,
    *,
    policy: Optional[CompressionPolicy] = None,
    stable_prefix: int = 0,
) -> Compacted:
    """Compact conversation ``history`` for the given ``trigger``.

    Three operations, applied to the LIVE TAIL only:
      * **trim** old tool outputs (replace bodies older than ``keep_recent`` with
        a short stub — the fact that a tool ran is kept, its bulk is dropped);
      * **dedupe** repeated identical context (keep first occurrence);
      * **summarise** a long history (collapse the trimmed middle into one
        summary line) — heaviest, reserved for window/checkpoint pressure.

    **Cache boundary (ADR-016):** the first ``stable_prefix`` entries (system
    prompt, rule files, vault context — the cached prefix) are copied through
    byte-for-byte and never reordered or mutated. Compression touches only the
    tail after them, so the prompt cache is not broken mid-task.

    ``tokens_after <= tokens_before`` always holds.
    """
    if trigger not in TRIGGERS:
        raise ValueError(f"unknown compression trigger {trigger!r} (want {TRIGGERS})")
    policy = policy or CompressionPolicy()

    entries = [dict(e) for e in history]
    before = history_tokens(entries)
    stable_prefix = max(0, min(stable_prefix, len(entries)))

    prefix = entries[:stable_prefix]         # cached — untouched
    tail = entries[stable_prefix:]           # live — compressible
    ops: List[str] = []

    # (a) dedupe repeated context (by role+content), keep first occurrence.
    seen = set()
    deduped: List[Dict[str, Any]] = []
    removed = 0
    for e in tail:
        sig = (e.get("role"), str(e.get("content", "")))
        if sig in seen:
            removed += 1
            continue
        seen.add(sig)
        deduped.append(e)
    if removed:
        ops.append(f"dedupe:-{removed}")
    tail = deduped

    # (b) trim old tool outputs (keep the most recent `keep_recent`).
    tool_idxs = [i for i, e in enumerate(tail) if e.get("kind") == "tool_output"]
    trim_before = set(tool_idxs[: max(0, len(tool_idxs) - policy.keep_recent)])
    trimmed = 0
    for i in trim_before:
        body = str(tail[i].get("content", ""))
        if len(body) > 0:
            tail[i] = {
                **tail[i],
                "content": f"[trimmed tool output ~{est_tokens(body)} tok]",
                "trimmed": True,
            }
            trimmed += 1
    if trimmed:
        ops.append(f"trim:{trimmed}")

    # (c) summarise a long history at window / checkpoint pressure: collapse the
    #     trimmed middle (everything except the last keep_recent tail entries)
    #     into a single summary line.
    if trigger in (TRIGGER_WINDOW, TRIGGER_CHECKPOINT) and len(tail) > policy.keep_recent + 1:
        head = tail[: len(tail) - policy.keep_recent]
        keep = tail[len(tail) - policy.keep_recent :]
        summary = {
            "role": "system",
            "kind": "summary",
            "content": f"[summary of {len(head)} earlier turns; "
            f"~{history_tokens(head)} tok compacted]",
        }
        # Only adopt the summary if it is actually smaller.
        if est_tokens(summary["content"]) < history_tokens(head):
            tail = [summary] + keep
            ops.append(f"summarise:{len(head)}->1")

    out_entries = prefix + tail
    after = history_tokens(out_entries)

    # Invariant guard: never grow. If a pass somehow inflated tokens, fall back
    # to the original (compression must not cost tokens).
    if after > before:
        out_entries = entries
        after = before
        ops.append("noop:guard")

    return Compacted(
        entries=out_entries,
        trigger=trigger,
        ops=ops,
        tokens_before=before,
        tokens_after=after,
        stable_prefix=stable_prefix,
    )


# ---------------------------------------------------------------------------
# 3. Query reformulation.
# ---------------------------------------------------------------------------
_STOPWORDS = {
    "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "is", "are",
    "please", "can", "you", "i", "we", "it", "that", "this", "with", "how",
    "what", "where", "do", "does", "my", "our", "me", "add", "make", "get",
}


@dataclass
class VaultStructure:
    """The vault's shape the reformulator binds a query to: known entity names
    (page/dir names) and section conventions."""

    entities: List[str] = field(default_factory=list)
    sections: List[str] = field(default_factory=list)

    @classmethod
    def from_vault(cls, vault: str) -> "VaultStructure":
        import os

        entities: List[str] = []
        sections: List[str] = []
        if vault and os.path.isdir(vault):
            for root, dirs, files in os.walk(vault):
                base = os.path.basename(root)
                if base in ("verdicts",) or base.startswith("."):
                    dirs[:] = []
                    continue
                for d in dirs:
                    if not d.startswith("."):
                        sections.append(d)
                for name in files:
                    if name.endswith(".md"):
                        entities.append(name[:-3])
        return cls(entities=sorted(set(entities)), sections=sorted(set(sections)))


@dataclass
class ReformulatedQuery:
    """A structure-bound retrieval query (deterministic rewrite of raw intent)."""

    raw: str
    terms: List[str]
    entities: List[str] = field(default_factory=list)
    sections: List[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        parts = list(self.terms)
        for e in self.entities:
            parts.append(f"entity:{e}")
        for s in self.sections:
            parts.append(f"section:{s}")
        return " ".join(parts)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "raw": self.raw,
            "terms": list(self.terms),
            "entities": list(self.entities),
            "sections": list(self.sections),
            "text": self.text,
        }


def reformulate(
    intent: str,
    vault_structure: Optional[VaultStructure] = None,
    *,
    gateway: Optional[Any] = None,
) -> ReformulatedQuery:
    """Rewrite raw ``intent`` into a query bound to the vault's structure.

    Deterministic rule-based rewrite (specs/04 §4): drop stopwords/filler, then
    BIND matched terms to concrete vault entities and section names so the
    retriever searches the structure, not free text. ``gateway`` is accepted for
    parity with the spec (a small fast model could rewrite) but the offline
    deterministic path is always available and is used when no gateway is given.
    """
    vs = vault_structure or VaultStructure()
    raw = (intent or "").strip()
    tokens = [t for t in re.findall(r"[a-z0-9\-]+", raw.lower()) if t not in _STOPWORDS]
    terms = _dedupe_keep_order(tokens)

    # Bind to structure on SPLIT alphanumeric words so a hyphenated intent term
    # ("retry-policy") still matches a hyphenated entity ("retry-policy") whose
    # words are {retry, policy}.
    raw_terms = _terms(raw)
    entities = [e for e in vs.entities if raw_terms & _terms(e)]
    sections = [s for s in vs.sections if raw_terms & _terms(s)]

    # Optional gateway-assisted rewrite (offline-safe: falls back to the
    # deterministic terms on any failure). Kept behind an explicit gateway arg.
    if gateway is not None:
        try:  # pragma: no cover - exercised only when a gateway is injected
            decision = gateway.route(raw)
            res = gateway.model_call(
                [{"role": "user", "content": f"Reformulate for retrieval: {raw}"}],
                decision,
            )
            extra = [t for t in re.findall(r"[a-z0-9\-]+", res.text.lower())
                     if t not in _STOPWORDS and len(t) > 2]
            terms = _dedupe_keep_order(terms + extra)[: max(8, len(terms))]
        except Exception:
            pass

    return ReformulatedQuery(
        raw=raw,
        terms=terms,
        entities=_dedupe_keep_order(entities),
        sections=_dedupe_keep_order(sections),
    )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _terms(text: str) -> set:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _dedupe_keep_order(items: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for x in items:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out
