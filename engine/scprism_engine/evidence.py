"""Evidence & Control layer — the audit spine (specs/05 §3).

The whole SC Prism pitch is *provably governed*. This module is that proof: an
**append-only, immutable, hash-chained** audit store. For every governed action
it records, immutably:

  * **who**  — the agent's distinct identity + the requester's role.
  * **what** — the action taken and its diff/artifacts.
  * **why**  — the task intent.
  * the **Verdict** — Tier-1 + Tier-2 results (pass/fail, score, envelope).
  * **tokens** spent, the **model route**, the **hooks fired**, and a timestamp.

The core invariant (specs/05 §3): this is the SAME Verdict object the loop emits
— governance is a *read* of execution truth, not a parallel system that can
drift from it. ``EvidenceStore.append_verdict`` derives every field of the
record from a real ``Verdict`` (plus who/why context), so evidence can never
disagree with what actually ran.

Properties enforced here:

  * **Append-only / immutable.** Records are only ever appended to
    ``<vault>/evidence/audit.jsonl``; nothing is edited in place.
  * **Tamper-evident.** Each record carries the previous record's hash
    (``prev_hash``) and its own ``record_hash`` = sha256(prev_hash + canonical
    content). Mutating ANY field of ANY past record breaks the chain, which
    ``verify_chain()`` detects and localizes.
  * **Reconstructable.** ``reconstruct(task_id)`` replays a decision end-to-end
    from evidence (and, when available, the run's spans).
  * **Exportable.** ``export(start, end)`` generates a compliance artifact for
    an arbitrary date range with no bespoke work.

Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import hashlib
import json
import os
import contextlib
import fcntl
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Genesis link for the first record in a fresh chain.
GENESIS_HASH = "0" * 64

# Canonical relative location of the audit log inside a vault.
AUDIT_RELPATH = os.path.join("evidence", "audit.jsonl")


class EvidenceError(ValueError):
    """Raised on a malformed evidence record or store."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical(payload: Dict[str, Any]) -> str:
    """Deterministic JSON serialization used for hashing.

    ``record_hash`` is never part of the hashed content, so it is stripped
    before canonicalization. Everything else — including ``prev_hash`` — is
    covered, so tampering with the link itself is also detectable.
    """
    content = {k: v for k, v in payload.items() if k != "record_hash"}
    return json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _hash_record(payload: Dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


@dataclass
class EvidenceRecord:
    """One immutable audit entry (who / what / why / verdict / cost / chain)."""

    seq: int
    timestamp: str
    task_id: str
    # who: agent identity + requester role (specs/05 §1 + §3).
    who: Dict[str, Any]
    # what: the action + diff/artifacts.
    what: Dict[str, Any]
    # why: the task intent.
    why: str
    # the Verdict — Tier-1 + Tier-2 truth (the audit spine).
    verdict: Dict[str, Any]
    tokens_spent: int
    model_route: List[str]
    hooks_fired: List[str]
    # governance detail carried straight from the Verdict.
    hook_decisions: List[Dict[str, Any]] = field(default_factory=list)
    blocks: List[Dict[str, Any]] = field(default_factory=list)
    approvals: List[Dict[str, Any]] = field(default_factory=list)
    cache: Dict[str, int] = field(default_factory=dict)
    passed: bool = False
    spans_path: str = ""
    prev_hash: str = GENESIS_HASH
    record_hash: str = ""

    def content(self) -> Dict[str, Any]:
        """The dict that gets hashed + persisted (record_hash filled last)."""
        return {
            "seq": self.seq,
            "timestamp": self.timestamp,
            "task_id": self.task_id,
            "who": self.who,
            "what": self.what,
            "why": self.why,
            "verdict": self.verdict,
            "tokens_spent": self.tokens_spent,
            "model_route": self.model_route,
            "hooks_fired": self.hooks_fired,
            "hook_decisions": self.hook_decisions,
            "blocks": self.blocks,
            "approvals": self.approvals,
            "cache": self.cache,
            "passed": self.passed,
            "spans_path": self.spans_path,
            "prev_hash": self.prev_hash,
        }

    def to_dict(self) -> Dict[str, Any]:
        d = self.content()
        d["record_hash"] = self.record_hash
        return d

    def seal(self) -> "EvidenceRecord":
        """Compute and set ``record_hash`` over the current content."""
        self.record_hash = _hash_record(self.content())
        return self

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "EvidenceRecord":
        return cls(
            seq=int(d["seq"]),
            timestamp=str(d["timestamp"]),
            task_id=str(d["task_id"]),
            who=dict(d.get("who", {})),
            what=dict(d.get("what", {})),
            why=str(d.get("why", "")),
            verdict=dict(d.get("verdict", {})),
            tokens_spent=int(d.get("tokens_spent", 0)),
            model_route=list(d.get("model_route", [])),
            hooks_fired=list(d.get("hooks_fired", [])),
            hook_decisions=list(d.get("hook_decisions", [])),
            blocks=list(d.get("blocks", [])),
            approvals=list(d.get("approvals", [])),
            cache=dict(d.get("cache", {})),
            passed=bool(d.get("passed", False)),
            spans_path=str(d.get("spans_path", "")),
            prev_hash=str(d.get("prev_hash", GENESIS_HASH)),
            record_hash=str(d.get("record_hash", "")),
        )


@dataclass
class ChainReport:
    """Outcome of ``verify_chain`` — is the audit trail intact?"""

    ok: bool
    length: int
    broken_at: Optional[int] = None  # seq of the first broken record
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "length": self.length,
            "broken_at": self.broken_at,
            "reason": self.reason,
        }


