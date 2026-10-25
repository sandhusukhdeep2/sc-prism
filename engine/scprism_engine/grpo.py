"""GRPO training pipeline — the falling-cost flywheel (specs/10, ADR-017).

The moat is "provably done, on-prem, **at falling cost**." Falling cost only
happens if the local model improves from SC Prism's own verified outcomes over
time. ``training.py`` already ships the SEAM: every Stop-hook PASS appends a
reward-scored training record to ``<vault>/training/records.jsonl``. THIS module
is the periodic, offline consumer of that seam — the actual GRPO step (specs/10
§6: "build the seam early, defer the heavy fine-tune").

What this module provides (stdlib core, deterministic, offline):

  * ``load_records`` — read the accumulated records back (from the seam).
  * ``group_relative_advantages`` — GRPO's core. Group records by task_type /
    intent bucket and, **within each group**, normalise the logged reward into
    an advantage (per-group mean ~0, unit-ish scale). Normalising *within a
    group of comparable tasks* is exactly what makes this GRPO and not SFT: the
    model learns "which action earned more reward *among peers*," with no
    hand-labelled targets and no learned value critic — the group is the
    baseline (specs/10 §2).
  * ``Policy`` protocol + a REAL, tiny reference policy (``RoutePolicy``): a
    softmax over a small discrete decision set (route local-vs-cloud) with a
    real policy-gradient GRPO update. This makes the flywheel PROVABLE end to
    end in stdlib: train on records whose reward favours an action and that
    action's probability — and the policy's expected reward — measurably rise
    (``GRPOTrainer`` reports before/after).
  * ``GRPOTrainer`` — runs the group-relative update loop; returns the updated
    policy + metrics.
  * ``eval_lift_gate`` — run the goldens under baseline vs candidate; **promote
    only if lift AND no golden regresses** (ADR-017 / specs/10 §5). A fine-tune
    that regresses ANY golden is discarded and the previous weights stay.
  * ``promote_or_discard`` / ``ModelRegistry`` — versioned weights tied to the
    justifying eval run (a manifest), with rollback. Encryption-at-rest is a
    documented stub here (specs/10 §5: "encrypted and versioned like code").

HONESTY (specs/10 §6): the reference ``RoutePolicy`` proves the *mechanics* of
the flywheel in pure stdlib. The real neural fine-tune of a local LLM
(Unsloth / torch / trl) is the compute-gated FINAL step: it is wired here as an
import-guarded ``LLMPolicy`` behind ``$SCPRISM_GRPO_LLM=1`` and raises clearly
if the heavy libs / GPU / model are absent. This module never pip-installs ML
libraries and never attempts a real neural fine-tune — it wires the seam.
"""

from __future__ import annotations

import json
import math
import os
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Optional,
    Sequence,
    Tuple,
)

try:  # typing.Protocol is 3.8+; degrade gracefully if unavailable.
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(cls):  # type: ignore
        return cls

from . import training

# Where promoted model versions live inside a vault (next to records.jsonl).
MODELS_RELDIR = os.path.join("training", "models")

# The reference policy's discrete decision set: route this task's routine work
# to the cheaper LOCAL model, or to a frontier CLOUD model. The falling-cost
# thesis (specs/10 §4) is "route more routine work to the cheaper local model,"
# so on the routine lane the reward favours LOCAL; reasoning/planning stays
# CLOUD. This is the action whose probability GRPO learns to shift.
DECISION_SET: Tuple[str, ...] = ("local", "cloud")

# Numerical floor for advantage normalisation (avoids /0 on a zero-variance
# group; a group with no reward spread yields all-zero advantages, i.e. no
# learning signal — correct, since there is nothing to prefer).
_EPS = 1e-9


# ==========================================================================
# Reading the seam
# ==========================================================================


