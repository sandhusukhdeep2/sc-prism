"""Tier-2 evals — the LLM-judge + operating-envelope gate (specs/06, specs/02 §2).

Tier-1 is the deterministic truth gate (zero tokens). Tier-2 covers the
NON-deterministic part of the answer — did the agent take a sensible
trajectory, use tools accurately, satisfy the acceptance criteria, and
actually complete the task? That judgement is made by a model, and per the
core invariant the model is reached **only through the Gateway**
(`gateway.model_call`) — never a direct provider call. When no provider is
configured the gateway returns a deterministic offline stub, so the judge
degrades to a deterministic heuristic scorer and the whole engine stays
offline-safe and reproducible.

Three things gate a task at Tier-2:

  1. **Named metrics** (each 0..1), aggregated into ``eval_score``:
       - ``trajectory_sensibility``          — was the plan/step order sane?
       - ``tool_use_accuracy``               — right tools/routes, no errors?
       - ``acceptance_criteria_satisfaction``— did it meet the contract's criteria?
       - ``task_completion``                 — did every step produce output?
  2. **Operating envelopes** — token budget, step/turn limit, latency timeout.
     An envelope BREACH fails Tier-2 *even if the answer looks right* — this is
     the runaway-but-successful case (10× tokens, 40 loops) that a score-only
     gate misses (specs/06 §3).
  3. **Score-based gate** — ``eval_score`` vs a configurable threshold
     (default 0.7). Below threshold OR an envelope breach => Tier-2 fail, and
     the loop routes to repair / marks the Verdict not-passed (specs/06 §4).

DeepEval is the spec's chosen framework; it would, however, call the judge
model directly and bypass the Gateway, so it is deferred as an OPTIONAL future
backend (tranche E-Bifrost). This module implements the same discipline —
goldens + trace metrics + envelopes + score gate — on top of our Gateway.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .verifier import Tier2Result

# The four trace-level metrics the judge scores (specs/06 §1, specs/02 §5).
METRIC_NAMES = (
    "trajectory_sensibility",
    "tool_use_accuracy",
    "acceptance_criteria_satisfaction",
    "task_completion",
)

DEFAULT_THRESHOLD = 0.7

# --------------------------------------------------------------------------
# Judge-prompt budgets. Every slice the prompt takes is bounded AND announced:
# an un-announced cut is what made a real 12,543-char completion (6 files, 397
# lines, `npm test` green) reach the judge as 500 characters ending mid-word,
# which the judge then correctly described as "the produced artifact is
# truncated ... failing to provide the actual implementation or the required
# files" and scored 0.5. The judge was right about what it was shown; the
# prompt was what lied. These caps keep the evidence section affordable.
# --------------------------------------------------------------------------
JUDGE_STEP_CHARS = 200            # per trace step (unchanged)
JUDGE_ARTIFACT_CHARS = 500        # of the raw completion (unchanged)
JUDGE_TIER1_LOG_CHARS = 600       # tail of the deterministic gate's own output
JUDGE_FILE_LIST_MAX = 40          # files named individually; the rest are counted
JUDGE_EXCERPT_PER_FILE = 1200     # chars of any one written file
JUDGE_EXCERPT_BUDGET = 6000       # chars of written-file excerpts in total
# Hard ceiling on the whole "what this run produced" block. `format_evidence`
# never returns more than this, whatever the file set looks like.
JUDGE_EVIDENCE_CHAR_BUDGET = 8000


# --------------------------------------------------------------------------
# Operating envelopes (specs/06 §3)
# --------------------------------------------------------------------------


@dataclass
class Envelope:
    """Hard operating limits for a run. A breach fails Tier-2 regardless of
    how good the answer looks — this catches the runaway agent.

    Any field left ``None`` is not gated. All limits are inclusive maxima.
    """

    token_budget: Optional[int] = None  # max tokens the dispatch phase may spend
    max_steps: Optional[int] = None     # max steps/turns executed
    latency_ms: Optional[float] = None  # max wall-clock latency for the phase

    def to_dict(self) -> Dict[str, Any]:
        return {
            "token_budget": self.token_budget,
            "max_steps": self.max_steps,
            "latency_ms": self.latency_ms,
        }


@dataclass
class EnvelopeReport:
    """Outcome of the envelope check."""

    ok: bool
    breaches: List[str] = field(default_factory=list)
    observed: Dict[str, Any] = field(default_factory=dict)
    envelope: Dict[str, Any] = field(default_factory=dict)


def build_envelope(contract, *, latency_ms: Optional[float] = None) -> Envelope:
    """Derive the default envelope from a TaskContract's hard caps."""
    return Envelope(
        token_budget=int(contract.token_budget),
        max_steps=int(contract.max_turns),
        latency_ms=latency_ms,
    )


