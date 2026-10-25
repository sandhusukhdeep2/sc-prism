"""Route-policy adoption at runtime (LF-2) — closing the flywheel's last loop.

The golden lift-gate already PROMOTES a route policy into ``<vault>/training/
models``; until now nothing read it back, so a user's own verified outcomes
never actually changed their routing. These tests prove the closed loop:

  * a real ``train -> promote -> load`` round-trip restores an adoptable policy;
  * the Gateway's DEFAULT lane honors the policy's argmax with an HONEST reason
    naming the version + bucket + probability (route SELECTION, never the model
    "learning");
  * sensitivity / reasoning / explicit-primary routing is UNCHANGED with a
    policy set — those branches always return first;
  * with NO policy the default RouteDecision is byte-identical to before;
  * a missing / corrupt / wrong-kind snapshot loads as ``None`` -> built-in rules.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401  (puts engine/ on sys.path when run standalone)

from scprism_engine import grpo, training
from scprism_engine.gateway import Gateway
from scprism_engine.goldens import load_goldens
from scprism_engine.grpo import (
    RoutePolicy,
    load_current_route_policy,
    run_training_pipeline,
)


def _seed_records_that_promote(vault: str) -> None:
    """Write records that train each golden's bucket toward its preferred action.

    Mirrors ``test_gate_runs_against_real_seed_goldens``: for every seed golden
    the healthy action is ``golden_preferred_action`` and its GRPO bucket is
    ``_golden_context``. Records favouring exactly that action per bucket make
    the candidate beat the uniform baseline on EVERY golden with no regression ->
    a real PROMOTE. Also seeds an explicit reasoning->cloud and test-gen->local
    pair so the restored policy carries both a cloud- and a local-preferring
    bucket for the routing round-trip assertions.
    """
    prefs = {}
    for g in load_goldens():
        prefs[grpo._golden_context(g)] = grpo.golden_preferred_action(g)
    # These two buckets are the ones the routing round-trip asserts on; ensure
    # they exist even if the seed suite happens not to cover them. (Consistent
    # with golden_preferred_action: 'reasoning' -> cloud, every other -> local.)
    prefs.setdefault("test-gen", "local")
    prefs.setdefault("reasoning", "cloud")
    for bucket, pref in prefs.items():
        other = "cloud" if pref == "local" else "local"
        for _ in range(4):
            training.emit_record(
                {"bucket": bucket, "action": pref, "reward": {"value": 0.9}}, vault
            )
            training.emit_record(
                {"bucket": bucket, "action": other, "reward": {"value": 0.1}}, vault
            )


def _trained_policy(prefs) -> RoutePolicy:
    """A RoutePolicy with a strong (logit 5.0) preference per context — the same
    construction the grpo gate tests use to stand up a decided policy."""
    p = RoutePolicy()
    for ctx, action in prefs.items():
        p.logits.setdefault(ctx, {"local": 0.0, "cloud": 0.0})[action] = 5.0
    return p


class TestLoadCurrentRoutePolicy(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_train_promote_load_roundtrip(self) -> None:
        _seed_records_that_promote(self.vault)
        report = run_training_pipeline(self.vault, dry_run=False)
        # A real promotion (not a dry run) persisted a version.
        self.assertEqual(
            report["gate"]["decision"], "PROMOTE", report["gate"]["reason"]
        )
        self.assertTrue(report["promoted"])

        loaded = load_current_route_policy(self.vault)
        self.assertIsNotNone(loaded)
        assert loaded is not None  # for type-checkers
        policy, version = loaded
        self.assertEqual(version, report["version"])  # e.g. "v1"
        self.assertIsInstance(policy, RoutePolicy)
        # The RESTORED weights route each trained bucket to its trained action —
        # the flywheel's decision survives serialize -> current.json -> restore.
        self.assertGreater(policy.prob("test-gen", "local"), 0.5)
        self.assertGreater(policy.prob("reasoning", "cloud"), 0.5)

    def test_missing_registry_is_none(self) -> None:
        # Cold vault: no training/models at all -> built-in routing, never raise.
        self.assertIsNone(load_current_route_policy(self.vault))

    def test_corrupt_weights_is_none(self) -> None:
        models = os.path.join(self.vault, "training", "models")
        os.makedirs(os.path.join(models, "v1"), exist_ok=True)
        with open(os.path.join(models, "current.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": "v1", "previous": None, "updated": "now"}, fh)
        with open(os.path.join(models, "v1", "weights.json"), "w", encoding="utf-8") as fh:
            fh.write("{ not valid json ]")
        self.assertIsNone(load_current_route_policy(self.vault))

    def test_wrong_kind_snapshot_is_none(self) -> None:
        # A well-formed snapshot that is NOT the stdlib route policy is not
        # adoptable here (the LLMPolicy path is a different backend).
        models = os.path.join(self.vault, "training", "models")
        os.makedirs(os.path.join(models, "v1"), exist_ok=True)
        with open(os.path.join(models, "current.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": "v1"}, fh)
        with open(os.path.join(models, "v1", "weights.json"), "w", encoding="utf-8") as fh:
            json.dump({"kind": "llm-policy", "logits": {}}, fh)
        self.assertIsNone(load_current_route_policy(self.vault))


class TestGatewayRouteAdoption(unittest.TestCase):
    def _gw(self, **env) -> Gateway:
        # env={} isolates the gateway from the real environment: no cloud keys
        # (default lane), no explicit primary (so the policy branch is reached).
        return Gateway(env=dict(env))

    def test_no_policy_default_is_byte_identical(self) -> None:
        gw = self._gw()
        d = gw.route("add a test for the parser")  # test-gen bucket, default lane
        self.assertEqual(d.target, "local")
        self.assertEqual(d.reason, "default -> local (cheap, zero egress)")
        self.assertEqual(d.matched, "")

    def test_policy_routes_default_lane_to_cloud_with_honest_reason(self) -> None:
        gw = self._gw()
        gw.set_route_policy(_trained_policy({"reasoning": "cloud"}), "v3")
        # "reason about ..." buckets to 'reasoning' (grpo) but is NOT a gateway
        # reasoning keyword, so it reaches the default lane the policy governs.
        d = gw.route("reason about the tradeoffs here")
        self.assertEqual(d.target, "cloud")
        self.assertEqual(d.matched, "reasoning")
        self.assertIn("learned route policy v3", d.reason)
        self.assertIn("bucket 'reasoning' -> cloud", d.reason)
        self.assertIn("(p=", d.reason)
        # Honesty: never phrased as the model learning/retraining.
        self.assertNotIn("fine-tune", d.reason.lower())

    def test_policy_routes_default_lane_to_local_with_honest_reason(self) -> None:
        gw = self._gw()
        gw.set_route_policy(_trained_policy({"test-gen": "local"}), "v5")
        d = gw.route("add a test for the parser")
        self.assertEqual(d.target, "local")
        self.assertEqual(d.matched, "test-gen")
        self.assertIn("learned route policy v5", d.reason)
        self.assertIn("bucket 'test-gen' -> local", d.reason)

    def test_tie_defaults_to_local(self) -> None:
        gw = self._gw()
        # An untrained policy is uniform (0.5/0.5) for every bucket -> tie ->
        # local, the zero-egress default.
        gw.set_route_policy(RoutePolicy(), "v9")
        d = gw.route("add a test for the parser")
        self.assertEqual(d.target, "local")
        self.assertIn("bucket 'test-gen' -> local", d.reason)

    def test_sensitivity_unchanged_with_policy_set(self) -> None:
        gw = self._gw()
        # A policy that would push auth-security to cloud must NEVER override the
        # sensitivity force-local — that branch returns before the policy.
        gw.set_route_policy(_trained_policy({"auth-security": "cloud"}), "v3")
        d = gw.route("rotate the auth token for login")
        self.assertEqual(d.target, "local")
        self.assertIn("sensitive keyword", d.reason)

    def test_reasoning_keyword_unchanged_with_policy_set(self) -> None:
        # A usable cloud (a real key) but NO explicit primary — so the policy
        # branch is still reachable, yet the reasoning-KEYWORD branch (which
        # runs first) wins and forces cloud, not the policy's "local" (R2 needs
        # a usable cloud for the reasoning lane to fire).
        gw = Gateway(env={}, openai_api_key="k")
        gw.set_route_policy(_trained_policy({"reasoning": "local"}), "v3")
        d = gw.route("design a distributed migration plan")  # gateway reasoning kw
        self.assertEqual(d.target, "cloud")
        self.assertIn("reasoning keyword", d.reason)

    def test_explicit_primary_unchanged_with_policy_set(self) -> None:
        gw = self._gw(SCPRISM_PRIMARY="claude")
        gw.set_route_policy(_trained_policy({"test-gen": "local"}), "v3")
        d = gw.route("add a test for the parser")
        self.assertEqual(d.target, "cloud")
        self.assertIn("default -> primary (claude) per user selection", d.reason)

    def test_explicit_local_choice_is_never_overridden_by_policy(self) -> None:
        # LF-fix A: a user who explicitly chose LOCAL (SCPRISM_PRIMARY=local) has
        # primary_explicit=False (that flag is cloud-only), so before the fix the
        # policy branch governed and could egress their work to cloud — breaking
        # the Adopt disclosure ("your explicit provider choice always wins").
        # A learned reasoning->cloud policy must NOT override the explicit-local
        # choice: a non-keyword reasoning-bucket intent still routes LOCAL.
        gw = self._gw(SCPRISM_PRIMARY="local")
        gw.set_route_policy(_trained_policy({"reasoning": "cloud"}), "v3")
        d = gw.route("reason about the tradeoffs here")  # 'reasoning' bucket
        self.assertEqual(d.target, "local")
        # The policy was never consulted — no learned-policy reason on the route.
        self.assertNotIn("learned route policy", d.reason)


# LF-fix D — pin the REAL runtime adoption wiring in loop.run: an adopted policy
# actually produces the policy's route on the default lane end to end. Hardcoding
# the policy off at loop.run's integration point (removing set_route_policy) must
# fail this test.
class TestRuntimeAdoptionThroughLoop(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _model_call_reasons(self):
        from scprism_engine.telemetry import read_spans

        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        return [s["attrs"].get("reason", "") for s in spans if s["type"] == "model_call"]

    def test_loop_run_adopts_promoted_policy_on_default_lane(self) -> None:
        from scprism_engine.contract import parse
        from scprism_engine.gateway import Gateway
        from scprism_engine.loop import run

        # A real train -> promote persists current.json (reasoning -> cloud).
        _seed_records_that_promote(self.vault)
        report = run_training_pipeline(self.vault, dry_run=False)
        self.assertEqual(report["gate"]["decision"], "PROMOTE", report["gate"]["reason"])

        # loop.run builds its OWN gateway (owns_gateway=True) and adopts the
        # vault's policy. Patch make_gateway to an ISOLATED, keyless, no-explicit-
        # primary Gateway so the default lane is reached deterministically — but
        # the ADOPTION code path (load_current_route_policy + set_route_policy)
        # still runs because the `gateway` arg is None.
        with mock.patch(
            "scprism_engine.loop.make_gateway", return_value=Gateway(env={})
        ):
            contract = parse("reason about the tradeoffs here", task_id="t-adopt")
            run(contract, vault=self.vault, tier1_commands=["true"])

        reasons = self._model_call_reasons()
        self.assertTrue(reasons, "a model_call span was recorded")
        # The adopted policy routed this default-lane 'reasoning' bucket to cloud,
        # named honestly. If loop.run never called set_route_policy, this would be
        # the built-in "default -> local" and the assertion fails.
        self.assertTrue(
            any("learned route policy" in r and "-> cloud" in r for r in reasons),
            f"expected an adopted-policy cloud route, got: {reasons}",
        )


if __name__ == "__main__":
    unittest.main()
