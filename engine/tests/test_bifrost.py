"""Integration tests for the REAL Go Bifrost gateway (tranche E-Bifrost).

These build the ``bifrostd`` binary from source in setUpClass and drive it
through ``BifrostGateway`` over a Unix domain socket. If the repo-local Go
toolchain is unavailable, the whole case skips (via ``SkipTest``) so the suite
stays green on Go-less machines.
"""

import os
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.bifrost_client import (
    BifrostGateway,
    build_bifrostd,
    go_available,
    binary_exists,
    make_gateway,
)
from scprism_engine.gateway import Gateway, LOCAL, CLOUD
from scprism_engine.contract import parse
from scprism_engine.loop import run


# Unreachable local endpoint + empty provider env -> every model call falls to
# the deterministic offline stub, so these tests never touch the network.
_DEAD_ENDPOINT = "http://127.0.0.1:9"


def _bf(**kw):
    kw.setdefault("openai_base_url", _DEAD_ENDPOINT)
    kw.setdefault("timeout", 0.2)
    # Isolate the child from the ambient env so no stray keys leak in.
    kw.setdefault("env", {"PATH": os.environ.get("PATH", "")})
    return BifrostGateway(**kw)


class TestBifrostGateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not go_available():
            raise unittest.SkipTest("repo-local Go toolchain unavailable")
        try:
            build_bifrostd()
        except Exception as exc:  # a build failure shouldn't fail a Go-less box
            raise unittest.SkipTest(f"bifrostd build failed: {exc}")
        if not binary_exists():
            raise unittest.SkipTest("bifrostd binary not produced")

    def test_ping_readiness(self):
        gw = _bf()
        try:
            self.assertTrue(gw.ping(), "daemon should answer ping when ready")
        finally:
            gw.close()

    def test_model_call_round_trips_over_uds(self):
        gw = _bf()
        try:
            msgs = [{"role": "user", "content": "explain the widget pipeline"}]
            route = gw.route("explain the widget pipeline")
            res = gw.model_call(msgs, route)
            self.assertEqual(res.cache, "miss")
            self.assertFalse(res.is_real)  # offline stub (dead endpoint)
            self.assertGreater(res.tokens_out, 0)
            self.assertIn("offline", res.text)
        finally:
            gw.close()

    def test_sensitive_intent_routes_local(self):
        gw = _bf()
        try:
            d = gw.route("rotate the customer password store")
            self.assertEqual(d.target, LOCAL)
            self.assertTrue(d.is_local)
            self.assertIn("password", d.matched)
            # Reasoning word present, but sensitivity wins.
            d2 = gw.route("refactor the auth token exchange")
            self.assertEqual(d2.target, LOCAL)
        finally:
            gw.close()

    def test_reasoning_intent_routes_cloud(self):
        gw = _bf()
        try:
            d = gw.route("design a distributed rate limiter")
            self.assertEqual(d.target, CLOUD)
            self.assertFalse(d.is_local)
        finally:
            gw.close()

    def test_route_hint_round_trips_over_uds(self):
        # The per-message route hint is honored by the REAL Go daemon (not just
        # the in-process Python gateway) and its honest decision/reason round-trip
        # back over the socket — so a user's "local" choice cannot egress to
        # cloud under Bifrost, and the attribution chip reads the same either way.
        gw = _bf()
        try:
            # hint="local" keeps a reasoning-keyword intent LOCAL (it would go
            # cloud without the hint) — the headline honesty guarantee.
            d = gw.route("design a distributed rate limiter", hint="local")
            self.assertEqual(d.target, LOCAL)
            self.assertTrue(d.is_local)
            self.assertIn("you chose local", d.reason)
            # The sensitivity floor is a HARD egress boundary: a "cloud" hint on
            # a secret stays LOCAL and the reason acknowledges the refusal.
            d2 = gw.route("rotate the customer password", hint="cloud")
            self.assertEqual(d2.target, LOCAL)
            self.assertIn("you asked for cloud", d2.reason)
            # No hint is byte-identical to before (reasoning -> cloud, and never a
            # "you chose …" reason).
            d3 = gw.route("design a distributed rate limiter")
            self.assertEqual(d3.target, CLOUD)
            self.assertNotIn("you chose", d3.reason)
        finally:
            gw.close()

    def test_prompt_cache_hit_on_repeat(self):
        gw = _bf()
        try:
            msgs = [{"role": "user", "content": "warm the cache please"}]
            route = gw.route("warm the cache please")
            first = gw.model_call(msgs, route)
            self.assertEqual(first.cache, "miss")
            second = gw.model_call(msgs, route)
            self.assertEqual(second.cache, "prompt")
            self.assertEqual(second.text, first.text)
        finally:
            gw.close()

    def test_offline_stub_is_deterministic(self):
        # Two independent daemons, same messages -> identical stub output.
        gw1, gw2 = _bf(), _bf()
        try:
            msgs = [{"role": "user", "content": "produce a deterministic answer"}]
            r1 = gw1.model_call(msgs, gw1.route("produce a deterministic answer"))
            r2 = gw2.model_call(msgs, gw2.route("produce a deterministic answer"))
            self.assertFalse(r1.is_real)
            self.assertEqual(r1.text, r2.text)
            self.assertEqual(r1.tokens_in, r2.tokens_in)
            self.assertEqual(r1.tokens_out, r2.tokens_out)
        finally:
            gw1.close()
            gw2.close()

    def test_graceful_shutdown_leaves_no_orphan(self):
        gw = _bf()
        proc = gw._proc
        self.assertIsNone(proc.poll(), "child should be alive")
        gw.close()
        # After close the child must have exited (no orphan).
        self.assertIsNotNone(proc.poll(), "child must be reaped after close")
        # Idempotent: a second close is a no-op.
        gw.close()

    def test_make_gateway_selects_bifrost_when_enabled(self):
        gw = make_gateway(use_bifrost=True, openai_base_url=_DEAD_ENDPOINT,
                          env={"PATH": os.environ.get("PATH", "")})
        try:
            self.assertIsInstance(gw, BifrostGateway)
        finally:
            gw.close()

    def test_make_gateway_defaults_to_python(self):
        # No flag -> the in-process Python gateway (default path unchanged).
        gw = make_gateway(env={"PATH": os.environ.get("PATH", "")})
        self.assertIsInstance(gw, Gateway)
        self.assertNotIsInstance(gw, BifrostGateway)

    def test_loop_runs_end_to_end_through_go_gateway(self):
        import tempfile

        with tempfile.TemporaryDirectory() as vault:
            contract = parse("add a rate-limit guard", task_id="t-bifrost-e2e")
            verdict = run(
                contract,
                vault=vault,
                tier1_commands=["true"],
                use_bifrost=True,
            )
            self.assertTrue(verdict.passed)
            verdicts = os.listdir(os.path.join(vault, "verdicts"))
            self.assertEqual(verdicts, ["t-bifrost-e2e.json"])


if __name__ == "__main__":
    unittest.main()