def check_envelope(
    envelope: Envelope,
    *,
    tokens_spent: int,
    steps: int,
    latency_ms: Optional[float] = None,
) -> EnvelopeReport:
    """Compare observed run cost against the envelope. Deterministic.

    Latency is only gated when both a limit and an observed value are present
    (wall-clock is non-deterministic, so tests drive breaches via tokens/steps).
    """
    breaches: List[str] = []

    if envelope.token_budget is not None and tokens_spent > envelope.token_budget:
        breaches.append(
            f"token_budget: {tokens_spent} > {envelope.token_budget}"
        )
    if envelope.max_steps is not None and steps > envelope.max_steps:
        breaches.append(f"max_steps: {steps} > {envelope.max_steps}")
    if (
        envelope.latency_ms is not None
        and latency_ms is not None
        and latency_ms > envelope.latency_ms
    ):
        breaches.append(
            f"latency_ms: {round(latency_ms, 1)} > {envelope.latency_ms}"
        )

    observed = {
        "tokens_spent": tokens_spent,
        "steps": steps,
        "latency_ms": None if latency_ms is None else round(latency_ms, 1),
    }
    return EnvelopeReport(
        ok=not breaches,
        breaches=breaches,
        observed=observed,
        envelope=envelope.to_dict(),
    )


# --------------------------------------------------------------------------
# Trace observation (deterministic feature extraction)
# --------------------------------------------------------------------------


def observe_trace(trace) -> Dict[str, Any]:
    """Extract deterministic features from a dispatch trace.

    Accepts a ``DispatchResult`` (has ``step_results``) or any object with a
    similar shape; degrades to treating the argument as opaque text.
    """
    steps = getattr(trace, "step_results", None)
    if steps is None:
        text = str(trace)
        return {
            "steps": 1,
            "tokens_spent": int(getattr(trace, "tokens_spent", 0)),
            "outputs": [text],
            "routes": [],
            "kinds": [],
            "write_indexes": [],
            "read_indexes": [0],
            "has_read_before_write": True,
            "produced_chars": len(text),
            "truncated_steps": [],
        }

    outputs = [getattr(s, "output", "") for s in steps]
    routes = [getattr(s, "route", "") for s in steps]
    kinds = [getattr(s, "kind", "read") for s in steps]
    write_idx = [
        getattr(s, "index", i) for i, s in enumerate(steps) if kinds[i] == "write"
    ]
    read_idx = [
        getattr(s, "index", i) for i, s in enumerate(steps) if kinds[i] != "write"
    ]
    has_read_before_write = (not write_idx) or (
        bool(read_idx) and min(read_idx) < min(write_idx)
    )
    return {
        "steps": len(steps),
        "tokens_spent": int(getattr(trace, "tokens_spent", 0)),
        "outputs": outputs,
        "routes": routes,
        "kinds": kinds,
        "write_indexes": write_idx,
        "read_indexes": read_idx,
        "has_read_before_write": has_read_before_write,
        "produced_chars": sum(len(o) for o in outputs),
        # Steps whose output the provider CUT OFF at its output cap. The judge
        # is told (see _build_judge_messages) so an unfinished answer is graded
        # as unfinished, never silently as bad writing.
        "truncated_steps": [
            getattr(s, "index", i)
            for i, s in enumerate(steps)
            if getattr(s, "truncated", False)
        ],
    }


# --------------------------------------------------------------------------
# Run evidence — the deterministic facts the judge must be shown
# --------------------------------------------------------------------------


