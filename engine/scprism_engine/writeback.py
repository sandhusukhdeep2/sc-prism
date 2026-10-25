"""Writeback — build a Verdict and persist it atomically.

A Verdict is the durable record of one orchestrated task: what was verified,
how many tokens were spent, where models ran, which hooks fired, and any
artifacts. It is written to `<vault>/verdicts/<task_id>.json` (atomic) and
appended to `<vault>/log.md`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .verifier import Tier1Result, Tier2Result


class VerdictError(ValueError):
    """Raised when a Verdict fails validation."""


@dataclass
class Verdict:
    task_id: str
    tier1: Dict[str, Any]
    tier2: Dict[str, Any]
    tokens_spent: int
    model_route: List[str] = field(default_factory=list)
    hooks_fired: List[str] = field(default_factory=list)
    artifacts: List[str] = field(default_factory=list)
    passed: bool = False
    # The FOUR-VALUE outcome, because fewer values cannot tell the truth about
    # this product's own tier hierarchy (see `build_verdict`):
    #
    #   "passed"    — Tier-1 and Tier-2 both cleared. `passed` is True.
    #   "replied"   — a CONVERSE run's pass: the turn's deliverable is the
    #                 reply, the judge cleared it, and there were no files or
    #                 checks to clear BY DESIGN. `passed` is True — a good
    #                 reply is a success — but the word on the record says what
    #                 actually happened, so no chat turn ever wears a build's
    #                 badge (either colour of it).
    #   "attention" — the DETERMINISTIC Tier-1 gate genuinely ran the project's
    #                 checks against real written files and PASSED, but the
    #                 Tier-2 LLM reviewer dissented on score. "Your tests passed;
    #                 the reviewer wasn't satisfied" — which is neither a pass
    #                 nor the flat failure it used to be recorded as.
    #   "failed"    — anything else, including every envelope breach, block and
    #                 rejected write.
    #
    # `passed` deliberately stays the strict conjunction: an "attention" verdict
    # must not silently auto-commit (project.py checkpoints on `passed`) or
    # emit a training reward. Consumers that want the honest label read
    # `outcome`; consumers that gate an action keep reading `passed` (which is
    # exactly why "replied" carries `passed=True` — and why the training seam
    # gates converse out on MODE, not on this boolean).
    outcome: str = "failed"
    outcome_reason: str = ""
    timestamp: str = ""
    # The assistant completion text produced by the model this run (the answer
    # the Workspace chat surfaces). Empty for pure-governance runs. `answer` is
    # an alias kept in the JSON for client robustness (see to_dict).
    response: str = ""
    # The REAL provider · model pairs that answered this run (UI shows these
    # honestly instead of a hardcoded label).
    models_used: List[str] = field(default_factory=list)
    # The gateway's HONEST route reason(s) for this run (distinct, in order) —
    # e.g. "learned route policy v3: bucket 'docs' -> cloud (p=0.61)". Lets the
    # client label the route from the REAL cause instead of a fabricated one
    # (LF-fix E). Empty for a run whose doer routes itself (composite doer) or a
    # stub — the client then falls back to its built-in labels, byte-identical.
    model_route_reasons: List[str] = field(default_factory=list)
    # Cost + cache attribution and the trace pointer (specs/07).
    cache_hits: int = 0
    cache_misses: int = 0
    spans_path: str = ""
    # Governance audit spine (Layer 3/4, specs/05 §3). Every hook + permission
    # decision, every block, and every consumed approval is recorded here so a
    # governed action is fully reconstructable from the Verdict.
    hook_decisions: List[Dict[str, Any]] = field(default_factory=list)
    blocks: List[Dict[str, Any]] = field(default_factory=list)
    approvals: List[Dict[str, Any]] = field(default_factory=list)
    # Harness Layer 1/6 (memory + context routing, specs/03). What memory was
    # injected under budget, which skills were disclosed, and any vault write the
    # validation gate REJECTED (ADR-014 — a rejected write fails closed here).
    memory_injected: List[Dict[str, Any]] = field(default_factory=list)
    disclosed: List[str] = field(default_factory=list)
    rejected_writes: List[Dict[str, Any]] = field(default_factory=list)
    # ADR-032 — path to the Conductor-style workflow YAML emitted from the Task
    # Contract BEFORE execution (the diffable routing graph). Empty when the
    # emit_workflow feature is off (default), keeping the loop byte-identical.
    workflow_path: str = ""
    # Free-form slot for optional feature-specific payloads that don't warrant
    # their own top-level field (e.g. project.py's post_dispatch seam stashes
    # `extras["project"]` here — files_written/rejected/git_checkpoint).
    # Default `{}` keeps every existing verdict byte-identical.
    extras: Dict[str, Any] = field(default_factory=dict)

    def validate(self) -> "Verdict":
        """Hand-rolled schema validation; raise VerdictError on bad input."""
        if not self.task_id or not str(self.task_id).strip():
            raise VerdictError("task_id must be non-empty")
        if not isinstance(self.tier1, dict):
            raise VerdictError("tier1 must be a dict")
        if not isinstance(self.tier2, dict):
            raise VerdictError("tier2 must be a dict")
        if not isinstance(self.tokens_spent, int) or self.tokens_spent < 0:
            raise VerdictError("tokens_spent must be a non-negative int")
        if not isinstance(self.model_route, list):
            raise VerdictError("model_route must be a list")
        if not isinstance(self.hooks_fired, list):
            raise VerdictError("hooks_fired must be a list")
        if not isinstance(self.artifacts, list):
            raise VerdictError("artifacts must be a list")
        if not isinstance(self.passed, bool):
            raise VerdictError("passed must be a bool")
        if self.outcome not in ("passed", "attention", "failed", "replied"):
            raise VerdictError("outcome must be passed/attention/failed/replied")
        if not isinstance(self.outcome_reason, str):
            raise VerdictError("outcome_reason must be a str")
        if self.passed != (self.outcome in ("passed", "replied")):
            # The two must never be able to disagree: `passed` is exactly
            # "this run succeeded" — outcome "passed" for task work, "replied"
            # for a conversational turn — and a consumer reading either alone
            # is then reading the same claim. A "replied" that did not pass is
            # a contradiction in terms: replied IS the converse pass.
            raise VerdictError("passed must agree with outcome")
        if not isinstance(self.cache_hits, int) or self.cache_hits < 0:
            raise VerdictError("cache_hits must be a non-negative int")
        if not isinstance(self.cache_misses, int) or self.cache_misses < 0:
            raise VerdictError("cache_misses must be a non-negative int")
        if not isinstance(self.hook_decisions, list):
            raise VerdictError("hook_decisions must be a list")
        if not isinstance(self.blocks, list):
            raise VerdictError("blocks must be a list")
        if not isinstance(self.approvals, list):
            raise VerdictError("approvals must be a list")
        if not isinstance(self.memory_injected, list):
            raise VerdictError("memory_injected must be a list")
        if not isinstance(self.disclosed, list):
            raise VerdictError("disclosed must be a list")
        if not isinstance(self.rejected_writes, list):
            raise VerdictError("rejected_writes must be a list")
        if not isinstance(self.model_route_reasons, list):
            raise VerdictError("model_route_reasons must be a list")
        if not isinstance(self.workflow_path, str):
            raise VerdictError("workflow_path must be a str")
        if not isinstance(self.response, str):
            raise VerdictError("response must be a str")
        if not isinstance(self.extras, dict):
            raise VerdictError("extras must be a dict")
        return self

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        # `answer` mirrors `response` so a client can read either key.
        d["answer"] = self.response
        return d

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)


def _tier1_summary(t1: Optional[Tier1Result]) -> Dict[str, Any]:
    if t1 is None:
        return {"ran": False}
    return {
        "ran": True,
        "passed": t1.passed,
        "skipped": t1.skipped,
        # WHY it skipped, and which configured commands went unrun. Without
        # these the client can only render `skipped` as a silent pass — a tick
        # over checks that never executed.
        "skip_reason": t1.skip_reason,
        "skipped_commands": list(t1.skipped_commands),
        "tokens": t1.tokens,
        "commands": [c.command for c in t1.commands],
        "log": t1.log,
    }


def _tier2_summary(t2: Optional[Tier2Result]) -> Dict[str, Any]:
    if t2 is None or not getattr(t2, "ran", False):
        return {"ran": False, "reason": "short-circuited (tier1 failed)"}
    return {
        "ran": True,
        "passed": t2.passed,
        "score": t2.score,
        "eval_score": getattr(t2, "eval_score", t2.score),
        "metrics": dict(getattr(t2, "metrics", {}) or {}),
        "threshold": t2.threshold,
        "envelope_ok": getattr(t2, "envelope_ok", True),
        "breaches": list(getattr(t2, "breaches", []) or []),
        "envelope": dict(getattr(t2, "envelope", {}) or {}),
        "observed": dict(getattr(t2, "observed", {}) or {}),
        "tokens": t2.tokens,
        "judge_notes": getattr(t2, "judge_notes", "") or t2.rationale,
        "rationale": t2.rationale,
        # Judge claims the deterministic layer disproved. Non-empty = the judge
        # got a FACT wrong, which the UI must be able to say out loud.
        "contradictions": list(getattr(t2, "contradictions", []) or []),
    }


def build_verdict(
    *,
    task_id: str,
    tier1_result: Optional[Tier1Result],
    tier2_result: Optional[Tier2Result],
    tokens_spent: int,
    model_route: Optional[List[str]] = None,
    hooks_fired: Optional[List[str]] = None,
    artifacts: Optional[List[str]] = None,
    cache_hits: int = 0,
    cache_misses: int = 0,
    spans_path: str = "",
    hook_decisions: Optional[List[Dict[str, Any]]] = None,
    blocks: Optional[List[Dict[str, Any]]] = None,
    approvals: Optional[List[Dict[str, Any]]] = None,
    memory_injected: Optional[List[Dict[str, Any]]] = None,
    disclosed: Optional[List[str]] = None,
    rejected_writes: Optional[List[Dict[str, Any]]] = None,
    workflow_path: str = "",
    response: str = "",
    models_used: Optional[List[str]] = None,
    model_route_reasons: Optional[List[str]] = None,
    produced_files: Optional[List[str]] = None,
    mode: str = "",
) -> Verdict:
    """Assemble a Verdict. Overall pass = tier1 passed AND tier2 passed AND no
    governance block went unresolved AND no vault write was rejected by the
    validation gate (ADR-014 — a rejected write fails the task closed).

    ``mode`` is the contract's mode, and only "converse" changes anything: a
    chat turn that clears the judge is recorded ``outcome="replied"`` (its
    kind of pass), and one that does not still fails — but in reply terms,
    because "no files were produced" and "tier-1 was skipped" are statements
    about a build, and stamping them on a conversation is exactly how good
    replies were landing on the Work page as red "failed" badges. Default
    ``""`` keeps every existing caller byte-identical.

    **The tier hierarchy, said honestly.** Tier-1 is deterministic evidence;
    Tier-2 is an LLM's judgement. Recording "tests ran and passed, reviewer
    dissented" as a flat ``failed`` inverts that hierarchy — it lets an opinion
    erase a measurement, and it is what put failures on this product's pass
    rates, agent stats and manager reports for work that had genuinely
    succeeded. So the outcome is three-valued (see ``Verdict.outcome``):

    * ``attention`` requires ALL of: Tier-1 genuinely EXECUTED checks (not
      skipped — a skip verifies nothing) and passed; ``produced_files`` is
      non-empty, so there is an artifact the checks ran against; Tier-2 RAN and
      dissented on SCORE ONLY; and nothing else failed closed. An envelope
      breach, a block or a rejected write is deterministic too and still fails.
    * A run with no files, or whose Tier-1 was skipped, is still ``failed`` when
      the judge dissents — there is no measurement there to outrank the opinion.

    Tier-2 is NOT ignored: it still denies the pass, still records its score and
    notes, and ``tier2.contradictions`` names any claim it made that the
    deterministic layer disproved. What changes is that the record can now say
    which of the two actually objected.
    """
    t1_ok = bool(tier1_result and tier1_result.passed)
    t2_ok = bool(tier2_result and getattr(tier2_result, "passed", False))
    gov_ok = not blocks and not rejected_writes
    passed = t1_ok and t2_ok and gov_ok

    # Did Tier-1 genuinely execute checks? `Tier1Result.passed` is True on a
    # SKIP too (nothing to disprove), so `passed` alone can never stand as
    # evidence — a skipped gate outranks nothing.
    t1_hard = bool(
        t1_ok
        and tier1_result is not None
        and not getattr(tier1_result, "skipped", False)
        and getattr(tier1_result, "commands", None)
    )
    t2_ran = bool(tier2_result and getattr(tier2_result, "ran", False))
    t2_envelope_ok = bool(tier2_result is None or getattr(tier2_result, "envelope_ok", True))
    files = list(produced_files or [])

    if passed and mode == "converse":
        # A chat turn's pass, in a chat turn's words. No gate line: tier-1 is
        # not applicable to a reply (the criteria say so), so "was skipped"
        # would report a non-event as if it were a caveat.
        outcome = "replied"
        outcome_reason = (
            f"the reply cleared the judge at "
            f"{getattr(tier2_result, 'eval_score', 0.0)} "
            f"(threshold {getattr(tier2_result, 'threshold', 0.0)})."
        )
    elif passed:
        outcome = "passed"
        if t1_hard:
            cmds = ", ".join(f"`{c.command}`" for c in tier1_result.commands)
            gate = f"tier-1 ran {cmds} and passed"
        else:
            gate = "tier-1 was skipped (nothing to verify)"
        outcome_reason = (
            f"{gate}; the tier-2 reviewer passed at "
            f"{getattr(tier2_result, 'eval_score', 0.0)} "
            f"(threshold {getattr(tier2_result, 'threshold', 0.0)})."
        )
    elif t1_hard and files and t2_ran and not t2_ok and t2_envelope_ok and gov_ok:
        outcome = "attention"
        cmds = ", ".join(f"`{c.command}`" for c in tier1_result.commands) or "(no command)"
        outcome_reason = (
            f"tests passed, reviewer dissented — the deterministic tier-1 gate ran "
            f"{cmds} against {len(files)} written file(s) and PASSED, but the "
            f"tier-2 reviewer scored {getattr(tier2_result, 'eval_score', 0.0)} "
            f"below its {getattr(tier2_result, 'threshold', 0.0)} threshold. "
            f"This run is NOT a failure: the work exists and its checks pass. It "
            f"needs a look, not a redo."
        )
        contradictions = list(getattr(tier2_result, "contradictions", []) or [])
        if contradictions:
            outcome_reason += (
                " The reviewer also contradicted measured evidence ("
                + "; ".join(contradictions)
                + ") — treat its score as unreliable for this run."
            )
    else:
        outcome = "failed"
        converse = mode == "converse"
        why: List[str] = []
        if not t1_ok:
            why.append("tier-1 failed")
        elif not t1_hard and not converse:
            # For a reply there is no gate to have skipped — the criteria name
            # tier-1 "not applicable" — so this line (and the no-files one
            # below) is build vocabulary that stays off a conversation's
            # record. Both sentences sat on the real failing chat verdicts.
            why.append(
                "tier-1 was skipped, so nothing deterministic was verified"
            )
        if not files and not converse:
            why.append("no files were produced")
        if t2_ran and not t2_ok:
            if not t2_envelope_ok:
                why.append(
                    "tier-2 envelope BREACH: "
                    + "; ".join(getattr(tier2_result, "breaches", []) or [])
                )
            elif converse:
                why.append(
                    f"the reply scored {getattr(tier2_result, 'eval_score', 0.0)} "
                    f"below the judge's {getattr(tier2_result, 'threshold', 0.0)} bar"
                )
            else:
                why.append(
                    f"tier-2 scored {getattr(tier2_result, 'eval_score', 0.0)} "
                    f"below {getattr(tier2_result, 'threshold', 0.0)}"
                )
        elif not t2_ran:
            why.append("tier-2 did not run (short-circuited)")
        if blocks:
            why.append(f"{len(blocks)} governance block(s)")
        if rejected_writes:
            why.append(f"{len(rejected_writes)} rejected vault write(s)")
        outcome_reason = "; ".join(why) or "did not pass"

    verdict = Verdict(
        task_id=task_id,
        tier1=_tier1_summary(tier1_result),
        tier2=_tier2_summary(tier2_result),
        tokens_spent=int(tokens_spent),
        model_route=sorted(set(model_route or [])),
        hooks_fired=list(hooks_fired or []),
        artifacts=list(artifacts or []),
        passed=passed,
        outcome=outcome,
        outcome_reason=outcome_reason,
        timestamp=datetime.now(timezone.utc).isoformat(),
        cache_hits=int(cache_hits),
        cache_misses=int(cache_misses),
        spans_path=spans_path,
        hook_decisions=list(hook_decisions or []),
        blocks=list(blocks or []),
        approvals=list(approvals or []),
        memory_injected=list(memory_injected or []),
        disclosed=list(disclosed or []),
        rejected_writes=list(rejected_writes or []),
        workflow_path=workflow_path or "",
        response=response or "",
        models_used=list(models_used or []),
        model_route_reasons=list(model_route_reasons or []),
    )
    return verdict.validate()


def _atomic_write(path: str, data: str) -> None:
    """Write `data` to `path` atomically (temp file + os.replace)."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)  # atomic on POSIX
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# --------------------------------------------------------------------------
# Attempt history — one logical run, N verified attempts.
# --------------------------------------------------------------------------
#
# A refine loop runs the SAME logical step more than once: attempt 1 fails its
# Tier-1 checks, attempt 2 is re-run with that failure as feedback. Each attempt
# is its own governed run and gets its own `<vault>/verdicts/<task_id>.json` —
# nothing is ever overwritten (`task_id` carries a per-run uuid suffix). What was
# missing is the LINK between them: with nothing tying attempt 2 back to attempt
# 1, neither the user nor the stats layer can answer the one question a verified
# refine loop exists to answer — did refining actually improve anything?
#
# The ledger below is that link, and ONLY that link. It records no new outcome of
# its own: every field is copied from a Verdict that is already on disk, so the
# ledger can be deleted and rebuilt without losing a single fact.
#
# Placement: `<vault>/verdicts/attempts/<group>.json`. Inside `verdicts/` because
# that tree is already skipped by every vault scanner (memory / context /
# retrieval) — a ledger is machine bookkeeping, not knowledge. It is created only
# when a caller actually tracks attempts, so a vault that never refines looks
# exactly as it did before.

