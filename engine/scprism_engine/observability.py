"""Observability — a reader of the span stream (specs/07, ADR-012).

The Console never hooks the loop; it *reads* ``<vault>/spans.jsonl`` offline and
computes the views leadership sees. Tracing is asynchronous and adds no latency
to task execution — this module runs entirely after the fact over the JSONL.

Computed here (specs/07 §4–5):

  * **Per-operation / per-model cost attribution** — which step and which model
    spent what. This turns "the loop cost $14 last night" into a line-item
    breakdown, which is what makes routing tunable.
  * **Token burn** by operation, by model, and over time buckets.
  * **Hook latency + fire-rate** — is the enforcement layer healthy or
    thrashing.
  * **Eval-score trend** — the quality trend on the verdict spans across runs.
  * **Cache hit-rate + warmth** (ADR-023) — after an embedding-model upgrade
    forces a namespace reset the cache is cold; warmth makes the post-upgrade
    cost spike *explainable* rather than an incident.
  * **Drift signals** — a sudden eval-score drop, cache-hit drop, or cost spike
    fires a signal without manual polling (specs/07 §5).

A ``dashboard(vault)`` summary bundles all of the above for the Console to
render. Deterministic + stdlib only.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .telemetry import read_spans

# --------------------------------------------------------------------------
# Cost model. Deterministic USD-per-1k-token rates by provider. Local models
# are free (no egress, no metered API). Cloud rates are honest placeholder
# figures — the real Bifrost routing table owns live pricing (E-Bifrost); the
# point here is *attribution*, so the shape is what matters.
# --------------------------------------------------------------------------
DEFAULT_RATES: Dict[str, Dict[str, float]] = {
    "local": {"in": 0.0, "out": 0.0},
    "openai": {"in": 0.00015, "out": 0.0006},
    "claude": {"in": 0.0008, "out": 0.0024},
    "gemini": {"in": 0.000075, "out": 0.0003},
}
_FALLBACK_RATE = {"in": 0.0005, "out": 0.0015}

# Drift default thresholds (specs/07 §5). A drop/spike beyond these vs the
# baseline fires a signal.
DRIFT_EVAL_DROP = 0.1        # absolute eval-score drop
DRIFT_CACHE_DROP = 0.2       # absolute cache-hit-rate drop
DRIFT_COST_SPIKE = 1.5       # ratio: latest cost >= 1.5x baseline mean


def _rate(provider: str) -> Dict[str, float]:
    return DEFAULT_RATES.get(provider, _FALLBACK_RATE)


def _cost(provider: str, tokens_in: int, tokens_out: int) -> float:
    r = _rate(provider)
    return round((tokens_in / 1000.0) * r["in"] + (tokens_out / 1000.0) * r["out"], 6)


def _is_model_call(span: Dict[str, Any]) -> bool:
    return span.get("type") == "model_call"


def load_spans(vault: str) -> List[Dict[str, Any]]:
    """Read ``<vault>/spans.jsonl``; empty list if absent."""
    import os

    path = os.path.join(vault, "spans.jsonl")
    if not os.path.exists(path):
        return []
    return read_spans(path)


# --------------------------------------------------------------------------
# Cost attribution
# --------------------------------------------------------------------------


def per_model_cost(spans: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Attribute token burn + cost to each model (specs/07 §4)."""
    out: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"calls": 0, "tokens_in": 0, "tokens_out": 0, "tokens": 0, "cost": 0.0, "provider": ""}
    )
    for s in spans:
        if not _is_model_call(s):
            continue
        a = s.get("attrs", {})
        model = a.get("model", "?")
        provider = a.get("provider", "?")
        tin = int(a.get("tokens_in", 0) or 0)
        tout = int(a.get("tokens_out", 0) or 0)
        e = out[model]
        e["provider"] = provider
        e["calls"] += 1
        e["tokens_in"] += tin
        e["tokens_out"] += tout
        e["tokens"] += tin + tout
        e["cost"] = round(e["cost"] + _cost(provider, tin, tout), 6)
    return dict(out)


