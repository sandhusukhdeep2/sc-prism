import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine.telemetry import read_spans
from scprism_engine.writeback import Verdict, VerdictError, build_verdict
from scprism_engine.verifier import tier1, tier2


def _offline_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestRunSpans(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_run_emits_expected_span_types_and_is_reconstructable(self):
        contract = parse("add a rate-limit guard", task_id="t-spans")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
        )

        spans_path = os.path.join(self.vault, "spans.jsonl")
        self.assertTrue(os.path.exists(spans_path))
        self.assertEqual(verdict.spans_path, spans_path)

        spans = read_spans(spans_path)
        types = {s["type"] for s in spans}
        # Every loop stage produced a typed span.
        for expected in ("run", "hook", "model_call", "tool_exec", "verdict"):
            self.assertIn(expected, types, f"missing span type {expected!r}")

        # Exactly one root run span; every other span nests under it or a child.
        roots = [s for s in spans if s["type"] == "run"]
        self.assertEqual(len(roots), 1, "exactly one root run span")
        run_id = roots[0]["run_id"]
        self.assertTrue(all(s["run_id"] == run_id for s in spans))

        # Reconstruct the parent graph: no orphan spans (all non-root spans
        # resolve to a known span id, ultimately the root).
        by_id = {s["span_id"]: s for s in spans}
        root_id = roots[0]["span_id"]
        for s in spans:
            if s["span_id"] == root_id:
                self.assertIsNone(s["parent_id"])
                continue
            self.assertIn(s["parent_id"], by_id, "span parent must exist (no orphan)")

        # A model_call span carries cache + token attribution.
        mc = next(s for s in spans if s["type"] == "model_call" and s["name"] == "model_call")
        self.assertIn("cache", mc["attrs"])
        self.assertIn("tokens_out", mc["attrs"])

    def test_tier1_fail_short_circuits_no_tier2_model_call(self):
        # A judge that records whether it was ever invoked (the Tier-2 model).
        calls = {"n": 0}

        def spy_judge(trace):
            calls["n"] += 1
            return tier2(trace)

        contract = parse("add a broken thing", task_id="t-shortcircuit")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["exit 3"],
            gateway=_offline_gateway(),
            judge=spy_judge,
        )

        self.assertFalse(verdict.passed)
        self.assertFalse(verdict.tier1["passed"])
        self.assertFalse(verdict.tier2["ran"])
        # The Tier-2 model judge was NEVER called on a Tier-1 fail.
        self.assertEqual(calls["n"], 0, "Tier-1 fail must not call the model")
        self.assertNotIn("tier2", verdict.hooks_fired)

        # And no tier2 span was emitted.
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertFalse(any(s["name"] == "tier2" for s in spans))

    def test_tier1_pass_invokes_judge_once(self):
        calls = {"n": 0}

        def spy_judge(trace):
            calls["n"] += 1
            return tier2(trace)

        contract = parse("add a passing thing", task_id="t-pass")
        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
            judge=spy_judge,
        )
        self.assertEqual(calls["n"], 1, "Tier-1 pass must invoke the judge once")


class TestVerdictSchema(unittest.TestCase):
    def _good(self):
        return build_verdict(
            task_id="ok",
            tier1_result=tier1([]),
            tier2_result=tier2("some trace"),
            tokens_spent=10,
            model_route=["local"],
            cache_hits=1,
            cache_misses=2,
        )

    def test_valid_verdict_passes_validation(self):
        v = self._good()
        self.assertIs(v.validate(), v)

    def test_empty_task_id_rejected(self):
        v = self._good()
        v.task_id = ""
        with self.assertRaises(VerdictError):
            v.validate()

    def test_negative_tokens_rejected(self):
        v = self._good()
        v.tokens_spent = -1
        with self.assertRaises(VerdictError):
            v.validate()

    def test_bad_model_route_type_rejected(self):
        v = self._good()
        v.model_route = "local"  # must be a list
        with self.assertRaises(VerdictError):
            v.validate()

    def test_negative_cache_counts_rejected(self):
        v = self._good()
        v.cache_misses = -3
        with self.assertRaises(VerdictError):
            v.validate()

    def test_verdict_records_cache_attribution(self):
        v = self._good()
        self.assertEqual(v.cache_hits, 1)
        self.assertEqual(v.cache_misses, 2)


class TestCacheAcrossSteps(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_repeat_run_warms_prompt_cache(self):
        gw = _offline_gateway()
        c1 = parse("add a rate-limit guard", task_id="warm-1")
        v1 = run(c1, vault=self.vault, tier1_commands=["true"], gateway=gw)
        # First run: all dispatch calls are cache misses.
        self.assertEqual(v1.cache_hits, 0)
        self.assertGreater(v1.cache_misses, 0)

        # Same intent, same gateway (shared process cache) -> prompt hits.
        c2 = parse("add a rate-limit guard", task_id="warm-2")
        v2 = run(c2, vault=self.vault, tier1_commands=["true"], gateway=gw)
        self.assertGreater(v2.cache_hits, 0, "repeat run should hit the prompt cache")


if __name__ == "__main__":
    unittest.main()