def load_records(vault: str, *, path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Read the accumulated training records written by the seam (training.py).

    Thin wrapper over ``training.read_records`` so the GRPO pipeline has one
    obvious entry point. Empty list if the vault has no records yet (a cold
    vault must never crash the trainer).
    """
    return training.read_records(vault, path=path)


def record_reward(record: Dict[str, Any]) -> float:
    """The scalar reward on a record — specs/10 §3, already computed by the seam.

    Reads ``record["reward"]["value"]`` (the weighted tier1/tier2/envelope/hook
    reward). Falls back to a top-level ``reward`` float so hand-built synthetic
    records stay easy to write in tests. Missing → 0.0.
    """
    rw = record.get("reward")
    if isinstance(rw, dict) and "value" in rw:
        try:
            return float(rw["value"])
        except (TypeError, ValueError):
            return 0.0
    try:
        return float(rw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


# ==========================================================================
# Grouping — "by task_type / intent bucket" (specs/10 §2)
# ==========================================================================

# Coarse task-type buckets so *comparable* tasks share a GRPO group. Each entry
# is (label, keywords); the first whose keyword appears in the intent wins.
# Ordered most-specific first. A record may override with an explicit "bucket".
_TASK_CATEGORIES: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("auth-security", ("auth", "credential", "secret", "permission", "login", "token")),
    ("reasoning", ("reason", "plan", "design", "architect", "strategy")),
    ("test-gen", ("test", "spec", "coverage")),
    ("review", ("review", "lint", "audit")),
    ("refactor", ("refactor", "cleanup", "dedup", "duplication", "rename")),
    ("retrieval", ("summar", "search", "retriev", "index", "lookup", "config")),
    ("docs", ("document", "readme", "comment", "docstring")),
)


def task_bucket(record: Dict[str, Any]) -> str:
    """The GRPO group key for a record: its task_type / intent bucket.

    An explicit ``record["bucket"]`` wins (lets a caller/test control grouping);
    otherwise the intent is matched against coarse task categories so similar
    task types (all the test-gen tasks, all the refactors, …) group together and
    are normalised *against their peers*. Unmatched → ``"general"``.
    """
    explicit = record.get("bucket")
    if explicit:
        return str(explicit)
    intent = str(record.get("task_intent") or record.get("intent") or "").lower()
    for label, keywords in _TASK_CATEGORIES:
        if any(k in intent for k in keywords):
            return label
    return "general"


def group_records(
    records: Sequence[Dict[str, Any]],
    key_fn: Optional[Callable[[Dict[str, Any]], str]] = None,
) -> "OrderedDict[str, List[int]]":
    """Group record *indices* by bucket, preserving first-seen order.

    Returns ``bucket -> [indices]`` so callers can align a per-record advantage
    list back to its group (that's how the tests verify per-group mean ~0).
    """
    key_fn = key_fn or task_bucket
    groups: "OrderedDict[str, List[int]]" = OrderedDict()
    for i, rec in enumerate(records):
        groups.setdefault(key_fn(rec), []).append(i)
    return groups


def group_relative_advantages(
    records: Sequence[Dict[str, Any]],
    key_fn: Optional[Callable[[Dict[str, Any]], str]] = None,
    *,
    reward_of: Optional[Callable[[Dict[str, Any]], float]] = None,
) -> List[float]:
    """GRPO's core: within-group reward normalisation → advantages.

    For each group of comparable tasks, take the logged rewards and normalise:

        advantage_i = (reward_i - mean(group)) / (std(group) + eps)

    The group IS the baseline (no learned value critic) — this is precisely what
    separates GRPO from SFT: we optimise *relative reward among peers*, not
    next-token likelihood. Guarantees:

      * Each group's advantages have mean ~0 (a positive advantage means "beat
        your peers"; negative means "underperformed them").
      * Unit-ish scale (÷ std) so groups with different reward magnitudes
        contribute comparable gradient signal.
      * A singleton group, or a group with zero reward spread, yields all-zero
        advantages — nothing to prefer, so no update. Correct.

    Returns a flat list aligned to ``records`` (index-for-index), ready to hand
    to ``Policy.update(batch, advantages, lr)``.
    """
    reward_of = reward_of or record_reward
    advantages = [0.0] * len(records)
    groups = group_records(records, key_fn)
    for _bucket, idxs in groups.items():
        rewards = [reward_of(records[i]) for i in idxs]
        n = len(rewards)
        if n < 2:
            continue  # singleton: no peer to be relative to → advantage 0
        mean = sum(rewards) / n
        var = sum((r - mean) ** 2 for r in rewards) / n  # population variance
        std = math.sqrt(var)
        if std <= _EPS:
            continue  # no spread → nothing to prefer within this group
        for i in idxs:
            advantages[i] = (reward_of(records[i]) - mean) / (std + _EPS)
    return advantages


# ==========================================================================
# The Policy protocol + a REAL reference policy
# ==========================================================================


@runtime_checkable
class Policy(Protocol):
    """A pluggable GRPO policy (specs/10 §2). The reference ``RoutePolicy`` and
    the compute-gated ``LLMPolicy`` both satisfy this.

    A policy maps a *context* (the task's intent bucket) to a distribution over
    a discrete decision set, and is improved by a policy-gradient update that
    pushes probability toward actions with positive group-relative advantage.
    """

    def act(self, context: str) -> Dict[str, float]:
        """Return the action distribution for a context (sums to 1.0)."""

    def update(
        self,
        batch: Sequence[Dict[str, Any]],
        advantages: Sequence[float],
        lr: float,
    ) -> None:
        """One GRPO gradient step over a batch and its aligned advantages."""

    def snapshot(self) -> Dict[str, Any]:
        """Serialisable snapshot of the weights (for gating / versioning)."""

    def restore(self, snapshot: Dict[str, Any]) -> None:
        """Restore weights from a snapshot (rollback on a discarded fine-tune)."""


def record_action(
    record: Dict[str, Any],
    actions: Sequence[str] = DECISION_SET,
) -> str:
    """The action a record represents — the route the run actually took.

    Priority: an explicit ``record["action"]`` (tests set this) → else the
    majority route in ``tools_used`` (the seam's ``model_route``) → else the
    first action. This is the "what did we do" that GRPO reinforces or suppresses
    based on the reward it earned.
    """
    explicit = record.get("action")
    if explicit in actions:
        return str(explicit)
    routes = [r for r in (record.get("tools_used") or []) if r in actions]
    if routes:
        counts = {a: routes.count(a) for a in actions}
        # Deterministic argmax: highest count, ties broken by action order.
        return max(actions, key=lambda a: (counts.get(a, 0), -actions.index(a)))
    return actions[0]


def _softmax(logits: Dict[str, float]) -> Dict[str, float]:
    """Numerically-stable softmax over an action->logit map."""
    if not logits:
        return {}
    hi = max(logits.values())
    exps = {a: math.exp(v - hi) for a, v in logits.items()}
    z = sum(exps.values()) or 1.0
    return {a: e / z for a, e in exps.items()}


class RoutePolicy:
    """A real, tiny, stdlib GRPO policy: softmax over the route decision set.

    Weights are a table ``logits[context][action]``. ``act`` is a softmax over
    the context's row (an unseen context starts uniform, so a freshly-minted
    baseline scores 0.5/0.5 everywhere — the honest "no opinion yet" prior).

    ``update`` is REINFORCE with the GRPO group-relative advantage as the
    baseline. For a softmax, ``∂ log π(a|ctx) / ∂ logit_j = 1{j=a} − π(j)``, so

        logit[ctx][j] += lr · advantage · (1{j=a} − π(j|ctx))

    A record with positive advantage (beat its peers) pushes probability toward
    the action it took; a negative-advantage record pushes it away. Fully
    deterministic — advantages come from *logged* actions, nothing is sampled —
    so a seeded run is reproducible (specs/10 requirement).
    """

    def __init__(
        self,
        actions: Sequence[str] = DECISION_SET,
        *,
        context_of: Optional[Callable[[Dict[str, Any]], str]] = None,
        action_of: Optional[Callable[[Dict[str, Any]], str]] = None,
        seed: int = 0,
    ) -> None:
        self.actions: Tuple[str, ...] = tuple(actions)
        self.context_of = context_of or task_bucket
        self._action_of = action_of or (lambda r: record_action(r, self.actions))
        self.seed = int(seed)
        # logits[context] -> {action: logit}. Contexts appear lazily.
        self.logits: Dict[str, Dict[str, float]] = {}

    # -- distribution -----------------------------------------------------

    def _row(self, context: str) -> Dict[str, float]:
        row = self.logits.get(context)
        if row is None:
            row = {a: 0.0 for a in self.actions}  # uniform prior
            self.logits[context] = row
        return row

    def act(self, context: str) -> Dict[str, float]:
        """Action distribution for a context (unseen context → uniform)."""
        if context not in self.logits:
            return {a: 1.0 / len(self.actions) for a in self.actions}
        return _softmax(self.logits[context])

    def prob(self, context: str, action: str) -> float:
        return self.act(context).get(action, 0.0)

    # -- GRPO gradient step ----------------------------------------------

    def update(
        self,
        batch: Sequence[Dict[str, Any]],
        advantages: Sequence[float],
        lr: float,
    ) -> None:
        """One group-relative policy-gradient ascent step over the batch."""
        if len(batch) != len(advantages):
            raise ValueError(
                f"batch/advantages length mismatch: {len(batch)} != {len(advantages)}"
            )
        for rec, adv in zip(batch, advantages):
            if adv == 0.0:
                continue  # no signal (singleton / zero-variance group)
            context = self.context_of(rec)
            action = self._action_of(rec)
            row = self._row(context)
            dist = _softmax(row)
            for j in self.actions:
                grad = (1.0 if j == action else 0.0) - dist.get(j, 0.0)
                row[j] += lr * adv * grad

    # -- versioning / rollback -------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        return {
            "kind": "route-policy",
            "actions": list(self.actions),
            "seed": self.seed,
            "logits": {c: dict(row) for c, row in self.logits.items()},
        }

    def restore(self, snapshot: Dict[str, Any]) -> None:
        self.actions = tuple(snapshot.get("actions", self.actions))
        self.seed = int(snapshot.get("seed", self.seed))
        self.logits = {
            c: dict(row) for c, row in (snapshot.get("logits", {}) or {}).items()
        }

    def clone(self) -> "RoutePolicy":
        """A deep copy — used to hold a baseline while the candidate trains."""
        twin = RoutePolicy(
            self.actions,
            context_of=self.context_of,
            action_of=self._action_of,
            seed=self.seed,
        )
        twin.restore(self.snapshot())
        return twin


# ==========================================================================
# Expected reward — the convergence metric (proves the flywheel)
# ==========================================================================


def expected_reward(
    policy: Policy,
    records: Sequence[Dict[str, Any]],
    *,
    key_fn: Optional[Callable[[Dict[str, Any]], str]] = None,
    action_of: Optional[Callable[[Dict[str, Any]], str]] = None,
    reward_of: Optional[Callable[[Dict[str, Any]], float]] = None,
) -> float:
    """Expected reward of a policy given the empirical action→reward in the data.

    For each bucket we measure the mean logged reward per action, then score the
    policy by ``Σ_a π(a|ctx)·mean_reward(ctx,a)`` (renormalised over the actions
    actually observed in that bucket, so probability mass on never-tried actions
    doesn't leak in). Buckets are weighted by record count.

    This is the number that must go UP as GRPO trains: shifting probability onto
    the higher-reward action within each group raises expected reward. The
    trainer reports it before/after so the flywheel is provable, not asserted.
    """
    key_fn = key_fn or task_bucket
    reward_of = reward_of or record_reward
    if action_of is None:
        action_of = record_action

    groups = group_records(records, key_fn)
    total = 0.0
    count = 0
    for ctx, idxs in groups.items():
        by_action: Dict[str, List[float]] = {}
        for i in idxs:
            by_action.setdefault(action_of(records[i]), []).append(
                reward_of(records[i])
            )
        dist = policy.act(ctx)
        observed = list(by_action)
        z = sum(dist.get(a, 0.0) for a in observed) or 1.0
        er_ctx = 0.0
        for a in observed:
            mean_r = sum(by_action[a]) / len(by_action[a])
            er_ctx += (dist.get(a, 0.0) / z) * mean_r
        total += er_ctx * len(idxs)
        count += len(idxs)
    return round(total / count, 8) if count else 0.0


# ==========================================================================
# The trainer
# ==========================================================================


@dataclass
class GRPOMetrics:
    """What one training run produced — enough to prove convergence + audit it."""

    records: int
    groups: int
    epochs: int
    lr: float
    expected_reward_before: float
    expected_reward_after: float
    lift: float
    per_epoch: List[float] = field(default_factory=list)
    buckets: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "records": self.records,
            "groups": self.groups,
            "epochs": self.epochs,
            "lr": self.lr,
            "expected_reward_before": self.expected_reward_before,
            "expected_reward_after": self.expected_reward_after,
            "lift": self.lift,
            "per_epoch": self.per_epoch,
            "buckets": self.buckets,
        }


class GRPOTrainer:
    """Runs the group-relative GRPO update loop over accumulated records.

    Advantages are computed ONCE from the logged rewards (offline GRPO — the
    reward is a fixed property of a completed, verified run, not re-sampled), and
    the policy takes ``epochs`` ascent steps against them. Deterministic.
    """

    def __init__(
        self,
        *,
        epochs: int = 60,
        lr: float = 0.5,
        key_fn: Optional[Callable[[Dict[str, Any]], str]] = None,
    ) -> None:
        self.epochs = int(epochs)
        self.lr = float(lr)
        self.key_fn = key_fn or task_bucket

    def train(
        self,
        records: Sequence[Dict[str, Any]],
        policy: Policy,
        *,
        epochs: Optional[int] = None,
        lr: Optional[float] = None,
    ) -> Tuple[Policy, GRPOMetrics]:
        """Train ``policy`` on ``records`` in place; return (policy, metrics).

        A no-op on empty records (returns the untouched policy + zero metrics),
        so the pipeline is robust on a cold vault.
        """
        epochs = self.epochs if epochs is None else int(epochs)
        lr = self.lr if lr is None else float(lr)

        groups = group_records(records, self.key_fn)
        if not records:
            return policy, GRPOMetrics(
                records=0, groups=0, epochs=epochs, lr=lr,
                expected_reward_before=0.0, expected_reward_after=0.0, lift=0.0,
                per_epoch=[], buckets=[],
            )

        advantages = group_relative_advantages(records, self.key_fn)

        action_of = getattr(policy, "_action_of", record_action)
        er_before = expected_reward(
            policy, records, key_fn=self.key_fn, action_of=action_of
        )
        per_epoch: List[float] = []
        for _ in range(epochs):
            policy.update(records, advantages, lr)
            per_epoch.append(
                expected_reward(policy, records, key_fn=self.key_fn, action_of=action_of)
            )
        er_after = per_epoch[-1] if per_epoch else er_before

        return policy, GRPOMetrics(
            records=len(records),
            groups=len(groups),
            epochs=epochs,
            lr=lr,
            expected_reward_before=er_before,
            expected_reward_after=er_after,
            lift=round(er_after - er_before, 8),
            per_epoch=per_epoch,
            buckets=list(groups.keys()),
        )


# ==========================================================================
# The eval-lift gate (ADR-017 / specs/10 §5) — non-negotiable
# ==========================================================================


def golden_preferred_action(
    golden: Any,
    actions: Sequence[str] = DECISION_SET,
) -> str:
    """The route a healthy policy SHOULD choose for a golden (the falling-cost
    lane, specs/10 §4).

    Reasoning / planning / design work stays on the frontier CLOUD model; the
    routine + sensitive lane routes to the cheaper LOCAL model (commodity work
    gets cheaper; sensitive work stays on-prem). This is the "good" action the
    gate scores the policy against.
    """
    intent = str(getattr(golden, "intent", "") or "").lower()
    if any(k in intent for k in ("reason", "plan", "design", "architect", "strategy")):
        return "cloud" if "cloud" in actions else actions[-1]
    return "local" if "local" in actions else actions[0]


def _golden_context(golden: Any) -> str:
    """A golden's GRPO bucket — same bucketing the records use."""
    return task_bucket({"task_intent": getattr(golden, "intent", "")})


def policy_golden_score(policy: Policy, golden: Any) -> float:
    """Score a policy on a golden: the probability it assigns the *preferred*
    action for that golden's context.

    A policy that has learned to route each context toward its reward-maximising
    action scores near 1.0; the untrained uniform baseline scores 1/|actions|.
    This is the "policy-scored proxy" specs/10 §5 allows in place of a full
    re-run of every golden through the loop — it is a deterministic function of
    the policy, so baseline vs candidate is a fair, reproducible comparison.
    """
    ctx = _golden_context(golden)
    preferred = golden_preferred_action(golden, policy_actions(policy))
    return round(policy.act(ctx).get(preferred, 0.0), 8)


def policy_actions(policy: Policy) -> Sequence[str]:
    return tuple(getattr(policy, "actions", DECISION_SET))


@dataclass
class GateDecision:
    """The promote/discard verdict of the eval-lift gate (ADR-017).

    ``promote`` is True IFF the candidate lifts the mean golden score AND no
    single golden regresses. A regression on ANY golden discards the candidate
    and keeps the previous weights — the non-negotiable rule of specs/10 §5.
    """

    promote: bool
    lift: float
    min_lift: float
    baseline_mean: float
    candidate_mean: float
    per_golden: List[Dict[str, Any]] = field(default_factory=list)
    regressions: List[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "promote": self.promote,
            "decision": "PROMOTE" if self.promote else "DISCARD",
            "lift": self.lift,
            "min_lift": self.min_lift,
            "baseline_mean": self.baseline_mean,
            "candidate_mean": self.candidate_mean,
            "per_golden": self.per_golden,
            "regressions": self.regressions,
            "reason": self.reason,
        }


def eval_lift_gate(
    baseline: Policy,
    candidate: Policy,
    goldens: Optional[Sequence[Any]] = None,
    *,
    directory: Optional[str] = None,
    score_fn: Optional[Callable[[Policy, Any], float]] = None,
    min_lift: float = 0.0,
    regression_eps: float = 1e-9,
) -> GateDecision:
    """The eval gate that guards every promotion (ADR-017 / specs/10 §5).

    Runs each golden under ``baseline`` and ``candidate`` and PROMOTES only if:

      1. the candidate's MEAN golden score beats the baseline's by > ``min_lift``
         (lift is real, magnitude measured — never assumed, specs/10 §5), AND
      2. NO individual golden regresses (candidate ≥ baseline − eps everywhere).

    Either condition failing → DISCARD, keep the previous weights. This is the
    "a fine-tune that regresses any golden threshold is discarded" rule, made
    executable. ``goldens=None`` loads the seed suite; ``score_fn`` defaults to
    the policy-scored proxy (``policy_golden_score``) but a caller/test can pass
    a full ``run_all_goldens``-based scorer.
    """
    if goldens is None:
        from .goldens import load_goldens

        goldens = load_goldens(directory)
    score_fn = score_fn or policy_golden_score

    per_golden: List[Dict[str, Any]] = []
    regressions: List[str] = []
    base_scores: List[float] = []
    cand_scores: List[float] = []

    for g in goldens:
        gid = str(getattr(g, "id", getattr(g, "golden_id", "?")))
        b = float(score_fn(baseline, g))
        c = float(score_fn(candidate, g))
        base_scores.append(b)
        cand_scores.append(c)
        delta = round(c - b, 8)
        regressed = c < b - regression_eps
        if regressed:
            regressions.append(gid)
        per_golden.append(
            {
                "golden_id": gid,
                "baseline": round(b, 8),
                "candidate": round(c, 8),
                "delta": delta,
                "regressed": regressed,
            }
        )

    n = len(goldens)
    base_mean = round(sum(base_scores) / n, 8) if n else 0.0
    cand_mean = round(sum(cand_scores) / n, 8) if n else 0.0
    lift = round(cand_mean - base_mean, 8)

    has_lift = lift > min_lift
    no_regression = not regressions
    promote = bool(n) and has_lift and no_regression

    if not n:
        reason = "no goldens to gate on — cannot prove lift, DISCARD"
    elif promote:
        reason = (
            f"PROMOTE: lift {lift:+.6f} > {min_lift} on {n} goldens, no regression"
        )
    elif not has_lift:
        reason = f"DISCARD: no lift ({lift:+.6f} <= {min_lift})"
    else:
        reason = f"DISCARD: {len(regressions)} golden(s) regressed: {', '.join(regressions)}"

    return GateDecision(
        promote=promote,
        lift=lift,
        min_lift=float(min_lift),
        baseline_mean=base_mean,
        candidate_mean=cand_mean,
        per_golden=per_golden,
        regressions=regressions,
        reason=reason,
    )


# ==========================================================================
# Versioned weights + rollback (specs/10 §5)
# ==========================================================================


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Encryption-at-rest is a documented STUB here (specs/10 §5: "encrypted and
# versioned like code"). The seam is: weights pass through _seal on write and
# _unseal on read; wiring a real KMS/age/openssl envelope is deployment work.
_ENCRYPTION_NOTE = (
    "at-rest encryption: STUB (identity). specs/10 §5 requires promoted weights "
    "be encrypted + versioned like code; wire a real envelope (KMS/age) at deploy."
)


def _seal(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    return snapshot  # STUB: identity. Real deployment wraps this in encryption.


def _unseal(sealed: Dict[str, Any]) -> Dict[str, Any]:
    return sealed  # STUB: identity.


class ModelRegistry:
    """Versioned, rollback-able store of promoted policy weights.

    Each promotion writes ``<vault>/training/models/v<N>/`` holding the sealed
    weights + a ``manifest.json`` that ties the version to the justifying eval
    run (the ``GateDecision`` + trainer metrics). ``current.json`` points at the
    live version; ``rollback`` re-points it at the prior version so a regression
    discovered later can be reverted (a promoted model is always traceable to the
    eval run that justified it — specs/10 §5 / §7).
    """

    def __init__(self, vault: str, *, root: Optional[str] = None) -> None:
        self.vault = vault
        self.root = root or os.path.join(vault, MODELS_RELDIR)

    # -- layout helpers ---------------------------------------------------

    def _current_path(self) -> str:
        return os.path.join(self.root, "current.json")

    def _version_dir(self, version: str) -> str:
        return os.path.join(self.root, version)

    def versions(self) -> List[str]:
        if not os.path.isdir(self.root):
            return []
        vs = [
            d
            for d in os.listdir(self.root)
            if d.startswith("v") and os.path.isdir(self._version_dir(d))
        ]
        vs.sort(key=lambda d: int(d[1:]) if d[1:].isdigit() else -1)
        return vs

    def _next_version(self) -> str:
        existing = self.versions()
        if not existing:
            return "v1"
        last = max(int(v[1:]) for v in existing if v[1:].isdigit())
        return f"v{last + 1}"

    # -- read -------------------------------------------------------------

    def current(self) -> Optional[Dict[str, Any]]:
        cp = self._current_path()
        if not os.path.exists(cp):
            return None
        with open(cp, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def load_manifest(self, version: str) -> Optional[Dict[str, Any]]:
        mp = os.path.join(self._version_dir(version), "manifest.json")
        if not os.path.exists(mp):
            return None
        with open(mp, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def load_weights(self, version: str) -> Optional[Dict[str, Any]]:
        wp = os.path.join(self._version_dir(version), "weights.json")
        if not os.path.exists(wp):
            return None
        with open(wp, "r", encoding="utf-8") as fh:
            return _unseal(json.load(fh))

    # -- write ------------------------------------------------------------

    def promote(
        self,
        policy: Policy,
        decision: GateDecision,
        *,
        metrics: Optional[GRPOMetrics] = None,
    ) -> Dict[str, Any]:
        """Write a new version tied to its justifying eval run; make it current."""
        version = self._next_version()
        vdir = self._version_dir(version)
        os.makedirs(vdir, exist_ok=True)

        previous = self.current()
        prev_version = previous.get("version") if previous else None

        snapshot = policy.snapshot()
        with open(os.path.join(vdir, "weights.json"), "w", encoding="utf-8") as fh:
            json.dump(_seal(snapshot), fh, ensure_ascii=False, indent=2)

        manifest = {
            "version": version,
            "created": _now_iso(),
            "previous": prev_version,
            "justified_by": decision.to_dict(),  # the eval run that promoted it
            "metrics": metrics.to_dict() if metrics is not None else None,
            "policy_kind": snapshot.get("kind", "unknown"),
            "encryption": _ENCRYPTION_NOTE,
            "schema": "scprism.grpo.model.v1",
        }
        with open(os.path.join(vdir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)

        self._write_current(version, previous=prev_version)
        return manifest

    def _write_current(self, version: str, *, previous: Optional[str]) -> None:
        payload = {
            "version": version,
            "previous": previous,
            "updated": _now_iso(),
        }
        os.makedirs(self.root, exist_ok=True)
        with open(self._current_path(), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

    def rollback(self) -> Optional[Dict[str, Any]]:
        """Revert ``current`` to the previous version (a discovered regression).

        Returns the new current payload, or None if there is nothing to roll
        back to (no version, or the live version has no predecessor).
        """
        cur = self.current()
        if not cur:
            return None
        prev = cur.get("previous")
        if not prev:
            return None
        prev_manifest = self.load_manifest(prev) or {}
        self._write_current(prev, previous=prev_manifest.get("previous"))
        return self.current()


def promote_or_discard(
    decision: GateDecision,
    candidate: Policy,
    *,
    vault: Optional[str] = None,
    metrics: Optional[GRPOMetrics] = None,
    registry: Optional[ModelRegistry] = None,
) -> Dict[str, Any]:
    """Act on a gate decision (ADR-017): version the weights on PROMOTE, keep
    the old ones on DISCARD.

    On PROMOTE: writes a new versioned, sealed weight set with a manifest tying
    it to ``decision`` (and ``metrics``), and returns ``{"promoted": True,
    "version": ..., "manifest": ...}``. On DISCARD: writes NOTHING — the previous
    weights stay live — and returns ``{"promoted": False, ...}`` naming the
    surviving version. A dry gate (no vault/registry) still returns a valid
    decision so the CLI can ``--dry-run``.
    """
    if registry is None and vault is not None:
        registry = ModelRegistry(vault)

    if not decision.promote:
        surviving = registry.current() if registry is not None else None
        return {
            "promoted": False,
            "decision": "DISCARD",
            "reason": decision.reason,
            "current_version": (surviving or {}).get("version") if surviving else None,
            "gate": decision.to_dict(),
        }

    if registry is None:
        # PROMOTE decided but nowhere to persist (dry run): honest about it.
        return {
            "promoted": True,
            "decision": "PROMOTE",
            "reason": decision.reason + " (dry: not persisted, no vault given)",
            "version": None,
            "gate": decision.to_dict(),
        }

    manifest = registry.promote(candidate, decision, metrics=metrics)
    return {
        "promoted": True,
        "decision": "PROMOTE",
        "reason": decision.reason,
        "version": manifest["version"],
        "previous_version": manifest["previous"],
        "manifest": manifest,
        "gate": decision.to_dict(),
    }


# ==========================================================================
# Runtime adoption — read the promoted route policy back at run time (LF-2)
# ==========================================================================


def load_current_route_policy(
    vault: str,
) -> Optional[Tuple[RoutePolicy, str]]:
    """Load a vault's currently-adopted route policy for runtime routing (LF-2).

    Closes the flywheel's biggest open loop: a policy the golden lift-gate
    PROMOTED is finally read back so the Gateway can act on it. Reads the
    ``ModelRegistry`` at ``<vault>/training/models`` — ``current()`` → the live
    version → ``load_weights(version)`` — and restores it into a fresh
    ``RoutePolicy`` IFF the snapshot is the stdlib route policy
    (``kind == "route-policy"``).

    Returns ``(policy, version_label)`` so the caller can name the version
    honestly in a route reason. This is ROUTE SELECTION only — the restored
    policy chooses local-vs-cloud on the default lane; it is never the model
    "learning". ANY failure (no registry, no ``current``, missing/corrupt
    weights, a non-route-policy snapshot) → ``None``, never raises: an
    unreadable or absent policy must leave routing on the built-in rules, never
    crash a run.
    """
    try:
        registry = ModelRegistry(vault)
        current = registry.current()
        if not current:
            return None
        version = current.get("version")
        if not version:
            return None
        weights = registry.load_weights(str(version))
        # Only the stdlib route policy is adoptable here (the LLMPolicy path is
        # a different, compute-gated backend). Wrong kind / no weights → None.
        if not isinstance(weights, dict) or weights.get("kind") != "route-policy":
            return None
        policy = RoutePolicy()
        policy.restore(weights)
        return policy, str(version)
    except Exception:
        # Corrupt JSON, unexpected shape, unreadable dir — stay on built-in rules.
        return None


# ==========================================================================
# Optional real-LLM backend — the compute-gated FINAL step (specs/10 §6)
# ==========================================================================

# Opt-in flag. Even when set, the heavy libs must be importable AND a model
# present; otherwise LLMPolicy raises clearly. NEVER pip-installs anything.
LLM_ENV_FLAG = "SCPRISM_GRPO_LLM"


def llm_backend_requested(env: Optional[Dict[str, str]] = None) -> bool:
    env = os.environ if env is None else env
    return str(env.get(LLM_ENV_FLAG, "")).strip().lower() in ("1", "true", "yes", "on")


def llm_backend_available() -> bool:
    """True only if the real neural backend (``grpo_llm``) imports cleanly.

    The backend needs ``torch`` + ``transformers`` (``trl`` is optional — this
    proof uses a minimal manual policy-gradient, not trl). Importing
    ``grpo_llm`` IS the guard: it imports the heavy libs at module scope, so a
    clean import means they are present. Returns False on any ImportError so the
    stdlib reference path is always the safe default. Does not probe for a GPU or
    a downloaded model — the tiny model is built (random-init) at construction.
    """
    try:  # pragma: no cover - exercised only where the heavy libs exist
        from . import grpo_llm  # noqa: F401

        return True
    except Exception:
        return False


class LLMPolicy:
    """Opt-in entry point to the REAL neural GRPO backend (specs/10 §6).

    The genuine torch/transformers implementation lives in ``grpo_llm`` (kept out
    of this stdlib module so the offline core and the 3.9 test suite never import
    torch). This wrapper enforces the gate — ``$SCPRISM_GRPO_LLM=1`` AND the heavy
    libs importable — then constructs and RETURNS the real ``grpo_llm.LLMPolicy``
    (an instance of a different class; ``__new__`` returning a non-subclass means
    Python skips ``__init__`` here). If the flag is unset or the libs are absent
    it RAISES clearly, so nothing silently falls into a broken heavy path.

    HONESTY (specs/10 §6): the real backend is a TINY random-init model on CPU —
    an honest proof that the neural GRPO update runs and moves the policy per the
    reward advantages, not a production fine-tune of a real coding model.
    """

    def __new__(cls, model_name: str = "", *, env: Optional[Dict[str, str]] = None, **kwargs):
        if not llm_backend_requested(env):
            raise RuntimeError(
                f"LLMPolicy is opt-in: set {LLM_ENV_FLAG}=1 to enable the "
                "compute-gated real-LLM GRPO backend (specs/10 §6). The stdlib "
                "RoutePolicy is the default and proves the flywheel mechanics."
            )
        try:
            from .grpo_llm import LLMPolicy as _RealLLMPolicy
        except Exception as exc:
            raise RuntimeError(
                "LLMPolicy requires torch + transformers (the neural GRPO "
                "backend). These heavy ML deps are NOT installed by this stdlib "
                "core. Provision them out of band (e.g. engine/.venv-llm); this "
                "is the compute-gated final step, not part of the offline core."
            ) from exc
        return _RealLLMPolicy(model_name, env=env, **kwargs)


def _select_policy(env: Optional[Dict[str, str]] = None) -> "Policy":
    """Pick the GRPO policy backend: real neural ``LLMPolicy`` when opted-in and
    available, else the stdlib ``RoutePolicy`` (the unchanged default).

    Used by ``run_training_pipeline`` so ``$SCPRISM_GRPO_LLM=1`` swaps in the
    genuine neural update while every default (flag unset / libs absent) run keeps
    the deterministic stdlib flywheel.
    """
    if llm_backend_requested(env) and llm_backend_available():
        try:  # pragma: no cover - only where the heavy libs exist
            from .grpo_llm import LLMPolicy as _RealLLMPolicy

            return _RealLLMPolicy(env=env)
        except Exception:
            pass
    return RoutePolicy()


# ==========================================================================
# Top-level pipeline convenience (used by the CLI)
# ==========================================================================


def run_training_pipeline(
    vault: str,
    *,
    epochs: int = 60,
    lr: float = 0.5,
    dry_run: bool = False,
    directory: Optional[str] = None,
    min_lift: float = 0.0,
) -> Dict[str, Any]:
    """The full offline flywheel step: records → advantages → train → gate →
    promote/discard. Returns a JSON-able report. Robust on empty/missing records.
    """
    records = load_records(vault)
    if not records:
        return {
            "vault": vault,
            "records": 0,
            "trained": False,
            "promoted": False,
            "decision": "NOOP",
            "reason": "no training records yet — nothing to learn from (cold vault)",
        }

    baseline = _select_policy()       # untrained prior (stdlib default, or neural if opted-in)
    candidate = baseline.clone()      # trained in place below

    trainer = GRPOTrainer(epochs=epochs, lr=lr)
    candidate, metrics = trainer.train(records, candidate)

    decision = eval_lift_gate(baseline, candidate, directory=directory, min_lift=min_lift)

    action = promote_or_discard(
        decision,
        candidate,
        vault=None if dry_run else vault,
        metrics=metrics,
    )

    return {
        "vault": vault,
        "records": len(records),
        "dry_run": bool(dry_run),
        "trained": True,
        "metrics": metrics.to_dict(),
        "reward_before": metrics.expected_reward_before,
        "reward_after": metrics.expected_reward_after,
        "reward_lift": metrics.lift,
        "gate": decision.to_dict(),
        **action,
    }