def per_operation_cost(spans: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Attribute token burn + cost to each operation (span name).

    An operation is the loop step that made the call — the model_call span's
    ``name`` (e.g. ``model_call``, ``eval``). This is the "test-generation on
    the cheap model cost $2, reasoning on the big model cost $11" view.
    """
    out: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"calls": 0, "tokens": 0, "cost": 0.0, "models": {}}
    )
    for s in spans:
        if not _is_model_call(s):
            continue
        a = s.get("attrs", {})
        op = s.get("name", "?")
        provider = a.get("provider", "?")
        model = a.get("model", "?")
        tin = int(a.get("tokens_in", 0) or 0)
        tout = int(a.get("tokens_out", 0) or 0)
        e = out[op]
        e["calls"] += 1
        e["tokens"] += tin + tout
        e["cost"] = round(e["cost"] + _cost(provider, tin, tout), 6)
        e["models"][model] = e["models"].get(model, 0) + tin + tout
    return dict(out)


def token_burn_by_time(
    spans: List[Dict[str, Any]], *, bucket_s: float = 1.0
) -> Dict[int, int]:
    """Token burn bucketed by wall-clock (specs/07 §5, the 'CEO sees the burn').

    Buckets are integer offsets of ``bucket_s`` seconds from the earliest
    model_call, so the series is stable regardless of absolute clock.
    """
    calls = [s for s in spans if _is_model_call(s)]
    if not calls:
        return {}
    t0 = min(s.get("start", 0.0) for s in calls)
    out: Dict[int, int] = defaultdict(int)
    for s in calls:
        a = s.get("attrs", {})
        tokens = int(a.get("tokens_in", 0) or 0) + int(a.get("tokens_out", 0) or 0)
        bucket = int((s.get("start", t0) - t0) // bucket_s)
        out[bucket] += tokens
    return dict(out)


# --------------------------------------------------------------------------
# Hook health
# --------------------------------------------------------------------------


def hook_stats(spans: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fire-rate + latency + block-rate per hook (specs/07 §5).

    Keyed by hook span name (``plan``, ``dispatch``, ``tier1``, ``stop``,
    ``gate:<tool>`` …). A high fire-rate with rising latency is the "enforcement
    layer thrashing" signal.

    ``errors`` vs ``failed_outcomes``: a hook span's ``status: "error"`` means
    two different things and conflating them badged a WORKING enforcement layer
    as broken. The ``stop`` ratchet sets ``status="error"`` to record
    "compliance ratchet: FAIL — task not done": the hook ran, decided correctly,
    and reported a failing run — a failed OUTCOME. Only a hook that could not do
    its job at all is an ``error``, and only that may be badged as one.
    """
    out: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {
            "fires": 0,
            "total_ms": 0.0,
            "avg_ms": 0.0,
            "blocks": 0,
            "errors": 0,
            "failed_outcomes": 0,
        }
    )
    for s in spans:
        if s.get("type") != "hook":
            continue
        name = s.get("name", "?")
        e = out[name]
        e["fires"] += 1
        e["total_ms"] += float(s.get("duration_ms", 0.0) or 0.0)
        a = s.get("attrs", {}) or {}
        outcome_failed = a.get("compliant") is False or a.get("passed") is False
        if outcome_failed:
            e["failed_outcomes"] += 1
        elif s.get("status") == "error":
            e["errors"] += 1
        if a.get("allowed") is False or a.get("blocked_by"):
            e["blocks"] += 1
    for e in out.values():
        e["avg_ms"] = round(e["total_ms"] / e["fires"], 4) if e["fires"] else 0.0
        e["total_ms"] = round(e["total_ms"], 4)
    return dict(out)


# --------------------------------------------------------------------------
# Tier-1 gate health — the measured source of the Stats hero
# --------------------------------------------------------------------------


