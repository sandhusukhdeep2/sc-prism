"""GRPO training pipeline tests (specs/10, ADR-017) — the REAL flywheel.

Proves the mechanics that make this GRPO and not SFT, and the gate that makes
promotion safe:

  * ``group_relative_advantages`` normalises reward WITHIN each group — every
    group's advantages have mean ~0 (unit-ish scale).
  * The reference policy-gradient GRPO update CONVERGES: training on records
    whose reward favours an action raises that action's probability AND the
    policy's expected reward (the flywheel measurably works).
  * The eval-lift gate PROMOTES a lifting candidate and DISCARDS a regressing
    one; on DISCARD the live weights are unchanged (ADR-017 non-regression).
  * ``ModelRegistry`` versions promoted weights, ties them to the justifying
    eval run, and can roll back.
  * A full ``train`` run on seeded records yields a decision; an empty/missing
    records file is a clean no-op.
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import grpo
from scprism_engine.grpo import (
    GateDecision,
    GRPOTrainer,
    ModelRegistry,
    RoutePolicy,
    eval_lift_gate,
    expected_reward,
    group_records,
    group_relative_advantages,
    promote_or_discard,
    run_training_pipeline,
    task_bucket,
)
from scprism_engine.contract import parse
from scprism_engine.loop import run


def _rec(bucket, action, reward):
    """A minimal synthetic training record (the seam's shape, trimmed)."""
    return {"bucket": bucket, "action": action, "reward": {"value": float(reward)}}


def _favouring_local(copies=4):
    """Records where, within each bucket, 'local' clearly out-rewards 'cloud'."""
    recs = []
    for _ in range(copies):
        recs.append(_rec("test-gen", "local", 0.9))
        recs.append(_rec("test-gen", "cloud", 0.2))
        recs.append(_rec("refactor", "local", 0.8))
        recs.append(_rec("refactor", "cloud", 0.3))
    return recs


class TestAdvantages(unittest.TestCase):
    def test_group_relative_mean_is_zero_per_group(self):
        recs = _favouring_local()
        adv = group_relative_advantages(recs)
        groups = group_records(recs)
        self.assertEqual(set(groups), {"test-gen", "refactor"})
        for bucket, idxs in groups.items():
            self.assertGreater(len(idxs), 1)
            mean = sum(adv[i] for i in idxs) / len(idxs)
            self.assertAlmostEqual(mean, 0.0, places=9, msg=f"group {bucket} mean != 0")

    def test_unit_ish_scale_and_sign(self):
        recs = _favouring_local()
        adv = group_relative_advantages(recs)
        # The higher-reward action ('local', reward 0.9/0.8) gets POSITIVE
        # advantage; the lower ('cloud') negative — that is the learning signal.
        for i, r in enumerate(recs):
            if r["action"] == "local":
                self.assertGreater(adv[i], 0.0)
            else:
                self.assertLess(adv[i], 0.0)
        # Unit-ish: magnitudes are O(1), not O(reward).
        self.assertTrue(all(abs(a) <= 5.0 for a in adv))

    def test_singleton_group_has_zero_advantage(self):
        recs = [_rec("only-one", "local", 0.9)]
        adv = group_relative_advantages(recs)
        self.assertEqual(adv, [0.0])

    def test_zero_variance_group_has_zero_advantage(self):
        recs = [_rec("flat", "local", 0.5), _rec("flat", "cloud", 0.5)]
        adv = group_relative_advantages(recs)
        self.assertEqual(adv, [0.0, 0.0])

    def test_default_bucketing_is_by_intent_task_type(self):
        # No explicit bucket -> grouped by coarse task_type from the intent.
        self.assertEqual(task_bucket({"task_intent": "generate tests for parser"}), "test-gen")
        self.assertEqual(task_bucket({"task_intent": "refactor the auth login module"}), "auth-security")
        self.assertEqual(task_bucket({"task_intent": "summarize the config"}), "retrieval")
        self.assertEqual(task_bucket({"task_intent": "do a thing"}), "general")


class TestReferencePolicyConverges(unittest.TestCase):
    def test_update_increases_favoured_action_probability(self):
        recs = _favouring_local()
        policy = RoutePolicy()
        # Untrained prior is uniform.
        self.assertAlmostEqual(policy.act("test-gen")["local"], 0.5)

        trainer = GRPOTrainer(epochs=60, lr=0.5)
        policy, metrics = trainer.train(recs, policy)

        # The favoured action's probability rose well above 0.5 in every bucket.
        self.assertGreater(policy.act("test-gen")["local"], 0.9)
        self.assertGreater(policy.act("refactor")["local"], 0.9)

    def test_expected_reward_rises_the_flywheel_converges(self):
        recs = _favouring_local()
        policy = RoutePolicy()
        trainer = GRPOTrainer(epochs=60, lr=0.5)
        policy, metrics = trainer.train(recs, policy)

        self.assertGreater(
            metrics.expected_reward_after,
            metrics.expected_reward_before,
            "GRPO must raise expected reward — the flywheel did not converge",
        )
        self.assertGreater(metrics.lift, 0.0)
        # Monotonic-ish: the last epoch is at least as good as the first.
        self.assertGreaterEqual(metrics.per_epoch[-1], metrics.per_epoch[0])

    def test_training_is_deterministic(self):
        recs = _favouring_local()
        p1, m1 = GRPOTrainer(epochs=40, lr=0.4).train(recs, RoutePolicy())
        p2, m2 = GRPOTrainer(epochs=40, lr=0.4).train(recs, RoutePolicy())
        self.assertEqual(p1.snapshot(), p2.snapshot())
        self.assertEqual(m1.to_dict(), m2.to_dict())

    def test_snapshot_restore_roundtrips(self):
        policy, _ = GRPOTrainer(epochs=20).train(_favouring_local(), RoutePolicy())
        snap = policy.snapshot()
        twin = RoutePolicy()
        twin.restore(snap)
        self.assertEqual(twin.act("test-gen"), policy.act("test-gen"))

    def test_empty_records_is_a_noop(self):
        policy = RoutePolicy()
        before = policy.snapshot()
        policy, metrics = GRPOTrainer().train([], policy)
        self.assertEqual(policy.snapshot(), before)
        self.assertEqual(metrics.records, 0)
        self.assertEqual(metrics.lift, 0.0)


class TestEvalLiftGate(unittest.TestCase):
    """The gate is the non-negotiable rule (specs/10 §5 / ADR-017)."""

    def _items(self):
        # Three eval items with a known preferred action per context.
        class Item:
            def __init__(self, id_, ctx, pref):
                self.id = id_
                self.ctx = ctx
                self.pref = pref

        return [
            Item("a", "test-gen", "local"),
            Item("b", "refactor", "local"),
            Item("c", "reasoning", "cloud"),
        ]

    def _score_fn(self):
        def score(policy, item):
            return policy.act(item.ctx).get(item.pref, 0.0)

        return score

    def _policy_for(self, prefs):
        """A policy that concentrates probability on ``prefs[ctx]``."""
        p = RoutePolicy()
        for ctx, action in prefs.items():
            p.logits.setdefault(ctx, {"local": 0.0, "cloud": 0.0})[action] = 5.0
        return p

    def test_promotes_a_lifting_candidate(self):
        base = RoutePolicy()  # uniform: 0.5 on every item
        cand = self._policy_for(
            {"test-gen": "local", "refactor": "local", "reasoning": "cloud"}
        )
        dec = eval_lift_gate(base, cand, self._items(), score_fn=self._score_fn())
        self.assertTrue(dec.promote)
        self.assertGreater(dec.lift, 0.0)
        self.assertEqual(dec.regressions, [])

    def test_discards_a_regressing_candidate(self):
        # Candidate improves two items but REGRESSES 'reasoning' (mass on the
        # wrong action). Even though the mean might rise, one regression discards.
        base = self._policy_for(
            {"test-gen": "local", "refactor": "local", "reasoning": "cloud"}
        )
        cand = self._policy_for(
            {"test-gen": "local", "refactor": "local", "reasoning": "local"}
        )
        dec = eval_lift_gate(base, cand, self._items(), score_fn=self._score_fn())
        self.assertFalse(dec.promote)
        self.assertIn("c", dec.regressions)

    def test_discards_when_no_lift(self):
        base = RoutePolicy()
        cand = RoutePolicy()  # identical -> zero lift
        dec = eval_lift_gate(base, cand, self._items(), score_fn=self._score_fn())
        self.assertFalse(dec.promote)
        self.assertEqual(dec.lift, 0.0)

    def test_no_goldens_cannot_promote(self):
        dec = eval_lift_gate(RoutePolicy(), RoutePolicy(), [], score_fn=self._score_fn())
        self.assertFalse(dec.promote)

    def test_gate_runs_against_real_seed_goldens(self):
        # The default proxy scorer works against the real golden suite.
        base = RoutePolicy()
        cand = base.clone()
        from scprism_engine.goldens import load_goldens

        for g in load_goldens():
            ctx = grpo._golden_context(g)
            pref = grpo.golden_preferred_action(g)
            cand.logits.setdefault(ctx, {"local": 0.0, "cloud": 0.0})[pref] = 4.0
        dec = eval_lift_gate(base, cand)  # loads the seed goldens
        self.assertTrue(dec.promote)
        self.assertEqual(dec.regressions, [])


class TestPromoteOrDiscardAndRegistry(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _promote_decision(self):
        return GateDecision(
            promote=True, lift=0.3, min_lift=0.0,
            baseline_mean=0.5, candidate_mean=0.8, reason="lift proven",
        )

    def _discard_decision(self):
        return GateDecision(
            promote=False, lift=-0.1, min_lift=0.0,
            baseline_mean=0.5, candidate_mean=0.4, reason="regressed",
            regressions=["a"],
        )

    def test_promote_versions_weights_tied_to_eval_run(self):
        pol = RoutePolicy()
        pol.logits["x"] = {"local": 3.0, "cloud": 0.0}
        out = promote_or_discard(self._promote_decision(), pol, vault=self.vault)
        self.assertTrue(out["promoted"])
        self.assertEqual(out["version"], "v1")

        reg = ModelRegistry(self.vault)
        manifest = reg.load_manifest("v1")
        # The version is tied to the eval run that justified it (specs/10 §5/§7).
        self.assertEqual(manifest["justified_by"]["decision"], "PROMOTE")
        self.assertIn("STUB", manifest["encryption"])  # honest at-rest note
        self.assertIsNotNone(reg.load_weights("v1"))
        self.assertEqual(reg.current()["version"], "v1")

    def test_discard_leaves_weights_unchanged(self):
        # Promote v1 first, then a discard must NOT write a v2 or change current.
        reg = ModelRegistry(self.vault)
        reg.promote(RoutePolicy(), self._promote_decision())
        before_versions = reg.versions()
        before_current = reg.current()

        out = promote_or_discard(self._discard_decision(), RoutePolicy(), vault=self.vault)
        self.assertFalse(out["promoted"])
        self.assertEqual(out["decision"], "DISCARD")
        # ADR-017: the previous weights stay; nothing new was written.
        self.assertEqual(ModelRegistry(self.vault).versions(), before_versions)
        self.assertEqual(ModelRegistry(self.vault).current(), before_current)

    def test_rollback_reverts_to_previous_version(self):
        reg = ModelRegistry(self.vault)
        reg.promote(RoutePolicy(), self._promote_decision())
        reg.promote(RoutePolicy(), self._promote_decision())
        self.assertEqual(reg.current()["version"], "v2")
        rolled = reg.rollback()
        self.assertEqual(rolled["version"], "v1")

    def test_dry_run_promote_does_not_persist(self):
        out = promote_or_discard(self._promote_decision(), RoutePolicy(), vault=None)
        self.assertTrue(out["promoted"])
        self.assertIsNone(out["version"])


class TestFullPipelineCLI(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_empty_vault_is_clean_noop(self):
        report = run_training_pipeline(self.vault)
        self.assertEqual(report["records"], 0)
        self.assertFalse(report["trained"])
        self.assertFalse(report["promoted"])
        self.assertEqual(report["decision"], "NOOP")

    def test_full_run_on_seeded_records_yields_a_decision(self):
        # Seed real records through the loop (the seam writes them).
        for i, intent in enumerate(
            ["add a test for the parser", "refactor the auth login module",
             "summarize the config files", "generate tests for the handler"]
        ):
            run(parse(intent, task_id=f"t{i}"), vault=self.vault, tier1_commands=["true"])

        report = run_training_pipeline(self.vault, dry_run=True)
        self.assertEqual(report["records"], 4)
        self.assertTrue(report["trained"])
        # A decision was reached (PROMOTE or DISCARD are both valid outcomes).
        self.assertIn(report["gate"]["decision"], ("PROMOTE", "DISCARD"))
        self.assertIn("reward_before", report)
        self.assertIn("reward_after", report)

    def test_cli_train_subcommand_emits_json(self):
        from scprism_engine.__main__ import main
        import contextlib
        import io

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(["train", "--vault", self.vault, "--dry-run"])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["records"], 0)
        self.assertEqual(payload["decision"], "NOOP")


class TestLLMBackendGate(unittest.TestCase):
    def test_llm_policy_is_opt_in(self):
        # Not requested -> raises clearly (never silently a broken heavy path).
        with self.assertRaises(RuntimeError):
            grpo.LLMPolicy(env={})

    def test_llm_backend_requested_reads_flag(self):
        self.assertTrue(grpo.llm_backend_requested({"SCPRISM_GRPO_LLM": "1"}))
        self.assertFalse(grpo.llm_backend_requested({}))

    def test_llm_policy_raises_when_libs_absent(self):
        # Requested but the heavy libs are (almost certainly) not installed in
        # this stdlib-only environment -> a clear raise, no pip, no crash.
        if grpo.llm_backend_available():
            self.skipTest("heavy ML libs present; skip the absent-libs path")
        with self.assertRaises(RuntimeError):
            grpo.LLMPolicy(env={"SCPRISM_GRPO_LLM": "1"})


if __name__ == "__main__":
    unittest.main()
