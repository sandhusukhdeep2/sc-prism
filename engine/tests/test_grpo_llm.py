"""Real neural GRPO backend tests (specs/10 §6) — the flywheel, on a real model.

These prove the compute-gated ``LLMPolicy`` for REAL: a genuine torch autograd
update on a tiny causal LM moves the policy per the group-relative reward
advantages. They run ONLY where ``torch``/``transformers`` are importable (the
dedicated ``engine/.venv-llm``); the stdlib 3.9 suite skips this module cleanly
so ``verify.sh`` stays green everywhere.

What is proven here (an honest, tiny, CPU proof of the mechanism):

  * A real ``transformers`` model is constructed with NO download (tiny
    random-init GPT-2, byte-level vocab) — a few thousand real parameters.
  * A real GRPO step runs: ``loss = -(advantage * logprob).mean()``,
    ``loss.backward()``, optimizer step. Parameters change (grad flows).
  * A POSITIVE-advantage record raises its completion's log-prob; a NEGATIVE one
    lowers it — the policy-gradient signal, on a neural network.
  * It satisfies the ``Policy`` protocol, so ``GRPOTrainer`` raises the policy's
    expected reward (the flywheel turns) and ``eval_lift_gate`` can promote a
    trained candidate over its cloned baseline.

This proves the neural update EXECUTES and MOVES the policy in the reward
direction — not that a tiny random model has learned to code.
"""

import unittest

import _bootstrap  # noqa: F401

try:  # The whole module is a no-op unless the heavy libs are importable.
    import torch  # noqa: F401
    import transformers  # noqa: F401

    _HAS_TORCH = True
except Exception:  # pragma: no cover - the 3.9 / venv-less path
    _HAS_TORCH = False


def _rec(bucket, action, reward):
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