def _classify_command(cmd: str) -> str:
    """Which free check a verify command IS (``tests`` / ``lint`` / ``build``)."""
    c = cmd.lower()
    if "lint" in c or "eslint" in c or "ruff" in c or "flake8" in c:
        return "lint"
    if "build" in c or "tsc" in c or "typecheck" in c or "compile" in c:
        return "build"
    if "test" in c or "pytest" in c or "jest" in c or "vitest" in c or "spec" in c:
        return "tests"
    return "other"


def tier1_stats(spans: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What the deterministic gate actually did, straight from the spans.

    A **save** is a run the gate genuinely BLOCKED: the checks ran, something
    failed, Tier-2 short-circuited, and the judge's tokens were never spent.
    That is what the Stats hero counts — measured here, not inferred from the
    session store (which only ever saw one app launch's runs).

    A failed Tier-1 is NOT automatically a save. Three outcomes are split apart,
    because merging them is how a broken gate manufactured a gold "53 saves ·
    tests caught 53" hero out of 53 runs that never verified anything:

    * ``blocked``   — the gate ran and caught something. The only saves.
    * ``not_found`` — the gate could not run at all (no verify binary, no
      project directory, ENOENT). Nothing was verified, so nothing was caught
      and nothing was avoided.
    * ``unknown``   — a failed span from BEFORE the app recorded which of the
      two it was. We do not know, so we do not claim: these count as neither.

    ``skipped`` sits outside all three: the gate had nothing to check, either
    because no command was configured (``skipped_no_commands``) or because the
    run had no project directory to run one against (``skipped_nothing_to_verify``
    — a chat message, a manager report, a heartbeat wake). Tier-1 is a PROJECT
    gate; a run with no code is not a failure, so a skip is never a save, never
    a caught failure, never an error, and never part of ``ran``.

    ``caught`` attributes each save to the check that produced it using the
    span's ``failed_commands``; when exactly one command ran the failing command
    is still *deducible*, otherwise the save lands in ``other`` rather than
    being guessed at. Only ``blocked`` runs are attributed.

    ``judged_runs`` / ``avg_judge_tokens`` come from the ``tier2`` verdict spans
    and are the only MEASURED basis for pricing what a save avoided.
    """
    runs = passed = failed = skipped = not_found = unknown = blocked = 0
    skipped_nothing_to_verify = skipped_no_commands = 0
    caught = {"tests": 0, "lint": 0, "build": 0, "other": 0}
    judged_runs = 0
    judged_tokens = 0
    for s in spans:
        name = s.get("name")
        a = s.get("attrs", {}) or {}
        if name == "tier2" and s.get("type") == "verdict":
            judged_runs += 1
            judged_tokens += int(a.get("tokens", 0) or 0)
            continue
        if name != "tier1":
            continue
        runs += 1
        if a.get("skipped"):
            skipped += 1
            # WHY it skipped, so the hero cannot say "no verify command
            # configured" to a user who configured one. `skipped_commands` is
            # non-empty exactly when a command existed but this run had no
            # project directory to point it at.
            if a.get("skipped_commands"):
                skipped_nothing_to_verify += 1
            else:
                skipped_no_commands += 1
        if a.get("passed"):
            passed += 1
            continue
        failed += 1
        if a.get("not_found"):
            # The gate never ran. Not a save, and nothing to attribute.
            not_found += 1
            continue
        if "not_found" not in a:
            # Recorded before the app distinguished "blocked" from "could not
            # run". Counting it either way would assert a measurement we do not
            # have, so it stays in its own honest bucket.
            unknown += 1
            continue
        blocked += 1
        commands = list(a.get("commands") or [])
        fails = list(a.get("failed_commands") or [])
        if not fails and len(commands) == 1:
            fails = commands  # one command ran and the tier failed: it was that one
        kinds = {_classify_command(c) for c in fails} or {"other"}
        for k in kinds:
            caught[k] = caught.get(k, 0) + 1
    return {
        "runs": runs,
        "ran": runs - skipped,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        # The two honest halves of `skipped`. Neither is a save, a caught
        # failure or an error — the gate did not run, so it neither verified nor
        # blocked anything, and `ran` (= runs - skipped) already excludes both.
        "skipped_nothing_to_verify": skipped_nothing_to_verify,
        "skipped_no_commands": skipped_no_commands,
        "not_found": not_found,
        "unknown": unknown,
        "blocked": blocked,
        "caught": caught,
        "judged_runs": judged_runs,
        "avg_judge_tokens": round(judged_tokens / judged_runs, 2) if judged_runs else 0.0,
    }


# --------------------------------------------------------------------------
# Cache hit-rate + warmth (ADR-023)
# --------------------------------------------------------------------------


def cache_stats(spans: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Cache hit-rate + warmth from model_call spans.

    ``cache`` attr is one of ``miss`` / ``prompt`` / ``semantic``. Hit-rate =
    non-miss / total. **Warmth** is the running hit-rate as calls accrue: a
    cold cache (after an ADR-023 namespace reset) starts near 0 and climbs, so
    a post-upgrade cost spike is explainable rather than an alert.
    """
    calls = [s for s in spans if _is_model_call(s)]
    hits = 0
    misses = 0
    by_kind: Dict[str, int] = defaultdict(int)
    warmth_curve: List[float] = []
    seen = 0
    for s in sorted(calls, key=lambda x: x.get("start", 0.0)):
        kind = s.get("attrs", {}).get("cache", "miss")
        by_kind[kind] += 1
        seen += 1
        if kind == "miss":
            misses += 1
        else:
            hits += 1
        warmth_curve.append(round(hits / seen, 4))
    total = hits + misses
    return {
        "total_calls": total,
        "hits": hits,
        "misses": misses,
        "hit_rate": round(hits / total, 4) if total else 0.0,
        "by_kind": dict(by_kind),
        "warmth": warmth_curve[-1] if warmth_curve else 0.0,
        "warmth_curve": warmth_curve,
    }


# --------------------------------------------------------------------------
# Per-run series + eval-score trend
# --------------------------------------------------------------------------


@dataclass
class RunSummary:
    """One task run distilled from its spans (the session is the unit)."""

    run_id: str
    task_id: str
    start: float
    tokens: int
    cost: float
    eval_score: Optional[float]
    passed: Optional[bool]
    cache_hit_rate: float
    model_calls: int
    # The three-valued outcome (`Verdict.outcome`): "passed" / "attention" /
    # "failed". ``None`` for runs recorded before the field existed — unknown,
    # not "failed". "attention" is the run whose DETERMINISTIC checks ran over
    # real files and passed while the LLM reviewer dissented; counting those as
    # failures is what poisoned this product's pass rates.
    outcome: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "start": self.start,
            "tokens": self.tokens,
            "cost": self.cost,
            "eval_score": self.eval_score,
            "passed": self.passed,
            "outcome": self.outcome,
            "cache_hit_rate": self.cache_hit_rate,
            "model_calls": self.model_calls,
        }


def run_series(spans: List[Dict[str, Any]]) -> List[RunSummary]:
    """Group spans into per-run summaries, ordered by run start time.

    The session/run is observability's unit of analysis (specs/07 §2). Each
    run's spans stitch into one summary carrying its cost, eval score, and cache
    hit-rate — the raw material for every trend + drift computation.
    """
    by_run: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for s in spans:
        rid = s.get("run_id")
        if rid:
            by_run[rid].append(s)

    summaries: List[RunSummary] = []
    for rid, group in by_run.items():
        root = next((s for s in group if s.get("type") == "run"), None)
        task_id = ""
        start = min((s.get("start", 0.0) for s in group), default=0.0)
        if root is not None:
            task_id = root.get("attrs", {}).get("task_id", "")
            start = root.get("start", start)

        model_calls = [s for s in group if _is_model_call(s)]
        tokens = 0
        cost = 0.0
        hits = 0
        for s in model_calls:
            a = s.get("attrs", {})
            tin = int(a.get("tokens_in", 0) or 0)
            tout = int(a.get("tokens_out", 0) or 0)
            tokens += tin + tout
            cost += _cost(a.get("provider", "?"), tin, tout)
            if a.get("cache", "miss") != "miss":
                hits += 1
        hit_rate = round(hits / len(model_calls), 4) if model_calls else 0.0

        # Eval score + pass come from the verdict-type spans (tier2 / verdict).
        eval_score: Optional[float] = None
        passed: Optional[bool] = None
        outcome: Optional[str] = None
        for s in group:
            if s.get("type") != "verdict":
                continue
            a = s.get("attrs", {})
            if "eval_score" in a or "score" in a:
                eval_score = float(a.get("eval_score", a.get("score")))
            if "passed" in a:
                passed = bool(a["passed"])
            if a.get("outcome"):
                outcome = str(a["outcome"])

        summaries.append(
            RunSummary(
                run_id=rid,
                task_id=task_id,
                start=start,
                tokens=tokens,
                cost=round(cost, 6),
                eval_score=eval_score,
                passed=passed,
                cache_hit_rate=hit_rate,
                model_calls=len(model_calls),
                outcome=outcome,
            )
        )

    summaries.sort(key=lambda r: r.start)
    return summaries


def outcome_stats(spans: List[Dict[str, Any]]) -> Dict[str, Any]:
    """How runs actually ended, three-valued (`Verdict.outcome`).

    ``attention`` is the honest middle: the deterministic Tier-1 gate ran the
    project's checks against real written files and PASSED, and the Tier-2 LLM
    reviewer dissented anyway. Those runs are not failures — the work exists and
    its checks pass — and rolling them into ``failed`` is what let an unevidenced
    model opinion drive this product's pass rate.

    ``judge_contradicted`` counts runs where the judge asserted something the
    deterministic layer measured to be FALSE (``tier2.contradictions``). A
    non-zero, rising number here is a broken judge prompt, not bad work.

    ``replied`` is a chat turn's pass (`Verdict.outcome="replied"`) — its own
    bucket, because folding conversation into either ``passed`` or ``failed``
    is what made 32 chat turns read as a 3% pass rate.

    ``unknown`` is runs recorded before ``outcome`` existed. We do not guess.
    """
    counts = {"passed": 0, "replied": 0, "attention": 0, "failed": 0, "unknown": 0}
    for r in run_series(spans):
        if r.outcome in counts:
            counts[r.outcome] += 1
        elif r.outcome is None and r.passed is None:
            continue  # a run with no verdict span at all is not an outcome
        else:
            counts["unknown"] += 1

    contradicted = sum(
        1
        for s in spans
        if s.get("name") == "tier2"
        and s.get("type") == "verdict"
        and (s.get("attrs", {}) or {}).get("contradictions")
    )
    counts["judge_contradicted"] = contradicted
    counts["total"] = sum(
        counts[k] for k in ("passed", "replied", "attention", "failed", "unknown")
    )
    return counts


def refine_stats(vault: str) -> Dict[str, Any]:
    """Does refining actually FIX anything? Read from the attempt ledgers.

    Every other counter in this module counts RUNS: `tier1_stats` and
    `outcome_stats` see attempt 1 and attempt 2 as two runs, which is correct —
    the gate really did execute twice and the tokens really were spent twice.
    This is the other question, and the only one a "verified refine loop" is
    ultimately judged on: of the LOGICAL steps that took more than one attempt,
    how many ended up passing?

    * ``groups``          — logical steps with a recorded attempt history.
    * ``attempts``        — attempt runs across all of them (>= ``groups``).
    * ``refined``         — groups that took MORE than one attempt.
    * ``refined_to_pass`` — refined groups whose LAST attempt passed after an
      earlier one failed. This is refining measurably working.
    * ``refined_still_failing`` — refined groups still not passing at the last
      attempt. Reported next to the win, always: a loop that only counts its
      successes is the thing this repo's rules exist to prevent.
    * ``single_attempt``  — groups that passed or failed on the first try; not
      evidence about refining either way.

    A vault that never tracked attempts returns all zeros — never an implied
    "0% improvement" over runs that were simply never grouped.
    """
    import json
    import os

    from .writeback import ATTEMPTS_DIRNAME

    out = {
        "groups": 0,
        "attempts": 0,
        "refined": 0,
        "refined_to_pass": 0,
        "refined_still_failing": 0,
        "single_attempt": 0,
    }
    attempts_dir = os.path.join(vault, "verdicts", ATTEMPTS_DIRNAME)
    try:
        names = sorted(os.listdir(attempts_dir))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(attempts_dir, name), "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        rows = data.get("attempts") if isinstance(data, dict) else None
        if not isinstance(rows, list) or not rows:
            continue
        rows = [r for r in rows if isinstance(r, dict)]
        if not rows:
            continue
        rows.sort(key=lambda r: int(r.get("attempt", 0) or 0))
        out["groups"] += 1
        out["attempts"] += len(rows)
        if len(rows) == 1:
            out["single_attempt"] += 1
            continue
        out["refined"] += 1
        if bool(rows[-1].get("passed")):
            out["refined_to_pass"] += 1
        else:
            out["refined_still_failing"] += 1
    return out


def eval_score_trend(spans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Quality trend on goldens/verdicts over time (specs/07 §5)."""
    out = []
    for r in run_series(spans):
        if r.eval_score is not None:
            out.append({"run_id": r.run_id, "task_id": r.task_id,
                        "start": r.start, "eval_score": r.eval_score})
    return out


# --------------------------------------------------------------------------
# Drift signals (specs/07 §5)
# --------------------------------------------------------------------------


@dataclass
class DriftSignal:
    """A fired drift alert — the Console surfaces these without polling."""

    kind: str          # 'eval_score_drop' | 'cache_hit_drop' | 'cost_spike'
    severity: str      # 'warn' | 'alert'
    baseline: float
    latest: float
    delta: float
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "baseline": round(self.baseline, 4),
            "latest": round(self.latest, 4),
            "delta": round(self.delta, 4),
            "reason": self.reason,
        }


def _money_words(v: float) -> str:
    """Money the way a person says it: cents under a nickel, dollars otherwise."""
    return f"${v:.2f}" if v >= 0.05 else f"{v * 100:.2f}\u00a2"


def cost_spike_reason(base_cost: float, latest_cost: float) -> str:
    """The Console's cost-spike sentence. It used to read 'cost spiked to 0.0026
    vs baseline 0.0017 (>= 1.5x)' — four-decimal dollars and a ratio flag on
    the card labelled the CEO view. Name the money, the real multiple, and the
    usual explanation instead."""
    mult = latest_cost / base_cost if base_cost > 0 else 0.0
    return (
        f"the last run cost {_money_words(latest_cost)} \u2014 {mult:.1f}\u00d7 your recent "
        f"average of {_money_words(base_cost)} a run; a runaway loop or a routing change "
        f"usually explains a jump like this"
    )


def detect_drift(
    spans: List[Dict[str, Any]],
    *,
    eval_drop: float = DRIFT_EVAL_DROP,
    cache_drop: float = DRIFT_CACHE_DROP,
    cost_spike: float = DRIFT_COST_SPIKE,
) -> List[DriftSignal]:
    """Fire signals when the latest run degrades vs the baseline of prior runs.

    Baseline = the mean over all runs before the latest one (needs >= 2 runs to
    have a comparison). A sudden eval-score drop, cache-hit drop, or cost spike
    each raises a signal — the "index degraded / schema mismatch after a deploy"
    early warning (specs/07 §5).
    """
    runs = run_series(spans)
    signals: List[DriftSignal] = []
    if len(runs) < 2:
        return signals

    latest = runs[-1]
    prior = runs[:-1]

    # (1) eval-score drop.
    prior_eval = [r.eval_score for r in prior if r.eval_score is not None]
    if prior_eval and latest.eval_score is not None:
        base = sum(prior_eval) / len(prior_eval)
        delta = latest.eval_score - base
        if -delta >= eval_drop:
            signals.append(DriftSignal(
                kind="eval_score_drop", severity="alert",
                baseline=base, latest=latest.eval_score, delta=delta,
                reason=(
                    f"eval score fell {abs(delta):.3f} (from {base:.3f} to "
                    f"{latest.eval_score:.3f}) — possible index/schema regression"
                ),
            ))

    # (2) cache-hit-rate drop (namespace reset / cold cache after upgrade).
    prior_cache = [r.cache_hit_rate for r in prior if r.model_calls]
    if prior_cache and latest.model_calls:
        base = sum(prior_cache) / len(prior_cache)
        delta = latest.cache_hit_rate - base
        if -delta >= cache_drop:
            signals.append(DriftSignal(
                kind="cache_hit_drop", severity="warn",
                baseline=base, latest=latest.cache_hit_rate, delta=delta,
                reason=(
                    f"cache hit-rate fell {abs(delta):.3f} (from {base:.3f} to "
                    f"{latest.cache_hit_rate:.3f}) — cold namespace (ADR-023)?"
                ),
            ))

    # (3) cost spike (runaway agent / routing regression).
    prior_cost = [r.cost for r in prior]
    base_cost = sum(prior_cost) / len(prior_cost) if prior_cost else 0.0
    if base_cost > 0 and latest.cost >= base_cost * cost_spike:
        signals.append(DriftSignal(
            kind="cost_spike", severity="alert",
            baseline=base_cost, latest=latest.cost,
            delta=latest.cost - base_cost,
            reason=cost_spike_reason(base_cost, latest.cost),
        ))
    # Token-based fallback when every route is free (local): a >= cost_spike x
    # jump in tokens is still a spike worth surfacing.
    elif base_cost == 0.0:
        prior_tok = [r.tokens for r in prior]
        base_tok = sum(prior_tok) / len(prior_tok) if prior_tok else 0.0
        if base_tok > 0 and latest.tokens >= base_tok * cost_spike:
            signals.append(DriftSignal(
                kind="cost_spike", severity="alert",
                baseline=base_tok, latest=float(latest.tokens),
                delta=latest.tokens - base_tok,
                reason=(
                    f"token burn spiked to {latest.tokens} vs baseline "
                    f"{base_tok:.0f} (>= {cost_spike}x) — runaway loop"
                ),
            ))

    return signals


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------


def dashboard(vault: str) -> Dict[str, Any]:
    """One summary object the Console renders (specs/07 §5).

    Bundles cost attribution, token burn, hook health, eval trend, cache warmth,
    per-run series, and any fired drift signals. Pure read of ``spans.jsonl`` —
    no latency added to the loop.
    """
    spans = load_spans(vault)
    runs = run_series(spans)
    cache = cache_stats(spans)
    per_model = per_model_cost(spans)
    per_op = per_operation_cost(spans)
    drift = detect_drift(spans)
    total_cost = round(sum(m["cost"] for m in per_model.values()), 6)
    total_tokens = sum(m["tokens"] for m in per_model.values())
    return {
        "vault": vault,
        "runs": len(runs),
        "run_series": [r.to_dict() for r in runs],
        "total_tokens": total_tokens,
        "total_cost": total_cost,
        "cost_by_model": per_model,
        "cost_by_operation": per_op,
        "token_burn_by_time": token_burn_by_time(spans),
        "hooks": hook_stats(spans),
        "tier1": tier1_stats(spans),
        "outcomes": outcome_stats(spans),
        # Per-RUN counters above; per-LOGICAL-STEP below. Both are true at once:
        # two attempts really are two runs of the gate, AND they are one step
        # that either got fixed or did not. `refine` is the only place that
        # second question is answered, and it is read from the attempt ledgers,
        # not inferred from the spans.
        "refine": refine_stats(vault),
        "eval_trend": eval_score_trend(spans),
        "cache": cache,
        "drift": [d.to_dict() for d in drift],
        "healthy": not drift,
    }