@dataclass
class RunEvidence:
    """What the run ACTUALLY produced, measured — never inferred from a trace.

    The Tier-2 judge scores the non-deterministic quality of a run, but it was
    historically handed only a trace summary and a 500-char slice of the raw
    completion. It could not see that files existed on disk, nor that the
    deterministic Tier-1 gate had already run the project's tests and passed.
    An "did it implement the thing?" question asked of a witness who cannot see
    the thing has exactly one honest answer, and the judge gave it.

    This carries the measured truth alongside the trace: the files written
    (path + size on disk + a bounded excerpt read back from disk) and the REAL
    Tier-1 outcome (ran / passed / failed / skipped, with its command and the
    tail of its own output). It is deterministic and costs zero model tokens to
    produce.
    """

    # {"path", "bytes", "excerpt", "excerpt_truncated", "missing"} per file.
    files: List[Dict[str, Any]] = field(default_factory=list)
    total_bytes: int = 0
    root: str = ""
    # The REAL Tier-1 outcome. `ran` is False when Tier-1 was never handed to us
    # at all (a caller that does not run it); `skipped` is Tier-1's own honest
    # "there was nothing here to check" — neither is a pass.
    tier1_ran: bool = False
    tier1_passed: bool = False
    tier1_skipped: bool = False
    tier1_commands: List[str] = field(default_factory=list)
    tier1_failed_commands: List[str] = field(default_factory=list)
    tier1_skip_reason: str = ""
    tier1_log: str = ""

    @property
    def has_files(self) -> bool:
        """At least one file was written and is present on disk with content."""
        return any(not f.get("missing") and int(f.get("bytes", 0)) > 0 for f in self.files)

    @property
    def tier1_is_hard_pass(self) -> bool:
        """Tier-1 genuinely EXECUTED checks and every one of them passed.

        A skip is deliberately excluded: `Tier1Result.passed` is True alongside
        `skipped` (there is nothing to disprove), so anything that treats a
        Tier-1 pass as evidence must read this and not `passed`.
        """
        return bool(
            self.tier1_ran
            and self.tier1_passed
            and not self.tier1_skipped
            and self.tier1_commands
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "files": [
                {"path": f["path"], "bytes": f["bytes"], "missing": f.get("missing", False)}
                for f in self.files
            ],
            "total_bytes": self.total_bytes,
            "tier1_ran": self.tier1_ran,
            "tier1_passed": self.tier1_passed,
            "tier1_skipped": self.tier1_skipped,
            "tier1_commands": list(self.tier1_commands),
        }


def build_evidence(
    *,
    tier1_result=None,
    files_written: Optional[List[str]] = None,
    root: str = "",
    excerpt_budget: int = JUDGE_EXCERPT_BUDGET,
    per_file: int = JUDGE_EXCERPT_PER_FILE,
) -> RunEvidence:
    """Measure what a run produced. Deterministic, zero tokens, best-effort I/O.

    `files_written` are paths relative to `root` (project.py's post_dispatch
    ledger). Each is stat-ed and, while the excerpt budget lasts, read back from
    disk — reading the FILE rather than re-quoting the completion is the point:
    it is proof the write actually landed. An unreadable/absent path is recorded
    as `missing` rather than silently dropped, and no I/O error may ever take a
    run down (this is an evidence gatherer, not a gate).
    """
    ev = RunEvidence(root=root or "")
    if tier1_result is not None:
        ev.tier1_ran = True
        ev.tier1_passed = bool(getattr(tier1_result, "passed", False))
        ev.tier1_skipped = bool(getattr(tier1_result, "skipped", False))
        ev.tier1_commands = [
            getattr(c, "command", "") for c in getattr(tier1_result, "commands", []) or []
        ] or list(getattr(tier1_result, "skipped_commands", []) or [])
        ev.tier1_failed_commands = list(getattr(tier1_result, "failed_commands", []) or [])
        ev.tier1_skip_reason = str(getattr(tier1_result, "skip_reason", "") or "")
        ev.tier1_log = str(getattr(tier1_result, "log", "") or "")

    spent = 0
    for rel in list(files_written or []):
        entry: Dict[str, Any] = {
            "path": str(rel), "bytes": 0, "excerpt": "",
            "excerpt_truncated": False, "missing": False,
        }
        abs_path = os.path.join(root, str(rel)) if root else str(rel)
        try:
            entry["bytes"] = os.path.getsize(abs_path)
        except OSError:
            entry["missing"] = True
            ev.files.append(entry)
            continue
        ev.total_bytes += entry["bytes"]
        room = min(per_file, max(0, excerpt_budget - spent))
        if room > 0:
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                    chunk = fh.read(room + 1)
            except OSError:
                chunk = ""
            if len(chunk) > room:
                chunk = chunk[:room]
                entry["excerpt_truncated"] = True
            entry["excerpt"] = chunk
            spent += len(chunk)
        else:
            entry["excerpt_truncated"] = entry["bytes"] > 0
        ev.files.append(entry)
    return ev