ATTEMPTS_DIRNAME = "attempts"


def _safe_group(group: str) -> str:
    """A filesystem-safe, STABLE filename stem for a caller's group id.

    The readable slug is for a human reading `ls`; the hash suffix is what makes
    it correct — two different group ids that slugify identically (`a/b:1` and
    `a-b-1`) must never collide into one history. Same input -> same stem,
    always, so a later attempt finds the ledger the earlier one wrote.
    """
    raw = (group or "").strip()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").lower()[:48] or "group"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"{slug}-{digest}"


def attempts_index_path(vault: str, group: str) -> str:
    """Path to the attempt ledger for `group` (never creates anything)."""
    return os.path.join(vault, "verdicts", ATTEMPTS_DIRNAME, f"{_safe_group(group)}.json")


def read_attempts(vault: str, group: str) -> Dict[str, Any]:
    """The attempt history for one logical run, oldest attempt first.

    Returns `{"group", "latest", "attempts": [...]}`; an unknown/never-tracked
    group returns the same shape with an empty list rather than raising, so a
    reader never has to special-case "no history yet". Best-effort I/O: a
    corrupt/unreadable ledger reads as empty — history is a convenience for the
    reader, never a gate, and it must not be able to take a run down.
    """
    path = attempts_index_path(vault, group)
    empty: Dict[str, Any] = {"group": group, "latest": "", "attempts": []}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("attempts"), list):
        return empty
    data.setdefault("group", group)
    data.setdefault("latest", "")
    return data


