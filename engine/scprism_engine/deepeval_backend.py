"""Optional DeepEval Tier-2 backend — OPT-IN, gateway-routed (specs/06 §8).

DeepEval is the spec's chosen Tier-2 framework, but out of the box its
LLM-judge calls a provider **directly**, which would bypass the Gateway and
break the core invariant ("all model calls go through the gateway/Bifrost —
no direct provider SDK calls"). This module bridges DeepEval to OUR gateway so
the invariant holds: DeepEval's judge is a custom ``DeepEvalBaseLLM`` whose
``generate`` routes through ``gateway.model_call`` and never opens its own
socket to a provider.

Wiring is strictly OPT-IN and never changes the default:

  * Enabled when ``SCPRISM_DEEPEVAL`` is truthy **or** a caller passes
    ``backend="deepeval"`` to ``evals.evaluate`` — AND ``deepeval`` is
    importable in the running interpreter.
  * Otherwise the stdlib judge in ``evals.evaluate`` runs unchanged.

Offline safety: when no real provider is configured the gateway returns its
deterministic stub, which is not valid judge JSON. DeepEval then raises on the
unparseable response; we catch it per-metric and fall back to the SAME
deterministic heuristic the stdlib path uses (``evals.heuristic_metrics``). So
offline the run is reproducible and the gateway is still exercised (the call is
audited, its tokens counted) — DeepEval's real scoring engages only when the
gateway has a live provider returning parseable JSON.

The function returns the SAME ``Tier2Result`` shape as ``evals.evaluate``
(``eval_score``, ``metrics{}``, ``passed``, ``judge_notes``) and gates on the
identical score-threshold + operating-envelope discipline.
"""

from __future__ import annotations

import json
import os
import re
from itertools import zip_longest
from typing import Any, Dict, List, Optional

from .verifier import Tier2Result
from . import evals
from .evals import Envelope, METRIC_NAMES, DEFAULT_THRESHOLD

# Keep DeepEval offline-safe: opt out of its anonymous telemetry / error
# reporting / update pings so importing it never phones home. Set BEFORE the
# import so DeepEval's settings pick them up. ``setdefault`` respects an
# operator who has already chosen otherwise.
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
os.environ.setdefault("ERROR_REPORTING", "NO")
os.environ.setdefault("DEEPEVAL_UPDATE_WARNING_OPT_IN", "NO")
# Confine DeepEval's hidden cache/telemetry dir to engine/ (default is a
# ``.deepeval`` folder in CWD — which would land outside engine/**). Read at
# import of deepeval.constants, so this MUST precede the import below.
_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault(
    "DEEPEVAL_CACHE_FOLDER", os.path.join(_ENGINE_DIR, ".deepeval")
)

try:  # DeepEval lives only in engine/.venv (opt-in); guard so system python is fine.
    from deepeval.models.base_model import DeepEvalBaseLLM
    from deepeval.metrics import AnswerRelevancyMetric, GEval
    from deepeval.test_case import LLMTestCase, LLMTestCaseParams

    HAS_DEEPEVAL = True
    _IMPORT_ERROR: Optional[BaseException] = None
except Exception as exc:  # ImportError or any transitive failure
    DeepEvalBaseLLM = object  # type: ignore[assignment,misc]
    AnswerRelevancyMetric = GEval = None  # type: ignore[assignment]
    LLMTestCase = LLMTestCaseParams = None  # type: ignore[assignment]
    HAS_DEEPEVAL = False
    _IMPORT_ERROR = exc


# The judge system prompt. Carries the same "agent-evaluation judge" marker the
# stdlib judge uses so trace inspectors (and tests) can identify a judge call.
_JUDGE_SYSTEM = (
    "You are a strict, calibrated agent-evaluation judge scoring the "
    "non-deterministic quality of an execution trace against its task "
    "contract. Respond with ONLY a JSON object matching the requested schema."
)


def deepeval_available() -> bool:
    """True iff ``deepeval`` imported in THIS interpreter (i.e. the venv)."""
    return HAS_DEEPEVAL


def deepeval_enabled(env: Optional[Dict[str, str]] = None) -> bool:
    """True iff the opt-in env flag ``SCPRISM_DEEPEVAL`` is truthy."""
    env = os.environ if env is None else env
    return str(env.get("SCPRISM_DEEPEVAL", "")).strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def import_error() -> Optional[BaseException]:
    """The exception that made ``deepeval`` unimportable, or None."""
    return _IMPORT_ERROR


# --------------------------------------------------------------------------
# The gateway-bridged custom judge LLM
# --------------------------------------------------------------------------