def format_evidence(ev: Optional[RunEvidence], mode: str = "") -> str:
    """Render the evidence block for the judge prompt. Bounded, and honest
    about every cut it makes.

    Guaranteed to return at most ``JUDGE_EVIDENCE_CHAR_BUDGET`` characters, so a
    500-file run cannot blow the prompt envelope. Whatever is elided is named as
    an elision **by us**, never left to look like the agent produced less than
    it did — that confusion is the whole bug this block exists to fix.

    ``mode`` is the contract's mode. It exists for one honesty reason: the
    empty-files line below frames the run as a build ("if the task required
    producing files, it did not") — true of read/write work, and the exact
    sentence the judge quoted in both real failing CHAT verdicts. A converse
    turn's deliverable is its reply, so for ``mode="converse"`` that frame is
    replaced, not merely dropped — silence would leave the judge to infer the
    same thing. Default ``""`` keeps every existing caller byte-identical.
    """
    if ev is None:
        return ""

    lines: List[str] = ["\n\nWHAT THIS RUN ACTUALLY PRODUCED (measured, not inferred):"]

    # --- The deterministic gate, in its own words. -------------------------
    if not ev.tier1_ran:
        lines.append(
            "  TIER-1 (deterministic gate): NOT RUN for this run shape — there "
            "is no deterministic result to lean on either way."
        )
    elif ev.tier1_skipped:
        lines.append(
            "  TIER-1 (deterministic gate): SKIPPED — "
            + (ev.tier1_skip_reason or "nothing to verify")
        )
        lines.append(
            "    A skip is NOT a pass: nothing was verified. Do not credit this "
            "run with passing checks."
        )
    elif ev.tier1_passed:
        cmds = ", ".join(f"`{c}`" for c in ev.tier1_commands) or "(no command)"
        lines.append(
            f"  TIER-1 (deterministic gate): RAN AND PASSED — {cmds} exited 0."
        )
        lines.append(
            "    This is EXECUTED, zero-token evidence produced AFTER the files "
            "below were written. The project's own checks were run against them "
            "and they passed."
        )
    else:
        cmds = ", ".join(f"`{c}`" for c in ev.tier1_failed_commands or ev.tier1_commands)
        lines.append(f"  TIER-1 (deterministic gate): RAN AND FAILED — {cmds or '(no command)'}.")

    if ev.tier1_ran and not ev.tier1_skipped and ev.tier1_log:
        log = ev.tier1_log
        head = ""
        if len(log) > JUDGE_TIER1_LOG_CHARS:
            log = log[-JUDGE_TIER1_LOG_CHARS:]
            head = f"    [last {JUDGE_TIER1_LOG_CHARS} chars of the gate's output]\n"
        body = "\n".join("    " + ln for ln in log.splitlines())
        lines.append(f"  TIER-1 OUTPUT:\n{head}{body}")

    # --- The files, from disk. ---------------------------------------------
    if not ev.files:
        if mode == "converse":
            lines.append(
                "  FILES: not applicable — this is a conversational turn. The "
                "reply above is the deliverable; no files were expected and "
                "none are required."
            )
        else:
            lines.append(
                "  FILES WRITTEN: none. This run wrote no files to a project "
                "directory — if the task required producing files, it did not."
            )
    else:
        shown = ev.files[:JUDGE_FILE_LIST_MAX]
        rest = ev.files[JUDGE_FILE_LIST_MAX:]
        lines.append(
            f"  FILES WRITTEN: {len(ev.files)} file(s), {ev.total_bytes} bytes "
            f"total, on disk under {ev.root or '(the project directory)'}:"
        )
        for f in shown:
            mark = "  [MISSING ON DISK]" if f.get("missing") else ""
            lines.append(f"    - {f['path']} ({f['bytes']} bytes){mark}")
        if rest:
            rest_bytes = sum(int(f.get("bytes", 0)) for f in rest)
            lines.append(
                f"    - ... and {len(rest)} more file(s), {rest_bytes} bytes "
                f"(list elided by the evaluation harness to stay inside its "
                f"prompt budget — these files DO exist)."
            )

        excerpted = [f for f in ev.files if f.get("excerpt")]
        if excerpted:
            lines.append(
                "  FILE CONTENT (read back from disk; each excerpt is cut by the "
                "evaluation harness at its budget, NOT by the agent):"
            )
            for f in excerpted:
                cut = (
                    f"\n    ... [excerpt ends here — harness budget; the file on "
                    f"disk is {f['bytes']} bytes]"
                    if f.get("excerpt_truncated")
                    else ""
                )
                body = "\n".join("    " + ln for ln in f["excerpt"].splitlines())
                lines.append(f"  --- {f['path']} ---\n{body}{cut}")
        without = [f for f in ev.files if not f.get("excerpt") and not f.get("missing")]
        if without:
            lines.append(
                f"  ({len(without)} further file(s) were written but not excerpted "
                f"here — the harness ran out of prompt budget, not the agent out "
                f"of output. Their sizes above are the measured truth.)"
            )

    lines.append(
        "  Judge what was PRODUCED, above, not the length of the trace summary. "
        "The trace and artifact sections are harness-truncated summaries; the "
        "measurements here are complete."
    )

    block = "\n".join(lines)
    if len(block) > JUDGE_EVIDENCE_CHAR_BUDGET:
        # Last-resort clamp, so the block's own size is a HARD guarantee no
        # matter what any file's content does. The elision note is part of the
        # budget, not on top of it.
        note = (
            "\n  ... [evidence block truncated by the evaluation harness at its "
            "budget — the run produced MORE than is shown here, not less]"
        )
        block = block[: max(0, JUDGE_EVIDENCE_CHAR_BUDGET - len(note))] + note
    return block