@unittest.skipUnless(_HAS_TORCH, "torch/transformers not importable (stdlib env) — skip the real-LLM proof")
class TestLLMPolicyRealNeuralUpdate(unittest.TestCase):
    """A GENUINE torch GRPO update on a tiny model — the compute-gated proof."""

    def _policy(self, **kw):
        from scprism_engine.grpo_llm import LLMPolicy

        return LLMPolicy(seed=0, lr=0.05, **kw)

    # -- the model is real and tiny, and needs no download ----------------

    def test_constructs_tiny_real_model_without_download(self):
        p = self._policy()
        n = sum(x.numel() for x in p.model.parameters())
        self.assertGreater(n, 0)
        self.assertLess(n, 200_000, "model must stay TINY (random-init, no download)")
        dist = p.act("test-gen")
        self.assertEqual(set(dist), {"local", "cloud"})
        self.assertAlmostEqual(sum(dist.values()), 1.0, places=6)

    # -- the update is a real autograd step -------------------------------

    def test_update_changes_parameters_grad_flows(self):
        p = self._policy()
        before = p.model.transformer.wte.weight.detach().clone()
        p.update([_rec("test-gen", "local", 0.9)], [1.0], 0.05)
        after = p.model.transformer.wte.weight.detach()
        self.assertGreater(
            float((before - after).abs().sum()), 0.0,
            "a real GRPO step must move the LM parameters (autograd)",
        )
        self.assertIsNotNone(p.last_loss)
        self.assertTrue(p.last_loss == p.last_loss, "loss must be finite (not NaN)")

    def test_zero_advantage_is_a_noop(self):
        p = self._policy()
        before = p.model.transformer.wte.weight.detach().clone()
        p.update([_rec("test-gen", "local", 0.9)], [0.0], 0.05)
        after = p.model.transformer.wte.weight.detach()
        self.assertEqual(float((before - after).abs().sum()), 0.0)
        self.assertIsNone(p.last_loss)

    # -- the policy-gradient signal has the right SIGN --------------------

    def test_positive_advantage_raises_completion_logprob(self):
        # loss = -(adv * logprob); adv > 0 => gradient ASCENT on the log-prob of
        # the taken completion. The neural flywheel moves in the reward direction.
        p = self._policy()
        rec = _rec("test-gen", "local", 0.9)
        before = p.logprob("test-gen", "local")
        for _ in range(10):
            p.update([rec], [1.0], 0.05)
        after = p.logprob("test-gen", "local")
        self.assertGreater(
            after, before,
            "positive advantage must raise the favoured completion's log-prob",
        )

    def test_negative_advantage_lowers_completion_logprob(self):
        p = self._policy()
        rec = _rec("test-gen", "local", 0.9)
        before = p.logprob("test-gen", "local")
        for _ in range(10):
            p.update([rec], [-1.0], 0.05)
        after = p.logprob("test-gen", "local")
        self.assertLess(after, before, "negative advantage must lower the completion's log-prob")

    # -- plugs into the SAME trainer + gate as the stdlib policy ----------

    def test_plugs_into_grpo_trainer_and_flywheel_converges(self):
        from scprism_engine.grpo import GRPOTrainer

        recs = _favouring_local()
        p = self._policy()
        before = p.act("test-gen")["local"]
        p, metrics = GRPOTrainer(epochs=15, lr=0.05).train(recs, p)
        after = p.act("test-gen")["local"]

        # The routing probability shifted toward the reward-favoured action, and
        # the expected-reward metric rose — the flywheel turned on a real model.
        self.assertGreater(after, before)
        self.assertGreater(after, 0.9)
        self.assertGreaterEqual(
            metrics.expected_reward_after, metrics.expected_reward_before
        )
        self.assertGreater(metrics.lift, 0.0)

    def test_eval_lift_gate_promotes_trained_candidate(self):
        from scprism_engine.grpo import GRPOTrainer, eval_lift_gate

        class Golden:
            def __init__(self, id_, intent):
                self.id = id_
                self.intent = intent

        recs = _favouring_local()
        baseline = self._policy()
        candidate = baseline.clone()  # identical weights → a fair gate
        candidate, _ = GRPOTrainer(epochs=15, lr=0.05).train(recs, candidate)

        # Goldens in the trained (local-preferring) lane: the candidate should
        # beat its cloned baseline with no regression → PROMOTE (ADR-017).
        goldens = [
            Golden("a", "generate tests for the parser"),
            Golden("b", "refactor the module"),
        ]
        dec = eval_lift_gate(baseline, candidate, goldens)
        self.assertTrue(dec.promote, dec.reason)
        self.assertGreater(dec.lift, 0.0)
        self.assertEqual(dec.regressions, [])

    # -- versioning / rollback surface (Policy protocol) ------------------

    def test_snapshot_restore_roundtrips(self):
        from scprism_engine.grpo import GRPOTrainer

        p, _ = GRPOTrainer(epochs=8, lr=0.05).train(_favouring_local(), self._policy())
        snap = p.snapshot()
        self.assertEqual(snap["kind"], "llm-policy")
        twin = self._policy()
        twin.restore(snap)
        for ctx in ("test-gen", "refactor"):
            for a in ("local", "cloud"):
                self.assertAlmostEqual(twin.act(ctx)[a], p.act(ctx)[a], places=5)

    def test_clone_is_bit_identical(self):
        p = self._policy()
        twin = p.clone()
        self.assertAlmostEqual(twin.act("test-gen")["local"], p.act("test-gen")["local"], places=6)


@unittest.skipUnless(_HAS_TORCH, "torch not importable — skip the opt-in wiring proof")
class TestGrpoWiringSelectsLLM(unittest.TestCase):
    """When opted-in AND libs present, grpo routes to the real neural backend."""

    def test_llm_policy_wrapper_returns_real_backend(self):
        from scprism_engine import grpo
        from scprism_engine.grpo_llm import LLMPolicy as RealLLMPolicy

        pol = grpo.LLMPolicy(env={"SCPRISM_GRPO_LLM": "1"})
        self.assertIsInstance(pol, RealLLMPolicy)

    def test_select_policy_picks_llm_when_opted_in(self):
        from scprism_engine import grpo
        from scprism_engine.grpo_llm import LLMPolicy as RealLLMPolicy

        self.assertIsInstance(
            grpo._select_policy({"SCPRISM_GRPO_LLM": "1"}), RealLLMPolicy
        )
        # Default (flag unset) keeps the stdlib policy — unchanged behaviour.
        self.assertIsInstance(grpo._select_policy({}), grpo.RoutePolicy)


if __name__ == "__main__":
    unittest.main()