class EvidenceStore:
    """Append-only, hash-chained audit store rooted at a vault.

    The log lives at ``<vault>/evidence/audit.jsonl``. Appends are lock-guarded
    (thread-safe) and each derives ``prev_hash`` from the current chain tail, so
    concurrent governed actions cannot fork the chain. Nothing is ever mutated.
    """

    def __init__(self, vault: str, *, path: Optional[str] = None) -> None:
        self.vault = vault
        self.path = path or os.path.join(vault, AUDIT_RELPATH)
        self._lock = threading.Lock()
        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        os.makedirs(directory, exist_ok=True)

    # -- reading --------------------------------------------------------

    def _read_raw(self) -> List[Dict[str, Any]]:
        if not os.path.exists(self.path):
            return []
        out: List[Dict[str, Any]] = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def records(self) -> List[EvidenceRecord]:
        """All records in append order."""
        return [EvidenceRecord.from_dict(d) for d in self._read_raw()]

    def _tail_hash(self, raw: Optional[List[Dict[str, Any]]] = None) -> str:
        raw = self._read_raw() if raw is None else raw
        if not raw:
            return GENESIS_HASH
        return str(raw[-1].get("record_hash", GENESIS_HASH))

    # -- appending ------------------------------------------------------

    @contextlib.contextmanager
    def _ledger_handle(self):
        """The ledger open for append, held under an exclusive OS lock for the
        whole read→seal→append section. A filesystem without flock still gets
        the in-process lock (degraded, never broken)."""
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        fh = open(self.path, "a", encoding="utf-8")
        try:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            except (OSError, AttributeError):
                pass
            yield fh
        finally:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except (OSError, AttributeError):
                pass
            fh.close()

    def append(
        self,
        *,
        task_id: str,
        who: Dict[str, Any],
        what: Dict[str, Any],
        why: str,
        verdict: Dict[str, Any],
        tokens_spent: int,
        model_route: List[str],
        hooks_fired: List[str],
        hook_decisions: Optional[List[Dict[str, Any]]] = None,
        blocks: Optional[List[Dict[str, Any]]] = None,
        approvals: Optional[List[Dict[str, Any]]] = None,
        cache: Optional[Dict[str, int]] = None,
        passed: bool = False,
        spans_path: str = "",
        timestamp: Optional[str] = None,
    ) -> EvidenceRecord:
        """Append one immutable, hash-chained record and return it."""
        # INTER-PROCESS lock, not just a thread lock. Concurrent runs are
        # separate PROCESSES, and threading.Lock does not span processes — two
        # runs both read seq=N, both sealed it, and both appended, forking the
        # hash chain. Found by verifying the real ledger (2026-08-31): seq 142
        # appears twice, written 1.4ms apart, and the link across it does not
        # verify. The whole read→seal→append section is now exclusive, so a
        # second writer waits and chains onto the first.
        with self._lock, self._ledger_handle() as fh:
            raw = self._read_raw()
            seq = len(raw)
            prev_hash = self._tail_hash(raw)
            rec = EvidenceRecord(
                seq=seq,
                timestamp=timestamp or _now_iso(),
                task_id=str(task_id),
                who=dict(who),
                what=dict(what),
                why=str(why),
                verdict=dict(verdict),
                tokens_spent=int(tokens_spent),
                model_route=list(model_route),
                hooks_fired=list(hooks_fired),
                hook_decisions=list(hook_decisions or []),
                blocks=list(blocks or []),
                approvals=list(approvals or []),
                cache=dict(cache or {}),
                passed=bool(passed),
                spans_path=str(spans_path),
                prev_hash=prev_hash,
            ).seal()
            line = json.dumps(rec.to_dict(), ensure_ascii=False)
            fh.write(line + "\n")
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass  # durability is best-effort; the lock is the contract
            return rec

    def append_verdict(
        self,
        verdict: Any,
        *,
        agent_id: str = "orchestrator",
        role: str = "",
        requester_role: str = "",
        intent: str = "",
        diff: Optional[Dict[str, Any]] = None,
    ) -> EvidenceRecord:
        """Derive an evidence record straight from a real ``Verdict``.

        This is the invariant made concrete: the Verdict IS the audit record, so
        governance cannot drift from execution truth. ``diff`` optionally carries
        the concrete change set (paths written, before/after) alongside the
        artifacts the Verdict already lists.
        """
        v = verdict
        tier1 = dict(getattr(v, "tier1", {}) or {})
        tier2 = dict(getattr(v, "tier2", {}) or {})
        who = {
            "agent_id": agent_id,
            "role": role,
            "requester_role": requester_role,
        }
        what = {
            "action": "orchestrated_task",
            "artifacts": list(getattr(v, "artifacts", []) or []),
            "diff": dict(diff or {}),
            "rejected_writes": list(getattr(v, "rejected_writes", []) or []),
        }
        verdict_summary = {
            "passed": bool(getattr(v, "passed", False)),
            "tier1": tier1,
            "tier2": tier2,
        }
        cache = {
            "hits": int(getattr(v, "cache_hits", 0)),
            "misses": int(getattr(v, "cache_misses", 0)),
        }
        return self.append(
            task_id=str(getattr(v, "task_id", "")),
            who=who,
            what=what,
            why=intent or "",
            verdict=verdict_summary,
            tokens_spent=int(getattr(v, "tokens_spent", 0)),
            model_route=list(getattr(v, "model_route", []) or []),
            hooks_fired=list(getattr(v, "hooks_fired", []) or []),
            hook_decisions=list(getattr(v, "hook_decisions", []) or []),
            blocks=list(getattr(v, "blocks", []) or []),
            approvals=list(getattr(v, "approvals", []) or []),
            cache=cache,
            passed=bool(getattr(v, "passed", False)),
            spans_path=str(getattr(v, "spans_path", "")),
            timestamp=str(getattr(v, "timestamp", "")) or None,
        )

    # -- integrity ------------------------------------------------------

    def verify_chain(self) -> ChainReport:
        """Recompute the hash chain end-to-end; localize any tampering.

        Detects: a mutated field (record_hash no longer matches content), a
        broken link (prev_hash != the actual previous record's hash), and an
        out-of-order / renumbered seq. Any of these fails the audit.
        """
        raw = self._read_raw()
        prev_hash = GENESIS_HASH
        for i, d in enumerate(raw):
            rec = EvidenceRecord.from_dict(d)
            # (a) seq must be dense + monotonic.
            if rec.seq != i:
                return ChainReport(
                    ok=False, length=len(raw), broken_at=i,
                    reason=f"seq mismatch: record #{i} claims seq={rec.seq}",
                )
            # (b) link must point at the real predecessor.
            if rec.prev_hash != prev_hash:
                return ChainReport(
                    ok=False, length=len(raw), broken_at=rec.seq,
                    reason=(
                        f"broken link at seq={rec.seq}: prev_hash "
                        f"{rec.prev_hash[:12]}… != expected {prev_hash[:12]}…"
                    ),
                )
            # (c) content must hash to the stored record_hash (no mutation).
            recomputed = _hash_record(rec.content())
            if recomputed != rec.record_hash:
                return ChainReport(
                    ok=False, length=len(raw), broken_at=rec.seq,
                    reason=(
                        f"tampered record at seq={rec.seq}: content hash "
                        f"{recomputed[:12]}… != stored {rec.record_hash[:12]}…"
                    ),
                )
            prev_hash = rec.record_hash
        return ChainReport(ok=True, length=len(raw), reason="chain intact")

    # -- reconstruction -------------------------------------------------

    def for_task(self, task_id: str) -> List[EvidenceRecord]:
        return [r for r in self.records() if r.task_id == task_id]

    def reconstruct(self, task_id: str) -> Dict[str, Any]:
        """Replay a decision end-to-end from evidence (specs/05 §3).

        Returns the who/what/why/verdict/cost/hooks for the task, the tamper
        check for its records, and — when the run's ``spans.jsonl`` is still
        present — the ordered span trajectory, so a decision is reconstructable
        from evidence alone (the spec's test of sufficient instrumentation).
        """
        recs = self.for_task(task_id)
        if not recs:
            raise EvidenceError(f"no evidence for task_id={task_id!r}")
        report = self.verify_chain()
        # A task can legitimately have multiple records (retries); the last is
        # the decision of record.
        last = recs[-1]

        spans: List[Dict[str, Any]] = []
        spans_path = last.spans_path
        if spans_path and os.path.exists(spans_path):
            try:
                from .telemetry import read_spans
                all_spans = read_spans(spans_path)
                # Keep only spans belonging to this task's run(s).
                run_ids = {
                    s["run_id"]
                    for s in all_spans
                    if s.get("type") == "run"
                    and s.get("attrs", {}).get("task_id") == task_id
                }
                spans = [s for s in all_spans if s.get("run_id") in run_ids]
                spans.sort(key=lambda s: s.get("start", 0.0))
            except Exception:
                spans = []

        return {
            "task_id": task_id,
            "records": [r.to_dict() for r in recs],
            "who": last.who,
            "what": last.what,
            "why": last.why,
            "verdict": last.verdict,
            "passed": last.passed,
            "tokens_spent": last.tokens_spent,
            "model_route": last.model_route,
            "hooks_fired": last.hooks_fired,
            "hook_decisions": last.hook_decisions,
            "blocks": last.blocks,
            "approvals": last.approvals,
            "chain_ok": report.ok,
            "chain": report.to_dict(),
            "trajectory": spans,
            "trajectory_steps": [s.get("name") for s in spans],
        }

    # -- export ---------------------------------------------------------

    def export(
        self,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Generate a compliance artifact for an arbitrary date range.

        ``start``/``end`` are inclusive ISO-8601 timestamps (either may be
        omitted for an open bound). The artifact carries the verified chain
        status so a reviewer knows the exported slice is untampered.
        """
        recs = self.records()

        def _in_range(ts: str) -> bool:
            if start is not None and ts < start:
                return False
            if end is not None and ts > end:
                return False
            return True

        selected = [r for r in recs if _in_range(r.timestamp)]
        report = self.verify_chain()
        passed = sum(1 for r in selected if r.passed)
        return {
            "artifact": "sc-prism-compliance-export",
            "generated_at": _now_iso(),
            "range": {"start": start, "end": end},
            "chain_verified": report.ok,
            "chain": report.to_dict(),
            "count": len(selected),
            "passed": passed,
            "failed": len(selected) - passed,
            "total_tokens": sum(r.tokens_spent for r in selected),
            "task_ids": sorted({r.task_id for r in selected}),
            "records": [r.to_dict() for r in selected],
        }
