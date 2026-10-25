import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.gateway import Gateway
from scprism_engine import goldens


def _offline_gateway():
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestGoldenLoading(unittest.TestCase):
    def test_seed_goldens_load_and_validate(self):
        gs = goldens.load_goldens()
        self.assertGreaterEqual(len(gs), 3, "a handful of seed goldens exist")
        ids = {g.id for g in gs}
        self.assertIn("add-rate-limit-guard", ids)
        for g in gs:
            g.validate()  # raises on bad shape
            self.assertTrue(g.to_contract().task_id.startswith("golden-"))

    def test_unknown_key_rejected(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "bad.json")
            with open(p, "w") as fh:
                json.dump({"id": "x", "intent": "y", "bogus": 1}, fh)
            with self.assertRaises(goldens.GoldenError):
                goldens.load_golden(p)


class TestGoldenRunner(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_golden_runs_end_to_end_and_scores(self):
        g = next(x for x in goldens.load_goldens() if x.id == "add-rate-limit-guard")
        r = goldens.run_golden(g, vault=self.vault, gateway=_offline_gateway())
        self.assertTrue(r.tier1_passed)
        self.assertTrue(r.tier2_ran)
        self.assertTrue(r.envelope_ok)
        self.assertGreater(r.eval_score, 0.0)
        self.assertEqual(len(r.metrics), 4)
        self.assertTrue(r.passed)
        self.assertTrue(r.matched_expectation)
        # A verdict was persisted.
        vp = os.path.join(self.vault, "verdicts", "golden-add-rate-limit-guard.json")
        self.assertTrue(os.path.exists(vp))

    def test_runaway_golden_fails_on_envelope_breach(self):
        g = next(x for x in goldens.load_goldens() if x.id == "tight-envelope-runaway")
        r = goldens.run_golden(g, vault=self.vault, gateway=_offline_gateway())
        # The score itself clears threshold, but the tight step envelope breaks.
        self.assertGreaterEqual(r.eval_score, g.threshold)
        self.assertFalse(r.envelope_ok)
        self.assertFalse(r.passed)
        # Expected to fail -> matches its annotated expectation.
        self.assertFalse(r.expect_pass)
        self.assertTrue(r.matched_expectation)

    def test_goldens_are_rerunnable_and_deterministic(self):
        # Re-running the same goldens yields identical scores (regression base).
        first = {
            r.golden_id: r.eval_score
            for r in goldens.run_all_goldens(vault=self.vault, gateway=_offline_gateway())
        }
        second = {
            r.golden_id: r.eval_score
            for r in goldens.run_all_goldens(vault=self.vault, gateway=_offline_gateway())
        }
        self.assertEqual(first, second, "goldens must be re-runnable & deterministic")

    def test_full_suite_matches_expectations(self):
        results = goldens.run_all_goldens(vault=self.vault, gateway=_offline_gateway())
        self.assertGreaterEqual(len(results), 3)
        for r in results:
            self.assertTrue(
                r.matched_expectation,
                f"golden {r.golden_id} did not match expect_pass={r.expect_pass} "
                f"(passed={r.passed}, envelope_ok={r.envelope_ok}, score={r.eval_score})",
            )


if __name__ == "__main__":
    unittest.main()