# --------------------------------------------------------------------------
# Judge-vs-evidence contradiction detection
# --------------------------------------------------------------------------

# Phrases that assert "nothing (complete) was produced". Checked ONLY against a
# run that has hard evidence to the contrary, so an accurate criticism of a run
# that really did produce nothing is never flagged.
_CONTRADICTION_CLAIMS = (
    "truncat",
    "no implementation",
    "not implemented",
    "no actual implementation",
    "no files",
    "no file was",
    "required files",
    "nothing was produced",
    "no artifact",
    "did not produce",
    "failing to provide",
    "failed to provide",
    "incomplete",
)


def detect_contradictions(
    metrics: Dict[str, float],
    notes: str,
    ev: Optional[RunEvidence],
) -> List[str]:
    """Judge claims that the measured evidence disproves.

    An LLM opinion is allowed to dissent. It is NOT allowed to be silently
    believed when it asserts something the deterministic layer measured to be
    false — "the artifact is truncated and provides no implementation" about a
    run with six files on disk and a green `npm test` is a judge ERROR, and it
    is recorded as one instead of quietly setting a pass rate.

    Returns human-readable strings (empty when there is nothing to flag). This
    SURFACES; it deliberately does not rewrite the judge's scores — an engine
    that edits its own reviewer's marks is the opposite of honest.
    """
    if ev is None:
        return []
    # Only a run with BOTH kinds of hard evidence can contradict anything.
    if not (ev.has_files and ev.tier1_is_hard_pass):
        return []

    out: List[str] = []
    low = (notes or "").lower()
    hit = [c for c in _CONTRADICTION_CLAIMS if c in low]
    if hit:
        cmds = ", ".join(f"`{c}`" for c in ev.tier1_commands)
        out.append(
            f"judge claimed {hit[0]!r} but {len(ev.files)} file(s) "
            f"({ev.total_bytes} bytes) are on disk and {cmds} ran and passed"
        )
    completion = float(metrics.get("task_completion", 1.0) or 0.0)
    if completion < 0.5:
        out.append(
            f"judge scored task_completion={completion} but "
            f"{len(ev.files)} file(s) ({ev.total_bytes} bytes) were written"
        )
    acceptance = float(metrics.get("acceptance_criteria_satisfaction", 1.0) or 0.0)
    if acceptance < 0.5:
        cmds = ", ".join(f"`{c}`" for c in ev.tier1_commands)
        out.append(
            f"judge scored acceptance_criteria_satisfaction={acceptance} but the "
            f"deterministic gate ran {cmds} against the written files and passed"
        )
    return out


