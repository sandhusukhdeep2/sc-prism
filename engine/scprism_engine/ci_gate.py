"""CI gate — the score-based deployment gate (specs/06 §4, ADR-013/022).

The single biggest separator between vibe coding and agentic engineering is how
output gets verified. This module is the gate: it runs the golden suite +
operating envelopes and, when a build scores below threshold, **blocks** — it
returns a block, it does not raise. A regression is stopped by the gate, not
caught in production.

Two gates (ADR-022):

  * **Pre-deploy (CI, blocking).** ``run_gate(goldens, threshold, envelopes)``
    runs every golden through the real loop and blocks if any expected-pass
    golden regresses below threshold or breaches its envelope.
  * **Post-deploy (continuous, sampled).** ``sample_traces`` is the sampling
    strategy stub — *oversample high-risk intents* so "strategically sampled"
    doesn't rot into a random 1%.

Stop-hook wiring: ``CIGate`` builds a ratchet for the loop's Stop hook. Before a
task is declared done, the gate runs against the relevant goldens; below
threshold the ratchet returns non-compliant → the Stop hook blocks the write and
the task routes to repair. Goldens execute in an isolated scratch vault so the
gate never pollutes the live run's evidence/spans (and never recurses).

Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import dataclasses
import hashlib
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .evals import DEFAULT_THRESHOLD, Envelope
from .gateway import Gateway
from .goldens import Golden, GoldenResult, load_goldens, run_golden


@dataclass
class GateResult:
    """Outcome of a CI gate run (specs/06 §4).

    ``blocked`` is the operative field: True means the build must not ship /
    the task must not be declared done. Nothing raises — a gate returns a
    decision so the caller (CI or the Stop hook) routes to repair.
    """

    passed: bool
    blocked: bool
    threshold: float
    scores: Dict[str, float] = field(default_factory=dict)
    results: List[Dict[str, Any]] = field(default_factory=list)
    blockers: List[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "blocked": self.blocked,
            "threshold": self.threshold,
            "scores": self.scores,
            "results": self.results,
            "blockers": self.blockers,
            "reason": self.reason,
        }


def _apply_overrides(
    golden: Golden,
    *,
    threshold: Optional[float],
    envelope: Optional[Any],
) -> Golden:
    """Return a copy of ``golden`` with gate-level threshold/envelope overrides."""
    changes: Dict[str, Any] = {}
    if threshold is not None:
        changes["threshold"] = float(threshold)
    if envelope is not None:
        env = envelope.to_dict() if isinstance(envelope, Envelope) else dict(envelope)
        changes["envelope"] = env
    return dataclasses.replace(golden, **changes) if changes else golden


def run_gate(
    goldens: Optional[List[Golden]] = None,
    threshold: Optional[float] = None,
    envelopes: Optional[Dict[str, Any]] = None,
    *,
    vault: Optional[str] = None,
    gateway: Optional[Gateway] = None,
    directory: Optional[str] = None,
) -> GateResult:
    """Run the golden suite + envelopes as a score-based gate.

    Args:
        goldens: goldens to run; ``None`` loads the seed suite from ``directory``.
        threshold: gate-wide score threshold override (applied to every golden);
            ``None`` keeps each golden's own threshold.
        envelopes: optional ``{golden_id: Envelope | dict}`` per-golden envelope
            overrides (the runaway-cost gate, specs/06 §3).
        vault: where goldens execute; ``None`` uses an isolated temp vault so the
            gate never touches a live vault.
        gateway: model gateway (offline stub by default → deterministic scores).

    Returns:
        A ``GateResult``. ``blocked=True`` when any expected-pass golden scores
        below threshold, breaches its envelope, or otherwise fails its
        expectation. Below threshold **blocks**; it never raises.
    """
    goldens = goldens if goldens is not None else load_goldens(directory)
    envelopes = envelopes or {}

    owns_vault = vault is None
    tmp: Optional[tempfile.TemporaryDirectory] = None
    if owns_vault:
        tmp = tempfile.TemporaryDirectory(prefix="scprism-cigate-")
        vault = tmp.name

    scores: Dict[str, float] = {}
    results: List[Dict[str, Any]] = []
    blockers: List[str] = []

    try:
        for g in goldens:
            eff = _apply_overrides(
                g, threshold=threshold, envelope=envelopes.get(g.id)
            )
            gr: GoldenResult = run_golden(eff, vault=vault, gateway=gateway)
            scores[g.id] = gr.eval_score
            results.append(gr.to_dict())

            gate_threshold = eff.threshold
            # A golden blocks the gate when it was expected to pass but did not:
            # score below threshold, an envelope breach, or a failed verdict.
            if eff.expect_pass:
                if not gr.passed:
                    if gr.eval_score < gate_threshold:
                        blockers.append(
                            f"{g.id}: score {gr.eval_score:.3f} < "
                            f"threshold {gate_threshold:.3f}"
                        )
                    elif not gr.envelope_ok:
                        blockers.append(f"{g.id}: envelope breach")
                    else:
                        blockers.append(f"{g.id}: expected pass but verdict failed")
            else:
                # An expected-fail golden that now passes is also a regression in
                # the gate's guarantees (a guardrail stopped guarding).
                if gr.passed:
                    blockers.append(f"{g.id}: expected fail but passed")
    finally:
        if tmp is not None:
            tmp.cleanup()

    blocked = bool(blockers)
    eff_threshold = float(threshold) if threshold is not None else DEFAULT_THRESHOLD
    reason = (
        "gate PASS: every golden met its bar"
        if not blocked
        else "gate BLOCK: " + "; ".join(blockers)
    )
    return GateResult(
        passed=not blocked,
        blocked=blocked,
        threshold=eff_threshold,
        scores=scores,
        results=results,
        blockers=blockers,
        reason=reason,
    )


class CIGate:
    """A configured gate wireable into the loop's Stop hook (specs/06 §4).

    Holds the goldens + threshold once so the Stop ratchet can call it at the
    "done" moment. Goldens run in an isolated scratch vault (fresh per gate run)
    so the gate never pollutes the live run's evidence/spans and never recurses
    into itself.
    """

    def __init__(
        self,
        *,
        goldens: Optional[List[Golden]] = None,
        threshold: Optional[float] = None,
        envelopes: Optional[Dict[str, Any]] = None,
        gateway: Optional[Gateway] = None,
        directory: Optional[str] = None,
    ) -> None:
        self.goldens = goldens
        self.threshold = threshold
        self.envelopes = envelopes or {}
        self.gateway = gateway
        self.directory = directory
        self.last_result: Optional[GateResult] = None

    def run(self, *, vault: Optional[str] = None) -> GateResult:
        self.last_result = run_gate(
            self.goldens,
            self.threshold,
            self.envelopes,
            vault=vault,
            gateway=self.gateway,
            directory=self.directory,
        )
        return self.last_result

    def ratchet(self) -> Callable[[Dict[str, Any]], bool]:
        """A Stop-hook ratchet: compliant iff Tier-1 passed, nothing was
        blocked, AND the CI gate passes. Below threshold → not compliant → the
        Stop hook blocks the write and routes to repair (specs/06 §4)."""

        def _ratchet(ctx: Dict[str, Any]) -> bool:
            base = bool(ctx.get("tier1_passed", False)) and not ctx.get("blocks")
            if not base:
                return False
            result = self.run()
            return result.passed

        return _ratchet


# --------------------------------------------------------------------------
# Post-deploy sampling strategy (ADR-022) — the stub, written down so
# "strategically sampled" cannot rot into a random 1%.
# --------------------------------------------------------------------------

# Intents that get oversampled post-deploy: anything touching governance,
# secrets, production, or irreversible action is high-risk and read more often.
HIGH_RISK_INTENTS = (
    "prod",
    "production",
    "delete",
    "drop",
    "auth",
    "credential",
    "secret",
    "permission",
    "governance",
    "rule",
    "payment",
    "billing",
    "migrate",
)


def is_high_risk(intent: str, high_risk: Optional[List[str]] = None) -> bool:
    low = (intent or "").lower()
    return any(k in low for k in (high_risk or HIGH_RISK_INTENTS))


def _deterministic_bucket(key: str) -> float:
    """Stable [0,1) value from a key — a reproducible stand-in for random()."""
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def sample_traces(
    traces: List[Dict[str, Any]],
    *,
    base_rate: float = 0.1,
    high_risk_rate: float = 1.0,
    high_risk: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Post-deploy sampling: oversample high-risk intents (ADR-022).

    Each trace is selected with probability ``high_risk_rate`` if its intent is
    high-risk, else ``base_rate``. Selection is deterministic (hash-bucketed on
    the trace's task_id/intent) so the sampled slice is reproducible and
    auditable — not a random 1% that drifts. Every trace carries the reason it
    was (over)sampled.
    """
    selected: List[Dict[str, Any]] = []
    for t in traces:
        intent = str(t.get("intent", ""))
        key = str(t.get("task_id", "")) + "|" + intent
        risky = is_high_risk(intent, high_risk)
        rate = high_risk_rate if risky else base_rate
        if _deterministic_bucket(key) < rate:
            selected.append({
                **t,
                "_sampled": True,
                "_sample_reason": "high-risk oversample" if risky else "baseline sample",
                "_high_risk": risky,
            })
    return selected