def record_attempt(
    verdict: Verdict,
    vault: str,
    *,
    group: str,
    number: int,
    previous_task_id: str = "",
) -> str:
    """Append (or replace) this attempt in `group`'s ledger. Returns its path.

    Every entry is a pointer plus facts copied from the verdict that is already
    persisted — `task_id`, `outcome`, `passed`, the timestamp, the tokens it
    spent and whether Tier-1 ran/passed. Re-running the SAME attempt number
    REPLACES its entry instead of appending a second one: a retried attempt 2 is
    still attempt 2, and a ledger that grew a duplicate row per re-run would
    inflate exactly the counts it exists to make honest.

    `latest` is the stable pointer for readers that want "the current state of
    this step" without knowing how many attempts it took.
    """
    if not group or int(number) <= 0:
        return ""
    index = read_attempts(vault, group)
    entry: Dict[str, Any] = {
        "attempt": int(number),
        "task_id": verdict.task_id,
        "outcome": verdict.outcome,
        "passed": bool(verdict.passed),
        "timestamp": verdict.timestamp,
        "tokens_spent": int(verdict.tokens_spent),
        "tier1_ran": bool((verdict.tier1 or {}).get("ran", False)),
        "tier1_passed": bool((verdict.tier1 or {}).get("passed", False)),
        "verdict": os.path.join("verdicts", f"{verdict.task_id}.json"),
        "previous_task_id": previous_task_id or "",
    }
    rows = [
        r
        for r in index.get("attempts", [])
        if isinstance(r, dict) and int(r.get("attempt", 0) or 0) != int(number)
    ]
    rows.append(entry)
    rows.sort(key=lambda r: int(r.get("attempt", 0) or 0))
    index["group"] = group
    index["attempts"] = rows
    index["latest"] = rows[-1].get("task_id", "")
    path = attempts_index_path(vault, group)
    _atomic_write(path, json.dumps(index, indent=2))
    return path