if HAS_DEEPEVAL:

    class GatewayDeepEvalLLM(DeepEvalBaseLLM):
        """A DeepEval judge whose every ``generate`` routes through OUR gateway.

        This is the whole point of the module: DeepEval calls ``generate`` (and
        ``generate_with_schema``), which we forward to ``gateway.model_call``.
        No provider SDK, no direct socket — the invariant holds. We record call
        count + token usage so the caller can prove routing and bill tokens.
        """

        def __init__(self, gateway, *, telemetry=None, parent_id=None):
            # NB: we intentionally do NOT call super().__init__(); DeepEval's
            # base __init__ would try to load a provider model. We only need the
            # attributes its tracing wrapper and metrics touch.
            self.gateway = gateway
            self.telemetry = telemetry
            self.parent_id = parent_id
            self.name = "scprism-gateway-judge"
            self.model = None
            self.calls = 0
            self.tokens_in = 0
            self.tokens_out = 0
            self.saw_real = False

        # -- DeepEvalBaseLLM interface ---------------------------------
        def load_model(self):
            return None

        def get_model_name(self) -> str:
            return self.name

        def generate(self, prompt, schema=None, **kwargs):
            text = self._route(str(prompt))
            if schema is not None:
                obj = _coerce_to_schema(text, schema)
                if obj is not None:
                    return obj  # real provider -> valid schema -> DeepEval scores
                # else: hand back raw text; DeepEval's JSON parse will raise and
                # the caller falls back to the deterministic heuristic.
            return text

        async def a_generate(self, prompt, schema=None, **kwargs):
            return self.generate(prompt, schema=schema, **kwargs)

        # -- the gateway hop -------------------------------------------
        def _route(self, prompt: str) -> str:
            messages = [
                {"role": "system", "content": _JUDGE_SYSTEM},
                {"role": "user", "content": prompt},
            ]
            decision = self.gateway.route(prompt)  # gateway is authoritative
            res = self.gateway.model_call(messages, decision)
            self.calls += 1
            self.tokens_in += int(getattr(res, "tokens_in", 0))
            self.tokens_out += int(getattr(res, "tokens_out", 0))
            if getattr(res, "is_real", False):
                self.saw_real = True
            return res.text

else:  # keep the name importable so __init__ / callers never explode
    GatewayDeepEvalLLM = None  # type: ignore[assignment]


