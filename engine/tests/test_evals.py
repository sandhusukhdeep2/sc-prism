import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.dispatcher import dispatch
from scprism_engine.planner import plan
from scprism_engine.gateway import Gateway
from scprism_engine.loop import run
from scprism_engine.telemetry import read_spans
from scprism_engine import evals


def _offline_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class _SpyGateway(Gateway):
    """Records every model_call so we can prove the judge routes through the
    gateway (never a direct provider call)."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.calls = []

    def model_call(self, messages, route):
        self.calls.append(messages)
        return super().model_call(messages, route)


def _trace(intent="add a rate-limit guard"):
    contract = parse(intent, task_id="obs")
    return contract, dispatch(plan(contract))


class TestEnvelope(unittest.TestCase):
    def test_within_envelope_is_ok(self):
        env = evals.Envelope(token_budget=1000, max_steps=10)
        rep = evals.check_envelope(env, tokens_spent=100, steps=4)
        self.assertTrue(rep.ok)
        self.assertEqual(rep.breaches, [])

    def test_token_breach(self):
        env = evals.Envelope(token_budget=10)
        rep = evals.check_envelope(env, tokens_spent=999, steps=1)
        self.assertFalse(rep.ok)
        self.assertTrue(any("token_budget" in b for b in rep.breaches))

    def test_step_breach(self):
        env = evals.Envelope(max_steps=1)
        rep = evals.check_envelope(env, tokens_spent=1, steps=4)
        self.assertFalse(rep.ok)
        self.assertTrue(any("max_steps" in b for b in rep.breaches))

    def test_latency_only_gated_when_observed(self):
        env = evals.Envelope(latency_ms=5.0)
        # No observed latency -> not gated.
        self.assertTrue(evals.check_envelope(env, tokens_spent=1, steps=1).ok)
        # Observed over the limit -> breach.
        rep = evals.check_envelope(env, tokens_spent=1, steps=1, latency_ms=50.0)
        self.assertFalse(rep.ok)


class TestJudgeThroughGateway(unittest.TestCase):
    def test_evaluate_requires_a_gateway(self):
        contract, tr = _trace()
        with self.assertRaises(ValueError):
            evals.evaluate(contract, tr, gateway=None)

    def test_judge_routes_through_gateway_offline_deterministic(self):
        contract, tr = _trace()
        gw = _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        r1 = evals.evaluate(contract, tr, gateway=gw)
        r2 = evals.evaluate(contract, tr, gateway=gw)

        # The judge model was reached THROUGH the gateway (not a direct call),
        # and one of those calls carries the judge system prompt.
        self.assertTrue(gw.calls, "judge must call gateway.model_call")
        judge_calls = [
            c for c in gw.calls
            if any("agent-evaluation judge" in str(m.get("content", "")) for m in c)
        ]
        self.assertTrue(judge_calls, "a gateway call must be the eval judge prompt")

        # Offline stub -> deterministic score across identical runs.
        self.assertEqual(r1.eval_score, r2.eval_score)
        self.assertFalse(r1.is_real)  # offline stub, not a real provider
        self.assertGreater(r1.tokens, 0, "judge spends (stub) tokens via the gateway")
        # Four named metrics scored.
        self.assertEqual(set(r1.metrics), set(evals.METRIC_NAMES))

    def test_envelope_breach_fails_even_with_good_score(self):
        contract, tr = _trace()
        tiny = evals.Envelope(max_steps=1)  # trace has 4 steps
        r = evals.evaluate(contract, tr, gateway=_offline_gateway(), envelope=tiny)
        self.assertGreaterEqual(r.eval_score, r.threshold, "score itself is fine")
        self.assertFalse(r.envelope_ok)
        self.assertFalse(r.passed, "envelope breach must fail Tier-2")
        self.assertTrue(r.breaches)


class TestScoreGateInLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_score_below_threshold_marks_not_passed(self):
        contract = parse("add a rate-limit guard", task_id="t-lowscore")
        # Threshold above the deterministic offline score -> Tier-2 fail.
        v = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
            eval_threshold=0.999,
        )
        self.assertTrue(v.tier1["passed"])
        self.assertTrue(v.tier2["ran"])
        self.assertTrue(v.tier2["envelope_ok"])
        self.assertFalse(v.passed, "score below threshold => not-passed")

    def test_envelope_breach_in_loop_fails_verdict(self):
        contract = parse("add a logging layer", task_id="t-runaway")
        v = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
            envelope=evals.Envelope(token_budget=100000, max_steps=1),
        )
        self.assertTrue(v.tier1["passed"])
        self.assertFalse(v.tier2["envelope_ok"])
        self.assertFalse(v.passed)
        self.assertTrue(v.tier2["breaches"])

    def test_tier1_fail_emits_no_eval_span(self):
        contract = parse("add a broken thing", task_id="t-noeval")
        v = run(
            contract,
            vault=self.vault,
            tier1_commands=["exit 5"],
            gateway=_offline_gateway(),
        )
        self.assertFalse(v.passed)
        self.assertFalse(v.tier2["ran"])
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertFalse(any(s["name"] == "eval" for s in spans),
                         "no eval judge span when Tier-1 fails")
        self.assertFalse(any(s["name"] == "tier2" for s in spans))

    def test_tier1_pass_emits_eval_span_through_gateway(self):
        contract = parse("add a rate-limit guard", task_id="t-evalspan")
        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
        )
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        eval_spans = [s for s in spans if s["name"] == "eval"]
        self.assertEqual(len(eval_spans), 1, "one eval judge span on Tier-1 pass")
        self.assertEqual(eval_spans[0]["type"], "model_call")
        self.assertIn("tokens_out", eval_spans[0]["attrs"])
        self.assertFalse(eval_spans[0]["attrs"]["is_real"])  # offline
        # HONESTY: every judged completion records whether it was cut off.
        self.assertFalse(eval_spans[0]["attrs"]["truncated"])


class TestTruncationReachesTheJudge(unittest.TestCase):
    """A reply the provider CUT OFF at its output cap is graded as incomplete,
    not silently as bad writing."""

    def _trace_with(self, truncated):
        from scprism_engine.dispatcher import DispatchResult, StepResult

        return DispatchResult(
            step_results=[
                StepResult(
                    index=0,
                    description="write the report",
                    kind="write",
                    route="local",
                    output="fix 1 ... fix 2 is cut",
                    tokens=9,
                    truncated=truncated,
                )
            ],
            tokens_spent=9,
        )

    def test_observe_trace_records_the_truncated_step(self):
        self.assertEqual(
            evals.observe_trace(self._trace_with(True))["truncated_steps"], [0]
        )
        self.assertEqual(
            evals.observe_trace(self._trace_with(False))["truncated_steps"], []
        )

    def test_judge_prompt_names_the_truncation(self):
        contract = parse("write the top 3 fixes", task_id="t-trunc")
        msgs = evals._build_judge_messages(
            contract,
            evals.observe_trace(self._trace_with(True)),
            "fix 1 ... fix 2 is cut",
        )
        self.assertIn("TRUNCATION NOTICE", msgs[-1]["content"])

    def test_clean_run_carries_no_truncation_notice(self):
        contract = parse("write the top 3 fixes", task_id="t-clean")
        msgs = evals._build_judge_messages(
            contract, evals.observe_trace(self._trace_with(False)), "all three fixes"
        )
        self.assertNotIn("TRUNCATION", msgs[-1]["content"])


if __name__ == "__main__":
    unittest.main()