def persist_vault_write(
    vault: str,
    rel_path: str,
    content: str,
    rules: Any = None,
) -> Dict[str, Any]:
    """Persist a markdown write to the vault THROUGH the validation gate.

    Every vault write dry-runs against the rule files first (ADR-014,
    ``memory.validate_write``). A contradiction / hallucination is rejected
    BEFORE anything touches disk — it fails closed and returns a reason; L3
    never sees it. A clean write is persisted atomically.

    Returns ``{"ok": bool, "reason": str, "path": str}``. ``rules`` defaults to
    the vault's current rule set when not supplied.
    """
    from .memory import validate_write, RuleSet

    if rules is None:
        rules = RuleSet.from_vault(vault)

    result = validate_write(rel_path, content, rules)
    if not result.get("ok"):
        # Fail closed: nothing is written.
        return {"ok": False, "reason": result.get("reason", "rejected"), "path": ""}

    abs_path = os.path.join(vault, rel_path)
    _atomic_write(abs_path, content)
    return {"ok": True, "reason": result.get("reason", "validated"), "path": abs_path}


def write_verdict(verdict: Verdict, vault: str, *, append_log: bool = True) -> str:
    """Persist the verdict under `vault`.

    Writes `<vault>/verdicts/<task_id>.json` atomically and (by default)
    appends a line to `<vault>/log.md`. Returns the verdict file path.

    `append_log=False` re-persists the verdict JSON only — for a caller that
    re-writes the SAME verdict after loop.run already logged it once (e.g.
    project.py's git-checkpoint re-persist), so the task never gets a second
    log.md line for one step.
    """
    verdicts_dir = os.path.join(vault, "verdicts")
    os.makedirs(verdicts_dir, exist_ok=True)

    verdict_path = os.path.join(verdicts_dir, f"{verdict.task_id}.json")
    _atomic_write(verdict_path, verdict.to_json())

    if append_log:
        log_path = os.path.join(vault, "log.md")
        # Attempt N of a refine loop is logged as such. The log line is the one
        # place a human scrolls to see what happened; without this, attempt 2 of
        # a step is indistinguishable from an unrelated run that happened to
        # come after it. Absent attempt info -> the line is byte-identical to v1.
        # Four statuses, matching `Verdict.outcome`. ATTENTION is the run whose
        # deterministic checks passed over real files and whose LLM reviewer
        # dissented — logging that as FAIL is exactly the lie this log used to
        # tell about work that had succeeded. REPLIED is a chat turn's pass;
        # falling through to FAIL here would re-tell the same lie one word on.
        status = {"passed": "PASS", "attention": "ATTENTION", "replied": "REPLIED"}.get(
            verdict.outcome, "FAIL"
        )
        attempt_note = ""
        att = (verdict.extras or {}).get("attempt")
        if isinstance(att, dict) and int(att.get("number", 0) or 0) > 0:
            attempt_note = f"attempt={int(att['number'])} "
        line = (
            f"- {verdict.timestamp} `{verdict.task_id}` **{status}** "
            f"{attempt_note}"
            f"tokens={verdict.tokens_spent} "
            f"routes={','.join(verdict.model_route) or '-'} "
            f"-> {os.path.relpath(verdict_path, vault)}\n"
        )
        # Append is inherently additive; create header once.
        if not os.path.exists(log_path):
            header = "# SC Prism — Verdict Log\n\n"
            with open(log_path, "w", encoding="utf-8") as fh:
                fh.write(header)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(line)

    return verdict_path