def _coerce_to_schema(text: str, schema_cls):
    """Parse the first balanced ``{...}`` from ``text`` into ``schema_cls``.

    Returns a validated pydantic instance on success, else None. Success means
    a real provider returned parseable JSON, so DeepEval scores for real; None
    routes to the deterministic heuristic fallback (the offline stub case).
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
    try:  # pydantic v2 (DeepEval 4.x)
        return schema_cls.model_validate(data)
    except Exception:
        try:
            return schema_cls(**data)
        except Exception:
            return None


# --------------------------------------------------------------------------
# Trace -> DeepEval test case
# --------------------------------------------------------------------------


def _format_trajectory(obs: Dict[str, Any]) -> str:
    kinds = obs.get("kinds") or []
    outputs = obs.get("outputs") or []
    routes = obs.get("routes") or []
    lines = []
    for i, (k, o, r) in enumerate(
        zip_longest(kinds, outputs, routes, fillvalue="")
    ):
        lines.append(f"  {i}. [{k or 'read'}|{r or '-'}] {str(o)[:200]}")
    return "\n".join(lines) or "  (no steps)"


def _build_test_case(contract, obs: Dict[str, Any], artifact: str, evidence=None):
    trajectory = _format_trajectory(obs)
    # Same blindness fix as the stdlib judge (`evals.format_evidence`): the
    # trace lines above are harness-truncated summaries, so a judge shown only
    # those will report a complete run as truncated. The evidence block carries
    # the MEASURED files-on-disk + real Tier-1 outcome, bounded and labelled.
    actual = (
        (artifact or "(no artifact produced)")
        + f"\n\nEXECUTION TRACE ({obs.get('steps', 1)} step(s), "
        + f"{obs.get('tokens_spent', 0)} tokens):\n"
        + trajectory
        + evals.format_evidence(evidence)
    )
    context = list(contract.acceptance_criteria) or None
    return LLMTestCase(
        input=contract.intent,
        actual_output=actual,
        context=context,
    )


def _score_of(metric) -> Optional[float]:
    score = getattr(metric, "score", None)
    if score is None:
        return None
    try:
        val = float(score)
    except (ValueError, TypeError):
        return None
    return max(0.0, min(1.0, val))


# --------------------------------------------------------------------------
# The DeepEval Tier-2 entry point (same shape as evals.evaluate)
# --------------------------------------------------------------------------


def run_deepeval(
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
    run_evidence: Optional["evals.RunEvidence"] = None,
) -> Tier2Result:
    """Run DeepEval metrics over a trace, judge routed through the gateway.

    Maps DeepEval metric scores onto our four named metrics, aggregates into
    ``eval_score``, and gates on BOTH the score threshold and the operating
    envelope — identical discipline to ``evals.evaluate``. Any metric that
    cannot score (offline stub => unparseable judge JSON, or any error) falls
    back to the deterministic ``evals.heuristic_metrics`` value for that name.
    """
    if not HAS_DEEPEVAL:
        raise RuntimeError(
            f"deepeval is not importable in this interpreter: {_IMPORT_ERROR!r}"
        )
    if gateway is None:  # never let Tier-2 bypass the gateway
        raise ValueError(
            "run_deepeval() requires a gateway — the judge must route through it"
        )

    obs = evals.observe_trace(trace)
    if not artifact:
        artifact = "\n".join(
            str(o) for o, k in zip(obs["outputs"], obs["kinds"]) if k == "write"
        ) or "\n".join(map(str, obs["outputs"]))

    fallback = evals.heuristic_metrics(contract, obs)

    def _go() -> Tier2Result:
        llm = GatewayDeepEvalLLM(
            gateway, telemetry=telemetry, parent_id=parent_id
        )
        test_case = _build_test_case(contract, obs, artifact, run_evidence)

        # Each entry: (our metric name, factory building a DeepEval metric).
        # answer-relevancy + three GEval trajectory-style metrics (specs/06 §1).
        params = [LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT]
        builders = {
            "acceptance_criteria_satisfaction": lambda: AnswerRelevancyMetric(
                model=llm, threshold=0.5, async_mode=False, verbose_mode=False
            ),
            "trajectory_sensibility": lambda: GEval(
                name="TrajectorySensibility",
                criteria=(
                    "Given the task intent and the execution trace, judge "
                    "whether the agent took a sensible, well-ordered trajectory "
                    "(e.g. reads before writes, no thrashing) to satisfy it."
                ),
                evaluation_params=params,
                model=llm,
                threshold=0.5,
                async_mode=False,
                verbose_mode=False,
            ),
            "tool_use_accuracy": lambda: GEval(
                name="ToolUseAccuracy",
                criteria=(
                    "Judge whether the trace used the right tools/routes for "
                    "each step and produced clean, error-free step outputs."
                ),
                evaluation_params=params,
                model=llm,
                threshold=0.5,
                async_mode=False,
                verbose_mode=False,
            ),
            "task_completion": lambda: GEval(
                name="TaskCompletion",
                criteria=(
                    "Judge whether every step produced output and the final "
                    "artifact actually completes the stated task intent."
                ),
                evaluation_params=params,
                model=llm,
                threshold=0.5,
                async_mode=False,
                verbose_mode=False,
            ),
        }

        metrics: Dict[str, float] = {}
        sources: Dict[str, str] = {}
        notes_bits: List[str] = []
        for name in METRIC_NAMES:
            try:
                metric = builders[name]()
                metric.measure(test_case)
                score = _score_of(metric)
                if score is None:
                    raise ValueError("metric produced no score")
                metrics[name] = round(score, 4)
                sources[name] = "deepeval"
                reason = getattr(metric, "reason", None)
                if reason:
                    notes_bits.append(f"{name}={metrics[name]} ({str(reason)[:80]})")
            except Exception as exc:  # offline/unparseable/any metric failure
                metrics[name] = fallback[name]
                sources[name] = "heuristic-fallback"
                notes_bits.append(f"{name}={metrics[name]} (fallback: {type(exc).__name__})")

        eval_score = round(sum(metrics[n] for n in METRIC_NAMES) / len(METRIC_NAMES), 4)

        env = (
            envelope
            if envelope is not None
            else evals.build_envelope(contract, latency_ms=latency_ms)
        )
        env_report = evals.check_envelope(
            env,
            tokens_spent=obs["tokens_spent"],
            steps=obs["steps"],
            latency_ms=latency_ms,
        )

        score_ok = eval_score >= threshold
        passed = score_ok and env_report.ok

        n_real = sum(1 for s in sources.values() if s == "deepeval")
        source_tag = (
            "deepeval" if n_real == len(METRIC_NAMES)
            else ("deepeval+heuristic" if n_real else "deepeval->heuristic")
        )
        reason_bits = [
            f"score={eval_score} vs threshold={threshold} -> {'ok' if score_ok else 'BELOW'}"
        ]
        reason_bits.append(
            "envelope BREACH: " + "; ".join(env_report.breaches)
            if not env_report.ok
            else "envelope ok"
        )
        # A judge claim the deterministic layer measured to be FALSE is a judge
        # error, named rather than quietly priced into a failing score.
        contradictions = evals.detect_contradictions(
            metrics, " ".join(notes_bits), run_evidence
        )
        if contradictions:
            reason_bits.append(
                "JUDGE ERROR — contradicted by deterministic evidence: "
                + "; ".join(contradictions)
            )
        judge_notes = (
            f"[{source_tag}] gateway calls={llm.calls}; "
            + " | ".join(notes_bits)
            + " || "
            + " | ".join(reason_bits)
        )

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
            tokens=llm.tokens_in + llm.tokens_out,
            is_real=llm.saw_real,
            judge_notes=judge_notes,
            rationale=judge_notes,
            contradictions=contradictions,
        )

    # Wrap the whole DeepEval run in one eval span (mirrors evals.evaluate) so
    # the trace still shows a single model-backed Tier-2 judge step.
    if telemetry is not None:
        decision = gateway.route(contract.intent)
        with telemetry.span(
            "eval",
            span_type="model_call",
            parent=parent_id,
            provider=decision.provider,
            model=decision.model,
            route=decision.target,
            is_local=decision.is_local,
            backend="deepeval",
        ) as sp:
            result = _go()
            sp.set(
                tokens_in=0,
                tokens_out=result.tokens,
                is_real=result.is_real,
            )
            return result
    return _go()
