"""GRPO training-record seam (specs/10, ADR-017) — the SEAM ONLY.

The "falling cost" moat requires the local model to improve from SC Prism's own
verified outcomes: every Verdict is training data (ADR-017). This module ships
the *seam* the spec calls for now — a training record emitted on each Stop-hook
PASS — while the actual GRPO fine-tune pipeline stays DEFERRED to tranche T6
(specs/10 §6). Records accumulate; no fine-tuning runs here.

What "the seam" means concretely:

  * On a Stop-hook PASS (Tier-1 passed AND Tier-2 passed AND nothing blocked)
    the loop emits exactly ONE complete training record, appended to
    ``<vault>/training/records.jsonl``. A FAIL (Tier-1 or Tier-2) emits nothing.
  * Each record is fully derivable from execution truth — the Verdict + the
    contract + the run's spans — so it is *provable from spans/verdict* (specs/10
    §7 acceptance: "every passing task can emit a complete training record").
  * The record carries the **reward** the future GRPO step would optimise, using
    the reward-function sketch from specs/10 §3:

        reward = w1 * tier1_pass            # tests/lint/build green
               + w2 * tier2_eval_score      # trajectory / tool-use / criteria
               + w3 * envelope_efficiency   # (budget - tokens_used)/budget
               - penalty * hook_blocks      # tried something the harness stopped

    The reward is **computed, not applied**: ``reward.applied`` is always False.
    GRPO consumes it later; here it is only recorded (specs/10 §2, §6).

Weights start conservative (specs/10 §3 — "tune weights from data") and are
recorded in every record so a later training run knows which generation produced
each reward. Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Canonical relative location of the training log inside a vault.
TRAINING_RELPATH = os.path.join("training", "records.jsonl")

# Schema tag so a later reader can migrate old records.
SCHEMA = "scprism.training.v1"

# The reward sketch, written down verbatim so the record is self-describing.
REWARD_FORMULA = (
    "w1*tier1_pass + w2*tier2_eval_score + w3*envelope_efficiency "
    "- penalty*hook_blocks"
)

# Honest seam note carried on every record + reward block.
SEAM_NOTE = (
    "training-record SEAM only (ADR-017, specs/10 §6): records accumulate; "
    "no fine-tuning runs. Reward is COMPUTED, not applied."
)


@dataclass(frozen=True)
class RewardWeights:
    """Weights for the specs/10 §3 reward. Start conservative; tune from data.

    Recorded in every training record so a promoted model version can be traced
    back to the reward generation that justified it (specs/10 §5).
    """

    w1: float = 0.4     # tier1_pass (deterministic truth gate)
    w2: float = 0.4     # tier2 eval score (trajectory / tool-use / criteria)
    w3: float = 0.2     # envelope efficiency (the "cheap and direct" term)
    penalty: float = 0.25   # per hook block (tried something the harness stopped)

    def to_dict(self) -> Dict[str, float]:
        return {"w1": self.w1, "w2": self.w2, "w3": self.w3, "penalty": self.penalty}


DEFAULT_WEIGHTS = RewardWeights()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def envelope_efficiency(tokens_spent: int, token_budget: Optional[int]) -> float:
    """``(budget - tokens_used) / budget``, clamped to [0, 1] (specs/10 §3).

    This is the term that turns "correct" into "cheap": a run that finished well
    under budget scores near 1.0; one that burned the whole budget scores 0.0.
    A missing / non-positive budget yields 0.0 (nothing to be efficient against).
    """
    if not token_budget or token_budget <= 0:
        return 0.0
    eff = (float(token_budget) - float(tokens_spent)) / float(token_budget)
    if eff < 0.0:
        return 0.0
    if eff > 1.0:
        return 1.0
    return round(eff, 6)


@dataclass
class Reward:
    """The computed (not applied) reward for one verified outcome."""

    tier1_pass: float
    tier2_score: float
    envelope_efficiency: float
    hook_blocks: int
    weights: RewardWeights
    value: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tier1_pass": self.tier1_pass,
            "tier2_score": self.tier2_score,
            "envelope_efficiency": self.envelope_efficiency,
            "hook_blocks": self.hook_blocks,
            "weights": self.weights.to_dict(),
            "value": self.value,
            "formula": REWARD_FORMULA,
            "applied": False,  # SEAM: computed only, never applied here.
            "note": SEAM_NOTE,
        }


def compute_reward(
    *,
    tier1_pass: bool,
    tier2_score: float,
    tokens_spent: int,
    token_budget: Optional[int],
    hook_blocks: int,
    weights: Optional[RewardWeights] = None,
) -> Reward:
    """Compute the specs/10 §3 reward. Deterministic; nothing is applied."""
    w = weights or DEFAULT_WEIGHTS
    t1 = 1.0 if tier1_pass else 0.0
    t2 = float(tier2_score)
    eff = envelope_efficiency(tokens_spent, token_budget)
    blocks = int(hook_blocks)
    value = round(
        w.w1 * t1 + w.w2 * t2 + w.w3 * eff - w.penalty * blocks, 6
    )
    return Reward(
        tier1_pass=t1,
        tier2_score=round(t2, 6),
        envelope_efficiency=eff,
        hook_blocks=blocks,
        weights=w,
        value=value,
    )


def should_emit(verdict: Any, stop_compliant: bool) -> bool:
    """Emit iff this is a Stop-hook PASS with Tier-1 AND Tier-2 passed.

    ``verdict.passed`` already folds in Tier-1 pass, Tier-2 pass, no unresolved
    block, and no rejected write; ``stop_compliant`` is the Stop ratchet's own
    verdict. Both must hold — a Tier-1 or Tier-2 FAIL emits no record (specs/10
    §1: the flywheel only ingests verified outcomes).
    """
    return bool(stop_compliant) and bool(getattr(verdict, "passed", False))


def _trajectory_from_spans(spans_path: str, task_id: str) -> List[str]:
    """Ordered step names for this task's run(s), read from spans.jsonl.

    Mirrors ``evidence.reconstruct``: find the run span(s) for ``task_id``, keep
    only their spans, order by start time, return the names. Empty list if the
    span file is absent/unreadable (the caller falls back to hooks_fired).
    """
    if not spans_path or not os.path.exists(spans_path):
        return []
    try:
        from .telemetry import read_spans

        spans = read_spans(spans_path)
    except Exception:
        return []
    run_ids = {
        s.get("run_id")
        for s in spans
        if s.get("type") == "run"
        and s.get("attrs", {}).get("task_id") == task_id
    }
    if not run_ids:
        return []
    mine = [s for s in spans if s.get("run_id") in run_ids]
    mine.sort(key=lambda s: s.get("start", 0.0))
    return [str(s.get("name", "")) for s in mine]


def build_record(
    contract: Any,
    verdict: Any,
    *,
    stop_compliant: bool,
    steps: Optional[int] = None,
    weights: Optional[RewardWeights] = None,
) -> Dict[str, Any]:
    """Assemble one complete training record from execution truth.

    Everything is derived from the Verdict + contract (+ the run's spans, for the
    trajectory), so the record can never disagree with what actually ran — the
    same "governance is a read of execution truth" invariant the evidence spine
    holds. Shape: ``{inputs, task_intent, tools_used, trajectory, final_verdict,
    reward{...}, tokens_spent, steps, timestamp}`` (specs/10 §1).
    """
    tier1 = dict(getattr(verdict, "tier1", {}) or {})
    tier2 = dict(getattr(verdict, "tier2", {}) or {})
    tier1_pass = bool(tier1.get("passed", False))
    tier2_pass = bool(tier2.get("passed", False))
    tier2_score = float(tier2.get("eval_score", tier2.get("score", 0.0)) or 0.0)

    hooks_fired = list(getattr(verdict, "hooks_fired", []) or [])
    model_route = list(getattr(verdict, "model_route", []) or [])
    blocks = list(getattr(verdict, "blocks", []) or [])
    tokens_spent = int(getattr(verdict, "tokens_spent", 0) or 0)
    task_id = str(getattr(verdict, "task_id", "") or "")
    spans_path = str(getattr(verdict, "spans_path", "") or "")

    token_budget = int(getattr(contract, "token_budget", 0) or 0)

    reward = compute_reward(
        tier1_pass=tier1_pass,
        tier2_score=tier2_score,
        tokens_spent=tokens_spent,
        token_budget=token_budget,
        hook_blocks=len(blocks),
        weights=weights,
    )

    trajectory = _trajectory_from_spans(spans_path, task_id) or hooks_fired

    if steps is None:
        # Fall back to the observed step count the Tier-2 envelope recorded.
        observed = dict(tier2.get("observed", {}) or {})
        steps = int(observed.get("steps", len(model_route)) or 0)

    return {
        "schema": SCHEMA,
        "task_id": task_id,
        "timestamp": str(getattr(verdict, "timestamp", "") or "") or _now_iso(),
        # inputs — the task as handed to the loop.
        "inputs": {
            "intent": str(getattr(contract, "intent", "") or ""),
            "acceptance_criteria": list(
                getattr(contract, "acceptance_criteria", []) or []
            ),
            "scope": list(getattr(contract, "scope", []) or []),
            "mode": str(getattr(contract, "mode", "") or ""),
            "token_budget": token_budget,
            "max_turns": int(getattr(contract, "max_turns", 0) or 0),
        },
        "task_intent": str(getattr(contract, "intent", "") or ""),
        # tools_used — the model routes/tools the dispatch actually used.
        "tools_used": model_route,
        # trajectory — the ordered step names (from spans; hooks as fallback).
        "trajectory": trajectory,
        "final_verdict": {
            "passed": bool(getattr(verdict, "passed", False)),
            "tier1_passed": tier1_pass,
            "tier2_passed": tier2_pass,
            "eval_score": round(tier2_score, 6),
            "tier1": tier1,
            "tier2": tier2,
            "stop_compliant": bool(stop_compliant),
        },
        "reward": reward.to_dict(),
        "tokens_spent": tokens_spent,
        "steps": int(steps or 0),
        "seam": True,
        "note": SEAM_NOTE,
    }


def emit_record(record: Dict[str, Any], vault: str, *, path: Optional[str] = None) -> str:
    """Append one training record to ``<vault>/training/records.jsonl``.

    Append-only, like the audit spine: records accumulate for a future GRPO run.
    Returns the path written to. Creates the ``training/`` directory as needed.
    """
    out_path = path or os.path.join(vault, TRAINING_RELPATH)
    directory = os.path.dirname(os.path.abspath(out_path)) or "."
    os.makedirs(directory, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with open(out_path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    return out_path


def read_records(vault: str, *, path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Read accumulated training records back (empty list if none yet)."""
    in_path = path or os.path.join(vault, TRAINING_RELPATH)
    if not os.path.exists(in_path):
        return []
    out: List[Dict[str, Any]] = []
    with open(in_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if raw:
                out.append(json.loads(raw))
    return out


def record_pass(
    contract: Any,
    verdict: Any,
    *,
    vault: str,
    stop_compliant: bool,
    steps: Optional[int] = None,
    weights: Optional[RewardWeights] = None,
    path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """The seam entry point the loop calls after building the Verdict.

    Emits exactly one complete training record IFF this was a Stop-hook PASS
    (Tier-1 + Tier-2 passed, nothing blocked); otherwise returns None and writes
    nothing. Returns the record dict on emit (with ``_path`` set) so a caller can
    prove exactly one was emitted. Best-effort by contract of the caller — the
    seam must never take the loop down.
    """
    if not should_emit(verdict, stop_compliant):
        return None
    record = build_record(
        contract, verdict, stop_compliant=stop_compliant, steps=steps, weights=weights
    )
    written = emit_record(record, vault, path=path)
    record = dict(record)
    record["_path"] = written
    return record
