"""Per-message route hint threading — from ``loop.run`` / ``_gateway_model``
down to ``gateway.route(prompt, hint)``, plus the ``run --route`` CLI seam.

Two invariants:
  * When a hint is set, the gateway honors it (within the sensitivity floor) and
    the model_call span carries the honest reason.
  * ``route_hint=None`` (and ``--route auto``) is BYTE-IDENTICAL to the no-hint
    path — the whole feature is opt-in.

Offline throughout (unreachable local endpoint) so the gateway falls back to its
deterministic stub; the real route is read back from the ModelResult + span.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main
from scprism_engine.gateway import Gateway
from scprism_engine.loop import _gateway_model
from scprism_engine.telemetry import Telemetry, read_spans


def _gw(**kw):
    kw.setdefault("openai_base_url", "http://127.0.0.1:9")
    kw.setdefault("env", {})
    kw.setdefault("timeout", 0.2)
    return Gateway(**kw)


class TestGatewayModelThreadsHint(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.spans_path = os.path.join(self._tmp.name, "spans.jsonl")
        self.tel = Telemetry(self.spans_path)

    def tearDown(self):
        self._tmp.cleanup()

    def _last_reason(self):
        reasons = [
            s["attrs"].get("reason", "")
            for s in read_spans(self.spans_path)
            if s["type"] == "model_call"
        ]
        return reasons[-1] if reasons else ""

    def test_hint_local_forces_local_through_the_doer(self):
        # A cloud-capable, reasoning intent would go cloud — the hint keeps it
        # local (proving _gateway_model actually forwards route_hint).
        gw = _gw(openai_api_key="k", primary="openai")
        call = _gateway_model(gw, self.tel, "parent", route_hint="local")
        res = call("design a distributed rate limiter", "read")
        self.assertEqual(res.route, "local")
        self.assertIn("you chose local", self._last_reason())

    def test_hint_cloud_routes_cloud_through_the_doer(self):
        gw = _gw(openai_api_key="k", primary="openai")
        call = _gateway_model(gw, self.tel, "parent", route_hint="cloud")
        res = call("write a friendly greeting", "read")
        self.assertEqual(res.route, "cloud")
        self.assertIn("you chose cloud", self._last_reason())

    def test_sensitivity_floor_survives_the_doer(self):
        # The hard floor is honored end-to-end: "cloud" hint + secret -> local.
        gw = _gw(openai_api_key="k", primary="openai")
        call = _gateway_model(gw, self.tel, "parent", route_hint="cloud")
        res = call("rotate the customer password", "read")
        self.assertEqual(res.route, "local")
        self.assertIn("you asked for cloud", self._last_reason())

    def test_none_hint_is_byte_identical_to_no_hint_arg(self):
        # The default doer (route_hint omitted) and an explicit None must produce
        # the SAME route + reason for the same intent.
        gw = _gw(openai_api_key="k", primary="openai")
        c1 = _gateway_model(gw, self.tel, "parent")
        c2 = _gateway_model(gw, self.tel, "parent", route_hint=None)
        r1 = c1("design a distributed system", "read")
        r2 = c2("design a distributed system", "read")
        self.assertEqual(r1.route, r2.route)
        self.assertEqual(r1.reason, r2.reason)


def _run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    return code, (json.loads(text) if text else None)


class TestRunRouteCLI(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _reasons(self):
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        return [s["attrs"].get("reason", "") for s in spans if s["type"] == "model_call"]

    def test_route_local_flag_keeps_a_run_local(self):
        code, obj = _run_cli(
            ["run", "design a distributed cache", "--vault", self.vault,
             "--route", "local", "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        self.assertTrue(any("you chose local" in r for r in self._reasons()))

    def test_route_auto_is_default_and_carries_no_hint(self):
        # --route auto -> route_hint None -> the built-in default-local reason,
        # never a "you chose …" reason (byte-identical to omitting the flag).
        code, _ = _run_cli(
            ["run", "add a small helper", "--vault", self.vault, "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        reasons = self._reasons()
        self.assertTrue(reasons)
        self.assertFalse(any("you chose" in r or "you asked for" in r for r in reasons))


if __name__ == "__main__":
    unittest.main()
