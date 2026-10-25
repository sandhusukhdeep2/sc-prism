"""CI gate tests (specs/06 §4, ADR-022).

Proves the score-based gate BLOCKS a regression (a golden below threshold)
rather than raising or letting it through, that the gate wires into the Stop
hook (below threshold → the write is blocked, task routes to repair), and that
the post-deploy sampler oversamples high-risk intents.
"""

import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine.evals import Envelope
from scprism_engine.goldens import load_goldens
from scprism_engine.ci_gate import (
    run_gate, CIGate, sample_traces, is_high_risk,
)


def _offline_gateway():
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestRunGate(unittest.TestCase):
    def test_seed_suite_passes_at_default_threshold(self):
        gr = run_gate(gateway=_offline_gateway())
        self.assertFalse(gr.blocked, gr.reason)
        self.assertTrue(gr.passed)
        self.assertTrue(gr.scores, "the gate reports a score per golden")

    def test_regression_below_threshold_is_blocked_not_raised(self):
        # An impossibly high threshold turns every golden into a regression.
        gr = run_gate(threshold=0.999, gateway=_offline_gateway())
        self.assertTrue(gr.blocked, "below-threshold goldens must block the gate")
        self.assertFalse(gr.passed)
        self.assertTrue(gr.blockers)
        # It returns a decision — it does NOT raise.
        self.assertIn("BLOCK", gr.reason)

    def test_envelope_breach_blocks_the_gate(self):
        goldens = load_goldens()
        # Clamp every envelope to 1 token → guaranteed runaway breach.
        envelopes = {g.id: Envelope(token_budget=1, max_steps=1) for g in goldens}
        gr = run_gate(goldens, envelopes=envelopes, gateway=_offline_gateway())
        self.assertTrue(gr.blocked, "an envelope breach is a blockable regression")

    def test_scores_are_deterministic_across_runs(self):
        a = run_gate(gateway=_offline_gateway())
        b = run_gate(gateway=_offline_gateway())
        self.assertEqual(a.scores, b.scores)


class TestStopHookWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_gate_passes_stop_ratchet_lets_the_task_finish(self):
        gate = CIGate(threshold=0.5, gateway=_offline_gateway())
        c = parse("add a guard", task_id="gate-ok", scope=["engine/**"])
        v = run(c, vault=self.vault, tier1_commands=["true"],
                gateway=_offline_gateway(), ci_gate=gate)
        self.assertTrue(v.passed, "a passing gate must not block the task")
        self.assertIsNotNone(gate.last_result)
        self.assertFalse(gate.last_result.blocked)

    def test_gate_below_threshold_blocks_the_write_via_stop_hook(self):
        # The gate can never clear 0.999, so the Stop ratchet blocks the task.
        gate = CIGate(threshold=0.999, gateway=_offline_gateway())
        c = parse("add a guard", task_id="gate-block", scope=["engine/**"])
        v = run(c, vault=self.vault, tier1_commands=["true"],
                gateway=_offline_gateway(), ci_gate=gate)
        self.assertFalse(v.passed, "a below-threshold gate must block the write")
        stop_blocks = [b for b in v.blocks if b.get("hook") == "Stop"]
        self.assertTrue(stop_blocks, "the Stop hook records the block")
        self.assertTrue(gate.last_result.blocked)

    def test_stop_ratchet_still_runs_exactly_once_with_a_gate(self):
        gate = CIGate(threshold=0.5, gateway=_offline_gateway())
        c = parse("add a guard", task_id="gate-once", scope=["engine/**"])
        v = run(c, vault=self.vault, tier1_commands=["true"],
                gateway=_offline_gateway(), ci_gate=gate)
        self.assertEqual(len([h for h in v.hooks_fired if h == "stop"]), 1)


class TestSamplingStrategy(unittest.TestCase):
    def test_high_risk_intents_are_detected(self):
        self.assertTrue(is_high_risk("refactor the prod auth module"))
        self.assertTrue(is_high_risk("delete audit history"))
        self.assertFalse(is_high_risk("tidy the README"))

    def test_oversamples_high_risk_and_can_skip_baseline(self):
        traces = [
            {"task_id": "h1", "intent": "change prod permission rule"},
            {"task_id": "h2", "intent": "migrate the billing schema"},
            {"task_id": "l1", "intent": "rename a local variable"},
            {"task_id": "l2", "intent": "update a comment"},
        ]
        # base_rate=0 → only high-risk traces are ever selected.
        selected = sample_traces(traces, base_rate=0.0, high_risk_rate=1.0)
        ids = {t["task_id"] for t in selected}
        self.assertEqual(ids, {"h1", "h2"})
        self.assertTrue(all(t["_high_risk"] for t in selected))

    def test_sampling_is_deterministic(self):
        traces = [{"task_id": f"t{i}", "intent": "generic work"} for i in range(50)]
        a = sample_traces(traces, base_rate=0.5)
        b = sample_traces(traces, base_rate=0.5)
        self.assertEqual([t["task_id"] for t in a], [t["task_id"] for t in b])


if __name__ == "__main__":
    unittest.main()
