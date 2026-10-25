"""Golden datasets — trusted inputs paired with ideal trajectories/outcomes.

Goldens are the foundation of regression testing (specs/06 §2). Because a
golden is decoupled from any single run, you can re-run the same golden across
model versions and SC Prism iterations, generating a fresh output each time and
re-scoring it — that is what makes regression testing work.

A golden carries:
  * ``intent`` + ``acceptance_criteria`` + ``scope`` + ``mode`` — the contract.
  * ``tier1_commands`` — deterministic checks to run (kept offline-safe, e.g.
    ``true`` / ``exit 0``, so goldens run with no network or toolchain).
  * ``envelope`` — token/step/latency operating limits (specs/06 §3).
  * ``threshold`` — the score gate for this golden.
  * ``ideal_trajectory`` / ``ideal_outcome`` — the annotated ground truth.
  * ``expect_pass`` — whether a healthy engine should PASS this golden.

``run_golden`` runs a golden through the REAL loop (plan → dispatch → Tier-1 →
Tier-2 judge via the gateway → verdict) and scores it, so goldens are
re-runnable across engine versions. Seed goldens live in ``engine/goldens/``.
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .contract import TaskContract
from .evals import Envelope, DEFAULT_THRESHOLD
from .gateway import Gateway
from .loop import run
from .telemetry import Telemetry
from .writeback import Verdict

# Default location of the seed golden datasets (engine/goldens/*.json).
GOLDENS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "goldens"
)


class GoldenError(ValueError):
    """Raised when a golden dataset fails to load or validate."""


@dataclass
class Golden:
    """One trusted input paired with its ideal trajectory/outcome."""

    id: str
    intent: str
    acceptance_criteria: List[str] = field(default_factory=list)
    scope: List[str] = field(default_factory=list)
    mode: str = "write"
    token_budget: int = 100_000
    max_turns: int = 8
    tier1_commands: List[str] = field(default_factory=list)
    envelope: Dict[str, Any] = field(default_factory=dict)
    threshold: float = DEFAULT_THRESHOLD
    ideal_trajectory: List[str] = field(default_factory=list)
    ideal_outcome: str = ""
    expect_pass: bool = True

    def validate(self) -> "Golden":
        if not self.id or not str(self.id).strip():
            raise GoldenError("golden id must be non-empty")
        if not self.intent or not str(self.intent).strip():
            raise GoldenError(f"golden {self.id!r}: intent must be non-empty")
        if self.mode not in ("read", "write"):
            raise GoldenError(f"golden {self.id!r}: mode must be read|write")
        if not isinstance(self.acceptance_criteria, list):
            raise GoldenError(f"golden {self.id!r}: acceptance_criteria must be a list")
        if not isinstance(self.tier1_commands, list):
            raise GoldenError(f"golden {self.id!r}: tier1_commands must be a list")
        if not (0.0 <= float(self.threshold) <= 1.0):
            raise GoldenError(f"golden {self.id!r}: threshold must be in [0,1]")
        return self

    def to_contract(self) -> TaskContract:
        """Build the (validated) TaskContract this golden represents."""
        return TaskContract(
            task_id=f"golden-{self.id}",
            intent=self.intent,
            acceptance_criteria=list(self.acceptance_criteria),
            scope=list(self.scope),
            mode=self.mode,
            token_budget=int(self.token_budget),
            max_turns=int(self.max_turns),
        ).validate()

    def to_envelope(self) -> Envelope:
        """Build the operating envelope. Missing keys fall back to the
        contract's hard caps so every golden is gated on something."""
        env = self.envelope or {}
        return Envelope(
            token_budget=env.get("token_budget", int(self.token_budget)),
            max_steps=env.get("max_steps", int(self.max_turns)),
            latency_ms=env.get("latency_ms"),
        )


def load_golden(path: str) -> Golden:
    """Load and validate a single golden JSON file."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise GoldenError(f"{path}: golden must be a JSON object")
    known = {f for f in Golden.__dataclass_fields__}  # type: ignore[attr-defined]
    unknown = set(data) - known
    if unknown:
        raise GoldenError(f"{path}: unknown golden keys {sorted(unknown)}")
    return Golden(**data).validate()


def load_goldens(directory: Optional[str] = None) -> List[Golden]:
    """Load every ``*.json`` golden in a directory (sorted by id)."""
    directory = directory or GOLDENS_DIR
    paths = sorted(glob.glob(os.path.join(directory, "*.json")))
    goldens = [load_golden(p) for p in paths]
    goldens.sort(key=lambda g: g.id)
    return goldens


@dataclass
class GoldenResult:
    """Outcome of running one golden through the real loop."""

    golden_id: str
    passed: bool
    tier1_passed: bool
    tier2_ran: bool
    envelope_ok: bool
    eval_score: float
    metrics: Dict[str, float]
    expect_pass: bool
    matched_expectation: bool
    verdict: Verdict

    def to_dict(self) -> Dict[str, Any]:
        return {
            "golden_id": self.golden_id,
            "passed": self.passed,
            "tier1_passed": self.tier1_passed,
            "tier2_ran": self.tier2_ran,
            "envelope_ok": self.envelope_ok,
            "eval_score": self.eval_score,
            "metrics": self.metrics,
            "expect_pass": self.expect_pass,
            "matched_expectation": self.matched_expectation,
        }


def run_golden(
    golden: Golden,
    *,
    vault: str,
    gateway: Optional[Gateway] = None,
    telemetry: Optional[Telemetry] = None,
) -> GoldenResult:
    """Run one golden through the REAL loop and score it.

    Deterministic + offline-safe: with no provider configured the gateway's
    stub drives a deterministic judge, so re-running the same golden yields the
    same score — that is the regression guarantee.
    """
    golden.validate()
    contract = golden.to_contract()
    envelope = golden.to_envelope()

    verdict = run(
        contract,
        vault=vault,
        tier1_commands=list(golden.tier1_commands),
        gateway=gateway,
        telemetry=telemetry,
        eval_threshold=float(golden.threshold),
        envelope=envelope,
    )

    t2 = verdict.tier2 if isinstance(verdict.tier2, dict) else {}
    tier2_ran = bool(t2.get("ran"))
    eval_score = float(t2.get("eval_score", t2.get("score", 0.0)) or 0.0)
    metrics = dict(t2.get("metrics", {}) or {})
    envelope_ok = bool(t2.get("envelope_ok", True))
    tier1_passed = bool(verdict.tier1.get("passed"))

    matched = verdict.passed == bool(golden.expect_pass)

    return GoldenResult(
        golden_id=golden.id,
        passed=verdict.passed,
        tier1_passed=tier1_passed,
        tier2_ran=tier2_ran,
        envelope_ok=envelope_ok,
        eval_score=eval_score,
        metrics=metrics,
        expect_pass=bool(golden.expect_pass),
        matched_expectation=matched,
        verdict=verdict,
    )


def run_all_goldens(
    *,
    vault: str,
    directory: Optional[str] = None,
    gateway: Optional[Gateway] = None,
) -> List[GoldenResult]:
    """Run the whole golden suite (the score-based CI gate, specs/06 §4)."""
    results = []
    for g in load_goldens(directory):
        results.append(run_golden(g, vault=vault, gateway=gateway))
    return results