# --------------------------------------------------------------------------
# The judge prompt + response parsing
# --------------------------------------------------------------------------


def _build_judge_messages(
    contract,
    obs: Dict[str, Any],
    artifact: str,
    evidence: Optional[RunEvidence] = None,
) -> List[Dict[str, str]]:
    """Build the LLM-judge chat prompt. It asks for a strict JSON verdict so
    a real provider's answer is machine-parseable."""
    criteria = "\n".join(f"  - {c}" for c in contract.acceptance_criteria) or "  - (none)"
    # Each step is a SUMMARY line, cut at JUDGE_STEP_CHARS by us. Say so: an
    # un-announced cut reads as an agent that stopped writing.
    trajectory = "\n".join(
        f"  {i}. [{k}] {str(o)[:JUDGE_STEP_CHARS]}"
        + (" …[step summary cut by the harness]" if len(str(o)) > JUDGE_STEP_CHARS else "")
        for i, (k, o) in enumerate(zip(obs["kinds"], obs["outputs"]))
    ) or "  (no steps)"

    system = (
        "You are a strict, calibrated agent-evaluation judge. You score the "
        "NON-deterministic quality of an execution trace against its task "
        "contract. You do not run code. Respond with ONLY a JSON object.\n"
        "The trace and artifact you are shown are HARNESS-TRUNCATED summaries — "
        "where a 'WHAT THIS RUN ACTUALLY PRODUCED' section is present it is the "
        "measured truth and it overrides any impression the summaries give. "
        "Never report an artifact as truncated or missing on the strength of a "
        "summary that section contradicts."
    )
    # HONESTY: a reply the provider cut off at its output cap is INCOMPLETE, not
    # badly written — say so instead of letting the judge infer sloppiness.
    truncated = obs.get("truncated_steps") or []
    truncation = (
        "\n\nTRUNCATION NOTICE:\n  step(s) %s were CUT OFF at the model's output "
        "token cap — that text is incomplete, not a finished answer. Judge "
        "completeness accordingly and say so in your notes.\n"
        % ", ".join(str(i) for i in truncated)
        if truncated
        else ""
    )
    art = str(artifact or "")
    art_shown = art[:JUDGE_ARTIFACT_CHARS] or "(none)"
    if len(art) > JUDGE_ARTIFACT_CHARS:
        art_shown += (
            f"\n  …[artifact excerpt ends here — cut by the evaluation harness at "
            f"{JUDGE_ARTIFACT_CHARS} chars; the model produced {len(art)} chars. "
            f"This is NOT a truncated model response.]"
        )
    user = (
        f"TASK INTENT:\n  {contract.intent}\n\n"
        f"ACCEPTANCE CRITERIA:\n{criteria}\n\n"
        f"EXECUTION TRACE ({obs['steps']} step(s), "
        f"{obs['tokens_spent']} tokens):\n{trajectory}{truncation}\n\n"
        f"PRODUCED ARTIFACT (excerpt):\n  {art_shown}"
        f"{format_evidence(evidence, mode=getattr(contract, 'mode', ''))}\n\n"
        "Score each metric in [0,1] and return EXACTLY this JSON shape:\n"
        '{"trajectory_sensibility": <0..1>, "tool_use_accuracy": <0..1>, '
        '"acceptance_criteria_satisfaction": <0..1>, "task_completion": <0..1>, '
        '"notes": "<one sentence>"}'
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _parse_judge_response(text: str) -> Optional[Dict[str, float]]:
    """Parse a real judge's JSON verdict. Returns metrics dict or None.

    Robust to a model wrapping JSON in prose/code fences: grabs the first
    balanced ``{...}`` block. Returns None if any required metric is missing
    or out of range (which triggers the deterministic offline fallback).
    """
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    metrics: Dict[str, float] = {}
    for name in METRIC_NAMES:
        if name not in data:
            return None
        try:
            val = float(data[name])
        except (ValueError, TypeError):
            return None
        if not (0.0 <= val <= 1.0):
            return None
        metrics[name] = round(val, 4)
    if "notes" in data and isinstance(data["notes"], str):
        metrics["_notes"] = data["notes"]  # carried out-of-band by caller
    return metrics


def _significant_words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]{4,}", text.lower())}


