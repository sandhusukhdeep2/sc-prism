"""Observability tests (specs/07).

Proves cost is attributable to operation + model for a run, and that drift
signals fire on an eval-score drop, a cache-hit drop, and a cost/token spike.
The module is a pure reader of spans.jsonl.
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine import observability as obs


def _offline_gateway():
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


def _model_span(run_id, name, provider, model, tin, tout, cache="miss", start=0.0):
    return {
        "run_id": run_id, "span_id": f"{run_id}-{name}-{start}", "parent_id": run_id,
        "name": name, "type": "model_call", "start": start, "end": start + 0.01,
        "duration_ms": 10.0, "status": "ok",
        "attrs": {"provider": provider, "model": model, "tokens_in": tin,
                  "tokens_out": tout, "cache": cache},
    }


def _run_span(run_id, task_id, start, eval_score=None, passed=None):
    attrs = {"task_id": task_id}
    verdict = None
    if eval_score is not None:
        verdict = {
            "run_id": run_id, "span_id": f"{run_id}-verdict", "parent_id": run_id,
            "name": "tier2", "type": "verdict", "start": start + 0.02,
            "end": start + 0.03, "duration_ms": 10.0, "status": "ok",
            "attrs": {"eval_score": eval_score, "score": eval_score,
                      "passed": bool(passed)},
        }
    root = {
        "run_id": run_id, "span_id": run_id, "parent_id": None,
        "name": f"run:{task_id}", "type": "run", "start": start,
        "end": start + 0.05, "duration_ms": 50.0, "status": "ok", "attrs": attrs,
    }
    return root, verdict


class TestCostAttribution(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_cost_attributable_to_operation_and_model_for_a_run(self):
        c = parse("architect a distributed plan", task_id="cost-1",
                  scope=["engine/**"])
        run(c, vault=self.vault, tier1_commands=["true"], gateway=_offline_gateway())
        spans = obs.load_spans(self.vault)

        by_model = obs.per_model_cost(spans)
        self.assertTrue(by_model, "at least one model must have attributed tokens")
        for model, e in by_model.items():
            self.assertGreater(e["tokens"], 0)
            self.assertEqual(e["tokens"], e["tokens_in"] + e["tokens_out"])
            self.assertIn("provider", e)

        by_op = obs.per_operation_cost(spans)
        # The dispatch model calls + the Tier-2 eval call are distinct operations.
        self.assertTrue(by_op)
        total_op_tokens = sum(e["tokens"] for e in by_op.values())
        total_model_tokens = sum(e["tokens"] for e in by_model.values())
        self.assertEqual(total_op_tokens, total_model_tokens)

    def test_cloud_route_accrues_nonzero_cost(self):
        spans = [_model_span("r1", "model_call", "claude", "claude", 1000, 500)]
        by_model = obs.per_model_cost(spans)
        self.assertGreater(by_model["claude"]["cost"], 0.0)
        # Local is free.
        local = [_model_span("r1", "model_call", "local", "local-model", 1000, 500)]
        self.assertEqual(obs.per_model_cost(local)["local-model"]["cost"], 0.0)

    def test_dashboard_bundles_the_console_views(self):
        c = parse("add a guard", task_id="dash-1", scope=["engine/**"])
        run(c, vault=self.vault, tier1_commands=["true"], gateway=_offline_gateway())
        dash = obs.dashboard(self.vault)
        for key in ("cost_by_model", "cost_by_operation", "hooks", "cache",
                    "eval_trend", "drift", "run_series", "token_burn_by_time"):
            self.assertIn(key, dash)
        self.assertGreaterEqual(dash["runs"], 1)
        # Hook health is populated (plan/dispatch/tier1/stop all fire).
        self.assertIn("stop", dash["hooks"])


class TestDriftSignals(unittest.TestCase):
    def _write_spans(self, vault, spans):
        path = os.path.join(vault, "spans.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for s in spans:
                fh.write(json.dumps(s) + "\n")

    def test_eval_score_drop_fires_a_drift_signal(self):
        spans = []
        # Three healthy runs ~0.95, then one that craters to 0.4.
        for i, score in enumerate([0.95, 0.94, 0.96, 0.40]):
            root, verdict = _run_span(f"r{i}", f"t{i}", start=float(i),
                                      eval_score=score, passed=score >= 0.7)
            spans.append(root)
            spans.append(_model_span(f"r{i}", "model_call", "local", "m", 100, 50,
                                     cache="miss", start=float(i)))
            spans.append(verdict)
        signals = obs.detect_drift(spans)
        kinds = [s.kind for s in signals]
        self.assertIn("eval_score_drop", kinds)
        sig = next(s for s in signals if s.kind == "eval_score_drop")
        self.assertLess(sig.delta, 0)
        self.assertEqual(sig.severity, "alert")

    def test_cache_hit_drop_fires_a_drift_signal(self):
        spans = []
        # Warm cache runs (all hits), then a cold namespace run (all misses).
        plan = [("prompt", "prompt"), ("prompt", "semantic"),
                ("prompt", "prompt"), ("miss", "miss")]
        for i, (a, b) in enumerate(plan):
            root, _ = _run_span(f"r{i}", f"t{i}", start=float(i))
            spans.append(root)
            spans.append(_model_span(f"r{i}", "model_call", "local", "m", 100, 50,
                                     cache=a, start=float(i)))
            spans.append(_model_span(f"r{i}", "model_call", "local", "m", 100, 50,
                                     cache=b, start=float(i) + 0.001))
        signals = obs.detect_drift(spans)
        self.assertIn("cache_hit_drop", [s.kind for s in signals])

    def test_cost_spike_speaks_money_a_person_reads(self):
        # The Console showed "cost spiked to 0.0026 vs baseline 0.0017 (>= 1.5x)"
        # — raw four-decimal dollars and a ratio flag, on the card labelled THE
        # CEO VIEW. The reason must name money the way a person says it (cents
        # when under a nickel, dollars otherwise), the real multiple, and the
        # usual explanation — never the word "baseline" with four decimals.
        tiny = obs.cost_spike_reason(0.0017, 0.0026)
        self.assertIn("0.26¢", tiny)
        self.assertIn("0.17¢", tiny)
        self.assertIn("1.5×", tiny)
        self.assertIn("recent average", tiny)
        self.assertNotIn("baseline", tiny)
        real = obs.cost_spike_reason(1.0, 2.6)
        self.assertIn("$2.60", real)
        self.assertIn("2.6×", real)

    def test_cost_spike_fires_on_token_runaway(self):
        spans = []
        for i, toks in enumerate([100, 110, 90, 5000]):
            root, _ = _run_span(f"r{i}", f"t{i}", start=float(i))
            spans.append(root)
            spans.append(_model_span(f"r{i}", "model_call", "local", "m",
                                     toks, 0, cache="miss", start=float(i)))
        signals = obs.detect_drift(spans)
        self.assertIn("cost_spike", [s.kind for s in signals])

    def test_no_drift_on_steady_state(self):
        spans = []
        for i, score in enumerate([0.9, 0.91, 0.9, 0.92]):
            root, verdict = _run_span(f"r{i}", f"t{i}", start=float(i),
                                      eval_score=score, passed=True)
            spans.append(root)
            spans.append(_model_span(f"r{i}", "model_call", "local", "m", 100, 50,
                                     cache="prompt", start=float(i)))
            spans.append(verdict)
        self.assertEqual(obs.detect_drift(spans), [])


if __name__ == "__main__":
    unittest.main()
