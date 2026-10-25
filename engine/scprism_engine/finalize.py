"""The reusable governance tail, extracted from `loop.run` (byte-identical).

Two helpers, split so the loop can preserve its EXACT original execution order
(tier1 -> tier2 -> stop -> writeback) while a team-governance path (TG-2) reuses
the same pieces:

  * `run_tier2(...)`  — the Tier-2 step: build the operating envelope, run the
    judge (`evals.evaluate`, or an injected test-double), with the same Tier-1
    short-circuit (returns ``None`` without judging when Tier-1 FAILED, emitting
    no `tier2` span and leaving `"tier2"` out of `hooks_fired`). Emitted at the
    loop's ORIGINAL Tier-2 position, so `"tier2"` is appended before `"stop"`.

  * `finalize_run(...)` — given the already-computed `tier2_result`, do only:
    `build_verdict` -> `write_verdict` + artifacts-append (the `verdict` span) ->
    `training.record_pass` (best-effort, the `training` span). Returns the
    Verdict. It does NOT run Tier-2 (that is `run_tier2`, called earlier) and it
    does NOT append the evidence record — the audit append must run AFTER the
    root run span has flushed to spans.jsonl (so the training trajectory it
    reads matches the original), which is a caller responsibility outside the
    run-span context. See loop.run for the exact wiring.

This module is pure glue over already-standalone helpers (evals / writeback /
training) — it reproduces the loop's tail without changing behavior.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import evals
from .evals import Envelope
from .writeback import build_verdict, write_verdict, Verdict
from .verifier import Tier1Result, Tier2Result
from . import training
from .training import RewardWeights


def run_tier2(
    contract,
    trace,
    *,
    tier1_passed: bool,
    gateway,
    telemetry,
    parent_id: str,
    envelope: Optional[Envelope] = None,
    threshold: float = evals.DEFAULT_THRESHOLD,
    latency_ms: Optional[float] = None,
    judge=None,
    hooks_fired: Optional[List[str]] = None,
    run_evidence: Optional["evals.RunEvidence"] = None,
) -> Optional[Tier2Result]:
    """Tier-2 — only if Tier-1 passed (short-circuit).

    The real judge routes through the gateway (`evals.evaluate`) and gates on
    BOTH the score threshold and the operating envelope. A caller may inject a
    judge (test double); otherwise we build the gateway judge. On a Tier-1 fail
    this returns ``None`` WITHOUT calling the judge — no `tier2` span, and
    `"tier2"` is never appended to `hooks_fired` — exactly as the inline loop did.

    `run_evidence` (`evals.build_evidence`) is the measured record of what the
    run produced — files on disk + the real Tier-1 outcome. It is passed into
    the judge prompt so the judge can SEE the artifact it is being asked about;
    without it the judge scores a trace summary and can only guess. Default
    ``None`` keeps every existing caller's prompt shape.
    """
    env = envelope if envelope is not None else evals.build_envelope(contract)
    t2: Optional[Tier2Result] = None
    if tier1_passed:
        with telemetry.span("tier2", span_type="verdict", parent=parent_id) as t2s:
            if hooks_fired is not None:
                hooks_fired.append("tier2")
            if judge is not None:
                t2 = judge(trace)
            else:
                t2 = evals.evaluate(
                    contract,
                    trace,
                    gateway=gateway,
                    envelope=env,
                    threshold=threshold,
                    telemetry=telemetry,
                    parent_id=t2s.span_id,
                    latency_ms=latency_ms,
                    run_evidence=run_evidence,
                )
            t2s.set(
                score=t2.score,
                eval_score=getattr(t2, "eval_score", t2.score),
                metrics=getattr(t2, "metrics", {}),
                passed=t2.passed,
                threshold=t2.threshold,
                envelope_ok=getattr(t2, "envelope_ok", True),
                breaches=getattr(t2, "breaches", []),
                tokens=t2.tokens,
                # Claims the judge made that the deterministic layer disproved.
                # Observability reads these: a judge that keeps erring about
                # facts is a measurable problem, not a vibe.
                contradictions=list(getattr(t2, "contradictions", []) or []),
            )
            if not t2.passed:
                t2s.set_status("error")
    # else: short-circuit — the Tier-2 model judge is intentionally NOT run.
    return t2


def finalize_run(
    *,
    contract,
    tier1_result: Tier1Result,
    tier2_result: Optional[Tier2Result],
    vault: str,
    telemetry,
    run_id: str,
    spans_path: str,
    tokens_spent: int,
    model_route: Optional[List[str]],
    models_used: Optional[List[str]],
    response: str,
    artifacts: Optional[List[str]],
    steps,
    stop_compliant: bool,
    cache_hits: int = 0,
    cache_misses: int = 0,
    record_training: bool = True,
    training_weights: Optional[RewardWeights] = None,
    hooks_fired: Optional[List[str]] = None,
    hook_decisions: Optional[List[dict]] = None,
    blocks: Optional[List[dict]] = None,
    approvals: Optional[List[dict]] = None,
    memory_injected: Optional[List[dict]] = None,
    disclosed: Optional[List[str]] = None,
    rejected_writes: Optional[List[dict]] = None,
    workflow_path: str = "",
    project_result: Optional[Dict[str, Any]] = None,
    model_route_reasons: Optional[List[str]] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> Verdict:
    """Build + persist the Verdict and emit the training record.

    `tier2_result` is the already-computed Tier-2 outcome (from `run_tier2`, or
    ``None`` on a Tier-1 short-circuit). Returns the persisted Verdict. If a
    `hooks_fired` list is passed it is mutated as the loop mutated its
    accumulator: `"writeback"` is appended when the verdict is built — so
    `build_verdict` sees the same final list the inline block saw.

    Does NOT run Tier-2 and does NOT append the evidence record (see module
    docstring): the audit append is a post-run-span caller step.

    `extras` are caller payloads merged onto `verdict.extras` BEFORE the verdict
    is written (e.g. project.py's refine-attempt record). They must be present at
    build time, not patched in afterwards: the log.md line and the first bytes on
    disk are written here, and a fact bolted on by a later re-persist is a fact
    the log never saw. `project_result` keeps its own dedicated slot and wins
    over any `extras["project"]` — that key belongs to the post_dispatch seam.
    """
    hooks_fired = [] if hooks_fired is None else hooks_fired
    t2 = tier2_result
    total_tokens = tokens_spent + (t2.tokens if t2 else 0)

    # 5. Verdict — build, validate, persist --------------------------
    with telemetry.span("verdict", span_type="verdict", parent=run_id) as vs:
        hooks_fired.append("writeback")
        verdict = build_verdict(
            task_id=contract.task_id,
            tier1_result=tier1_result,
            tier2_result=t2,
            tokens_spent=total_tokens,
            model_route=model_route,
            hooks_fired=hooks_fired,
            artifacts=artifacts,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
            spans_path=spans_path,
            hook_decisions=hook_decisions,
            blocks=blocks,
            approvals=approvals,
            memory_injected=memory_injected,
            disclosed=disclosed,
            rejected_writes=rejected_writes,
            workflow_path=workflow_path,
            response=response,
            models_used=models_used,
            model_route_reasons=model_route_reasons,
            # What this run actually put on disk. `build_verdict` needs it to
            # tell "the tests passed over real files and the reviewer dissented"
            # (outcome="attention") apart from "the run produced nothing and the
            # reviewer said so" (outcome="failed") — an empty run must never be
            # able to claim the softer outcome.
            produced_files=list((project_result or {}).get("files_written") or []),
            # The contract's mode, so a converse turn is recorded in a
            # conversation's words ("replied", or a reply-worded failure)
            # instead of a build's ("no files were produced").
            mode=str(getattr(contract, "mode", "") or ""),
        )
        for key, value in (extras or {}).items():
            if key != "project":
                verdict.extras[key] = value
        if project_result is not None:
            verdict.extras["project"] = project_result
        path = write_verdict(verdict, vault)
        verdict.artifacts = verdict.artifacts + [path]
        vs.set(
            passed=verdict.passed,
            # The three-valued truth alongside the boolean: observability and
            # the Console can then separate "the reviewer dissented over work
            # that builds and tests clean" from a genuine failure.
            outcome=verdict.outcome,
            outcome_reason=verdict.outcome_reason,
            tokens=verdict.tokens_spent,
            tier1_passed=tier1_result.passed,
            tier2_ran=bool(t2 and t2.ran),
            verdict_path=path,
            memory_injected=len(memory_injected or []),
            disclosed=disclosed or [],
            rejected_writes=len(rejected_writes or []),
        )

    # 5b. GRPO training-record seam (ADR-017, specs/10 — the SEAM ONLY).
    #     On a Stop-hook PASS (Tier-1 + Tier-2 passed, nothing blocked) emit
    #     exactly ONE complete training record to <vault>/training/records.jsonl
    #     with the reward COMPUTED (not applied). A Tier-1/Tier-2 FAIL emits
    #     nothing. Best-effort — the seam must never take the loop down.
    #
    #     A CONVERSE run emits nothing either, and the gate is the MODE, not
    #     `verdict.passed`: a replied turn carries passed=True precisely so the
    #     pass-gates downstream treat it as success, but the flywheel only
    #     ingests VERIFIED task work (specs/10 §1) — there is no tier-1
    #     evidence behind a reply, and rewarding one would teach the loop that
    #     chatting is task completion.
    if record_training and str(getattr(contract, "mode", "") or "") != "converse":
        with telemetry.span("training", span_type="hook", parent=run_id) as trs:
            emitted = None
            try:
                emitted = training.record_pass(
                    contract,
                    verdict,
                    vault=vault,
                    stop_compliant=stop_compliant,
                    steps=len(steps),
                    weights=training_weights,
                )
            except Exception:
                emitted = None
            trs.set(
                emitted=bool(emitted),
                stop_compliant=stop_compliant,
                reward=(emitted or {}).get("reward", {}).get("value")
                if emitted else None,
                path=(emitted or {}).get("_path", "") if emitted else "",
            )

    return verdict