def heuristic_metrics(contract, obs: Dict[str, Any]) -> Dict[str, float]:
    """Deterministic offline fallback scorer.

    Used whenever the gateway returns the offline stub (no provider) or a real
    judge's response fails to parse. A stable function of (contract, trace) so
    goldens are reproducible across engine versions.
    """
    n = max(1, obs["steps"])

    # task_completion — fraction of steps that produced non-empty output.
    with_output = sum(1 for o in obs["outputs"] if str(o).strip())
    completion = with_output / n

    # tool_use_accuracy — fraction of steps with a valid route and no error
    # marker in the output.
    good = 0
    for route, out in zip(obs["routes"], obs["outputs"]):
        routed = route in ("local", "cloud")
        clean = "error" not in str(out).lower() and "traceback" not in str(out).lower()
        if routed and clean:
            good += 1
    tool = good / n

    # trajectory_sensibility — a sane plan reads before it writes and has
    # more than a single step. Otherwise it is merely plausible.
    if n >= 2 and obs["has_read_before_write"]:
        traj = 1.0
    elif n >= 2:
        traj = 0.7
    else:
        traj = 0.6

    # acceptance_criteria_satisfaction — proxy: how many criteria share
    # significant vocabulary with the intent + produced outputs. Floored so a
    # legitimate run is never tanked by keyword mismatch alone.
    corpus = _significant_words(contract.intent + " " + " ".join(map(str, obs["outputs"])))
    crits = list(contract.acceptance_criteria)
    if crits:
        covered = 0
        for c in crits:
            if _significant_words(c) & corpus:
                covered += 1
        coverage = covered / len(crits)
    else:
        coverage = 1.0
    acc = 0.7 + 0.3 * coverage

    return {
        "trajectory_sensibility": round(traj, 4),
        "tool_use_accuracy": round(tool, 4),
        "acceptance_criteria_satisfaction": round(acc, 4),
        "task_completion": round(completion, 4),
    }


def _aggregate(metrics: Dict[str, float]) -> float:
    vals = [metrics[name] for name in METRIC_NAMES]
    return round(sum(vals) / len(vals), 4)


# --------------------------------------------------------------------------
# The Tier-2 evaluation entry point
# --------------------------------------------------------------------------


