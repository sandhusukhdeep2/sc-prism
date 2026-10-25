"""GRPO training-record seam tests (specs/10, ADR-017 — the SEAM ONLY).

Proves the seam's guarantees:
  * a passing task emits EXACTLY ONE complete training record with the reward
    fields (provable from the Verdict);
  * a Tier-1 FAIL and a Tier-2 FAIL each emit NO training record;
  * the reward — envelope efficiency in particular — is computed correctly;
  * the record is honest that it is a seam (reward computed, not applied).
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.verifier import Tier2Result
from scprism_engine import training
from scprism_engine.training import (
    compute_reward,
    envelope_efficiency,
    build_record,
    read_records,
    DEFAULT_WEIGHTS,
    TRAINING_RELPATH,
)


class TestRewardMath(unittest.TestCase):
    def test_envelope_efficiency_basic(self):
        # (budget - used) / budget
        self.assertAlmostEqual(envelope_efficiency(0, 1000), 1.0)
        self.assertAlmostEqual(envelope_efficiency(250, 1000), 0.75)
        self.assertAlmostEqual(envelope_efficiency(1000, 1000), 0.0)

    def test_envelope_efficiency_clamped_and_degenerate(self):
        # Over budget clamps to 0, not negative.
        self.assertEqual(envelope_efficiency(2000, 1000), 0.0)
        # No/zero budget -> 0 (nothing to be efficient against).
        self.assertEqual(envelope_efficiency(10, 0), 0.0)
        self.assertEqual(envelope_efficiency(10, None), 0.0)

    def test_compute_reward_matches_sketch(self):
        # reward = w1*t1 + w2*t2 + w3*eff - penalty*blocks
        w = DEFAULT_WEIGHTS
        r = compute_reward(
            tier1_pass=True, tier2_score=0.8,
            tokens_spent=200, token_budget=1000, hook_blocks=1,
        )
        eff = 0.8  # (1000-200)/1000
        expected = w.w1 * 1.0 + w.w2 * 0.8 + w.w3 * eff - w.penalty * 1
        self.assertAlmostEqual(r.value, round(expected, 6))
        self.assertEqual(r.tier1_pass, 1.0)
        self.assertAlmostEqual(r.envelope_efficiency, eff)
        self.assertEqual(r.hook_blocks, 1)

    def test_reward_is_computed_not_applied(self):
        r = compute_reward(
            tier1_pass=True, tier2_score=1.0,
            tokens_spent=0, token_budget=1000, hook_blocks=0,
        ).to_dict()
        self.assertFalse(r["applied"])
        self.assertIn("formula", r)
        self.assertIn("weights", r)


class TestSeamViaLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _records_path(self):
        return os.path.join(self.vault, TRAINING_RELPATH)

    def test_passing_task_emits_exactly_one_complete_record(self):
        contract = parse("add a rate-limit guard", task_id="t-pass-1")
        verdict = run(contract, vault=self.vault, tier1_commands=["true"])
        self.assertTrue(verdict.passed)

        records = read_records(self.vault)
        self.assertEqual(len(records), 1, "exactly one training record")
        rec = records[0]

        # Complete record shape (specs/10 §1).
        for key in (
            "inputs", "task_intent", "tools_used", "trajectory",
            "final_verdict", "reward", "tokens_spent", "steps", "timestamp",
        ):
            self.assertIn(key, rec, f"missing field: {key}")

        # Reward fields (specs/10 §3).
        for key in (
            "tier1_pass", "tier2_score", "envelope_efficiency",
            "hook_blocks", "value", "weights",
        ):
            self.assertIn(key, rec["reward"], f"missing reward field: {key}")

        self.assertEqual(rec["task_id"], "t-pass-1")
        self.assertEqual(rec["task_intent"], "add a rate-limit guard")
        self.assertTrue(rec["final_verdict"]["passed"])
        self.assertTrue(rec["final_verdict"]["tier1_passed"])
        self.assertTrue(rec["final_verdict"]["tier2_passed"])
        self.assertTrue(rec["seam"])
        self.assertFalse(rec["reward"]["applied"])
        # Reward is derivable from the Verdict — recompute and compare.
        expected = compute_reward(
            tier1_pass=True,
            tier2_score=rec["reward"]["tier2_score"],
            tokens_spent=rec["tokens_spent"],
            token_budget=rec["inputs"]["token_budget"],
            hook_blocks=rec["reward"]["hook_blocks"],
        )
        self.assertAlmostEqual(rec["reward"]["value"], expected.value)

    def test_two_passing_tasks_emit_two_records_appended(self):
        run(parse("task one", task_id="t-a"), vault=self.vault, tier1_commands=["true"])
        run(parse("task two", task_id="t-b"), vault=self.vault, tier1_commands=["true"])
        records = read_records(self.vault)
        self.assertEqual(len(records), 2)
        self.assertEqual([r["task_id"] for r in records], ["t-a", "t-b"])

    def test_tier1_fail_emits_no_record(self):
        contract = parse("broken tier1", task_id="t-fail-t1")
        verdict = run(contract, vault=self.vault, tier1_commands=["exit 3"])
        self.assertFalse(verdict.passed)
        self.assertFalse(verdict.tier1["passed"])
        self.assertFalse(os.path.exists(self._records_path()))
        self.assertEqual(read_records(self.vault), [])

    def test_tier2_fail_emits_no_record(self):
        # Inject a judge that fails Tier-2 even though Tier-1 passes.
        def failing_judge(_trace):
            return Tier2Result(
                ran=True, score=0.1, eval_score=0.1, threshold=0.7, passed=False,
                tokens=5,
            )

        contract = parse("tier2 will fail", task_id="t-fail-t2")
        verdict = run(
            contract, vault=self.vault, tier1_commands=["true"], judge=failing_judge,
        )
        self.assertFalse(verdict.passed)
        self.assertTrue(verdict.tier1["passed"])
        self.assertFalse(verdict.tier2["passed"])
        # Stop-hook was a PASS on Tier-1, but Tier-2 failed -> NO record.
        self.assertEqual(read_records(self.vault), [])

    def test_record_training_flag_disables_emission(self):
        contract = parse("no seam please", task_id="t-noseam")
        run(contract, vault=self.vault, tier1_commands=["true"], record_training=False)
        self.assertEqual(read_records(self.vault), [])

    def test_record_provable_from_verdict_object(self):
        # build_record over a real Verdict reproduces what the loop wrote.
        contract = parse("provable", task_id="t-prov")
        verdict = run(contract, vault=self.vault, tier1_commands=["true"])
        rebuilt = build_record(contract, verdict, stop_compliant=True, steps=2)
        written = read_records(self.vault)[0]
        self.assertEqual(rebuilt["task_id"], written["task_id"])
        self.assertEqual(rebuilt["reward"]["value"], written["reward"]["value"])
        self.assertEqual(rebuilt["tools_used"], written["tools_used"])


if __name__ == "__main__":
    unittest.main()
