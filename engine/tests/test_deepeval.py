"""Tests for the OPT-IN DeepEval Tier-2 backend (engine/scprism_engine/deepeval_backend.py).

DeepEval is installed ONLY in engine/.venv (opt-in), so under the system python
that runs `python3 -m unittest discover -s engine/tests` it is NOT importable.
These tests therefore SKIP cleanly unless deepeval imports in the CURRENT
interpreter. To actually run them:

    cd <repository root>
    engine/.venv/bin/python -m unittest engine.tests.test_deepeval -v

The suite stays green either way: skipped under system python, executed under
the venv python.
"""

import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.dispatcher import dispatch
from scprism_engine.planner import plan
from scprism_engine.gateway import Gateway
from scprism_engine.loop import run
from scprism_engine import evals
from scprism_engine import deepeval_backend

# Hard skip-gate: if deepeval can't import in THIS interpreter, skip the module.
if not deepeval_backend.deepeval_available():
    raise unittest.SkipTest(
        "deepeval not importable in this interpreter "
        f"(run via engine/.venv/bin/python). import_error={deepeval_backend.import_error()!r}"
    )


def _offline_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class _SpyGateway(Gateway):
    """Records every model_call so we can prove the DeepEval judge routes
    through the gateway (never a direct provider call)."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.calls = []

    def model_call(self, messages, route):
        self.calls.append(messages)
        return super().model_call(messages, route)


def _trace(intent="add a rate-limit guard"):
    contract = parse(intent, task_id="deepeval-obs")
    return contract, dispatch(plan(contract))


class TestDeepEvalRoutesThroughGateway(unittest.TestCase):
    def test_requires_a_gateway(self):
        contract, tr = _trace()
        with self.assertRaises(ValueError):
            deepeval_backend.run_deepeval(contract, tr, gateway=None)

    def test_judge_routes_through_gateway_no_direct_network(self):
        contract, tr = _trace()
        gw = _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        r = deepeval_backend.run_deepeval(contract, tr, gateway=gw)

        # The DeepEval judge reached the model ONLY through the gateway.
        self.assertTrue(gw.calls, "DeepEval judge must call gateway.model_call")
        judge_calls = [
            c
            for c in gw.calls
            if any("agent-evaluation judge" in str(m.get("content", "")) for m in c)
        ]
        self.assertTrue(
            judge_calls, "a gateway call must carry the DeepEval judge prompt"
        )

        # Offline stub -> no real provider was hit (no direct network).
        self.assertFalse(r.is_real)
        self.assertGreater(r.tokens, 0, "judge spends (stub) tokens via the gateway")

    def test_returns_valid_tier2result_shape(self):
        contract, tr = _trace()
        r = deepeval_backend.run_deepeval(contract, tr, gateway=_offline_gateway())
        self.assertTrue(r.ran)
        # Same Tier2Result shape / four named metrics as evals.evaluate.
        self.assertEqual(set(r.metrics), set(evals.METRIC_NAMES))
        for name in evals.METRIC_NAMES:
            self.assertGreaterEqual(r.metrics[name], 0.0)
            self.assertLessEqual(r.metrics[name], 1.0)
        self.assertEqual(r.eval_score, r.score)
        self.assertIsInstance(r.passed, bool)
        self.assertTrue(r.judge_notes)
        self.assertIn("deepeval", r.judge_notes.lower())

    def test_deterministic_offline(self):
        contract, tr = _trace()
        r1 = deepeval_backend.run_deepeval(contract, tr, gateway=_offline_gateway())
        r2 = deepeval_backend.run_deepeval(contract, tr, gateway=_offline_gateway())
        self.assertEqual(r1.eval_score, r2.eval_score)
        self.assertEqual(r1.metrics, r2.metrics)

    def test_envelope_breach_fails_even_with_good_score(self):
        contract, tr = _trace()
        tiny = evals.Envelope(max_steps=1)  # trace has multiple steps
        r = deepeval_backend.run_deepeval(
            contract, tr, gateway=_offline_gateway(), envelope=tiny
        )
        self.assertFalse(r.envelope_ok)
        self.assertFalse(r.passed, "envelope breach must fail Tier-2")
        self.assertTrue(r.breaches)


class TestOptInWiring(unittest.TestCase):
    def test_evaluate_backend_arg_selects_deepeval(self):
        contract, tr = _trace()
        gw = _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        r = evals.evaluate(contract, tr, gateway=gw, backend="deepeval")
        self.assertIn("deepeval", r.judge_notes.lower())
        self.assertTrue(gw.calls)

    def test_evaluate_env_flag_selects_deepeval(self):
        self.assertTrue(evals._use_deepeval(None, env={"SCPRISM_DEEPEVAL": "1"}))
        self.assertFalse(evals._use_deepeval(None, env={}))
        # Explicit arg overrides env.
        self.assertFalse(evals._use_deepeval("stdlib", env={"SCPRISM_DEEPEVAL": "1"}))

    def test_default_evaluate_is_unchanged_stdlib(self):
        # No backend arg, no env flag -> stdlib judge (source tag not deepeval).
        contract, tr = _trace()
        r = evals.evaluate(contract, tr, gateway=_offline_gateway())
        self.assertNotIn("deepeval", r.judge_notes.lower())
        self.assertIn("offline-heuristic", r.judge_notes.lower())


class TestTier1ShortCircuit(unittest.TestCase):
    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_tier1_fail_short_circuits_deepeval(self):
        import os

        from scprism_engine.telemetry import read_spans

        contract = parse("add a broken thing", task_id="deepeval-noeval")
        gw = _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        # Force the DeepEval backend on via env for this loop run.
        os.environ["SCPRISM_DEEPEVAL"] = "1"
        try:
            v = run(
                contract,
                vault=self.vault,
                tier1_commands=["exit 5"],  # Tier-1 fails
                gateway=gw,
            )
        finally:
            os.environ.pop("SCPRISM_DEEPEVAL", None)

        self.assertFalse(v.passed)
        self.assertFalse(v.tier2["ran"], "Tier-2 must not run when Tier-1 fails")
        # No judge span, and the judge never called the gateway.
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertFalse(any(s["name"] == "eval" for s in spans))
        judge_calls = [
            c
            for c in gw.calls
            if any("agent-evaluation judge" in str(m.get("content", "")) for m in c)
        ]
        self.assertFalse(judge_calls, "no DeepEval judge call on Tier-1 fail")

    def test_tier1_pass_runs_deepeval_via_env(self):
        import os

        contract = parse("add a rate-limit guard", task_id="deepeval-evalspan")
        gw = _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        os.environ["SCPRISM_DEEPEVAL"] = "1"
        try:
            v = run(contract, vault=self.vault, tier1_commands=["true"], gateway=gw)
        finally:
            os.environ.pop("SCPRISM_DEEPEVAL", None)

        self.assertTrue(v.tier1["passed"])
        self.assertTrue(v.tier2["ran"])
        # The DeepEval judge routed through the gateway.
        judge_calls = [
            c
            for c in gw.calls
            if any("agent-evaluation judge" in str(m.get("content", "")) for m in c)
        ]
        self.assertTrue(judge_calls, "DeepEval judge must route through the gateway")


if __name__ == "__main__":
    unittest.main()