def _use_deepeval(backend: Optional[str], env: Optional[Dict[str, str]] = None) -> bool:
    """Decide whether the OPT-IN DeepEval backend should handle Tier-2.

    Precedence: an explicit ``backend`` argument wins; otherwise the env flag
    ``SCPRISM_DEEPEVAL``. Default (arg None + flag unset) is False, so the
    stdlib judge below stays the unchanged default.
    """
    import os

    if backend is not None:
        return str(backend).strip().lower() == "deepeval"
    env = os.environ if env is None else env
    return str(env.get("SCPRISM_DEEPEVAL", "")).strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def evaluate(
    contract,
    trace,
    *,
    gateway,
    artifact: str = "",
    envelope: Optional[Envelope] = None,
    threshold: float = DEFAULT_THRESHOLD,
    telemetry=None,
    parent_id: Optional[str] = None,
    latency_ms: Optional[float] = None,
    backend: Optional[str] = None,
    run_evidence: Optional[RunEvidence] = None,
) -> Tier2Result:
    """Run the real Tier-2 judge over a trace and gate on score + envelope.

    ``run_evidence`` (optional, ``build_evidence``) is the MEASURED record of
    what the run produced — the files on disk and the real Tier-1 outcome. When
    supplied it goes into the judge prompt, so "did it implement the thing?" is
    asked of a judge that can see whether it did, and any judge claim the
    evidence disproves is recorded on ``Tier2Result.contradictions``. Omitted
    (the default) the prompt is unchanged apart from the harness naming its own
    truncations out loud.

    The judge model is reached ONLY through ``gateway.model_call`` (invariant).
    Offline, the gateway's deterministic stub yields an unparseable response,
    so scoring falls back to the deterministic heuristic — still reproducible,
    still routed through the gateway (so the call is audited and its tokens are
    counted). Returns a fully-populated ``Tier2Result``.

    Backend selection (OPT-IN, default unchanged): when ``backend="deepeval"``
    or ``$SCPRISM_DEEPEVAL`` is truthy AND ``deepeval`` is importable, Tier-2 is
    handled by the DeepEval backend (its judge still routes through THIS
    gateway). If DeepEval is requested but not importable, we silently fall
    through to the stdlib judge below — the default path is never broken.
    """
    if gateway is None:  # defensive: never let Tier-2 bypass the gateway
        raise ValueError("evaluate() requires a gateway — the judge must route through it")

    if _use_deepeval(backend):
        from . import deepeval_backend  # lazy: never imported on the default path

        if deepeval_backend.deepeval_available():
            return deepeval_backend.run_deepeval(
                contract,
                trace,
                gateway=gateway,
                artifact=artifact,
                envelope=envelope,
                threshold=threshold,
                telemetry=telemetry,
                parent_id=parent_id,
                latency_ms=latency_ms,
                run_evidence=run_evidence,
            )
        # Requested but unavailable in this interpreter -> stdlib judge (default).

    obs = observe_trace(trace)
    if not artifact:
        artifact = "\n".join(
            str(o) for o, k in zip(obs["outputs"], obs["kinds"]) if k == "write"
        ) or "\n".join(map(str, obs["outputs"]))

    messages = _build_judge_messages(contract, obs, artifact, evidence=run_evidence)
    decision = gateway.route(messages[-1]["content"])  # gateway is authoritative

    def _call():
        return gateway.model_call(messages, decision)

    if telemetry is not None:
        with telemetry.span(
            "eval",
            span_type="model_call",
            parent=parent_id,
            provider=decision.provider,
            model=decision.model,
            route=decision.target,
            is_local=decision.is_local,
        ) as sp:
            res = _call()
            sp.set(
                tokens_in=res.tokens_in,
                tokens_out=res.tokens_out,
                is_real=res.is_real,
                truncated=res.truncated,
            )
    else:
        res = _call()

    # Parse a real judge verdict; else fall back to the deterministic scorer.
    parsed = _parse_judge_response(res.text)
    if parsed is not None:
        notes = parsed.pop("_notes", "")
        metrics = parsed
        source = "llm-judge"
    else:
        metrics = heuristic_metrics(contract, obs)
        notes = "offline deterministic fallback (no parseable judge verdict)"
        source = "offline-heuristic"

    eval_score = _aggregate(metrics)

    env = envelope if envelope is not None else build_envelope(contract, latency_ms=latency_ms)
    env_report = check_envelope(
        env,
        tokens_spent=obs["tokens_spent"],
        steps=obs["steps"],
        latency_ms=latency_ms,
    )

    score_ok = eval_score >= threshold
    passed = score_ok and env_report.ok

    reason_bits = [f"score={eval_score} vs threshold={threshold} -> {'ok' if score_ok else 'BELOW'}"]
    if not env_report.ok:
        reason_bits.append("envelope BREACH: " + "; ".join(env_report.breaches))
    else:
        reason_bits.append("envelope ok")

    # A judge claim the deterministic layer measured to be false is a JUDGE
    # ERROR. It is named here, in the notes the UI reads, rather than being
    # quietly folded into a failing score.
    contradictions = detect_contradictions(metrics, notes, run_evidence)
    if contradictions:
        reason_bits.append(
            "JUDGE ERROR — contradicted by deterministic evidence: "
            + "; ".join(contradictions)
        )
    judge_notes = f"[{source}] {notes} | " + " | ".join(reason_bits)

    return Tier2Result(
        ran=True,
        score=eval_score,
        eval_score=eval_score,
        metrics=metrics,
        threshold=threshold,
        passed=passed,
        envelope_ok=env_report.ok,
        breaches=list(env_report.breaches),
        envelope=env_report.envelope,
        observed=env_report.observed,
        tokens=res.tokens,
        is_real=res.is_real,
        judge_notes=judge_notes,
        rationale=judge_notes,
        contradictions=contradictions,
    )
