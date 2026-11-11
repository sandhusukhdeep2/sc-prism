"""Computer use that can SEE — and the screen's own egress floor (2026-11-11).

Computer control existed as five tools, but the screenshot came back as a file
path and no model was ever shown the picture: a seat acted blind. Showing it is
the easy half. The half the product's promise rests on is WHERE the picture may
go: a screenshot is the most private thing a run can hold, so it obeys the same
floor the vault does.

The laws, asserted at the wire (``urlopen`` is patched; nothing reaches the
network; the "screenshot" is a tiny PNG written by a patched ``screencapture``):

  1. A cloud-routed run that takes a screenshot flips LOCAL for the rest of the
     run. The picture appears in NO cloud request, and a local model that can
     see is really sent it.
  2. With no local model to route to, the picture is WITHHELD from the cloud
     turn and the model is told so. Never a silent upload.
  3. The owner's explicit switch (SCPRISM_SCREEN_TO_CLOUD) lets a cloud model
     that can see be shown the screen. Only then.
  4. A run that never takes a screenshot routes exactly as before.
"""

import base64
import json
import os
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.computer_tools import ComputerToolProvider
from scprism_engine.contract import parse
from scprism_engine.gateway import Gateway
from scprism_engine.loop import SCREEN_LOCAL_REASON, _WITHHELD_SCREEN_RESULT, run
from scprism_engine.telemetry import Telemetry, read_spans

_CLOUD_HOST = "https://api.openai.com"
_LOCAL_URL = "http://127.0.0.1:9"

# The smallest valid PNG (1x1), with a marker in its base64 so a body can be
# searched for THE picture rather than for "any image".
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
_PNG_B64 = base64.b64encode(_PNG).decode("ascii")


def _tool_call(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


class _FakeResp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Wire:
    """Records every outbound model request. The FIRST reply asks for a
    screenshot (unless ``tool`` is None); every later reply is a final answer."""

    def __init__(self, tool="computer_screenshot"):
        self.posts = []
        self._lock = threading.Lock()
        self._tool = tool

    def urlopen(self, req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        with self._lock:
            self.posts.append({"url": req.full_url, "body": body})
            first = len(self.posts) == 1
        text = _tool_call(self._tool, {}) if first and self._tool else "final answer: done."
        return _FakeResp(
            {
                "choices": [{"message": {"content": text}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 7},
            }
        )

    def bodies_to(self, prefix):
        return [
            json.dumps(p["body"], ensure_ascii=False)
            for p in self.posts
            if p["url"].startswith(prefix)
        ]

    def cloud_bodies(self):
        return self.bodies_to(_CLOUD_HOST)

    def local_bodies(self):
        return self.bodies_to(_LOCAL_URL)


def _gateway(**env_extra):
    """Default route cloud (an explicit primary + a key); the local endpoint is
    a distinguishable dead address, so a request's URL says which side it was on."""
    env = {"SCPRISM_PRIMARY": "openai", "OPENAI_API_KEY": "sk-test-not-real"}
    env.update(env_extra)
    return Gateway(openai_base_url=_LOCAL_URL, env=env, timeout=0.2)


class _ScreenRunMixin:
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = os.path.join(self._tmp.name, "vault")
        self.shots = os.path.join(self._tmp.name, "shots")
        os.makedirs(self.vault)
        os.makedirs(self.shots)

    def tearDown(self):
        self._tmp.cleanup()

    def _provider(self, tel):
        provider = ComputerToolProvider(telemetry=tel, shot_dir=self.shots)

        def fake_run(argv):
            # `screencapture -x <path>`: write the picture where it was asked to.
            if argv and argv[0] == "screencapture":
                with open(argv[-1], "wb") as fh:
                    fh.write(_PNG)
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        provider._run = fake_run  # type: ignore[method-assign]
        return provider

    def _run(self, gateway, wire, task_id, intent="look at my screen and say what is open"):
        tel = Telemetry(os.path.join(self.vault, "spans.jsonl"))
        with mock.patch("urllib.request.urlopen", wire.urlopen):
            return run(
                parse(intent, task_id=task_id),
                vault=self.vault,
                tier1_commands=["true"],
                gateway=gateway,
                telemetry=tel,
                mcp_client=self._provider(tel),
                record_training=False,
            )

    def _model_calls(self):
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        return [s for s in spans if s["type"] == "model_call" and s["name"] == "model_call"]


class TestAScreenshotKeepsTheRunLocal(_ScreenRunMixin, unittest.TestCase):
    def test_the_picture_reaches_no_cloud_request_and_a_seeing_local_model_gets_it(self):
        wire = _Wire()
        self._run(_gateway(SCPRISM_LOCAL_VISION="1"), wire, "t-screen-1")
        cloud, local = wire.cloud_bodies(), wire.local_bodies()
        self.assertTrue(cloud, "the run really started on the cloud provider")
        self.assertTrue(local, "the forced-local turn really happened")
        for body in cloud:
            self.assertNotIn(_PNG_B64, body, "the screen reached a CLOUD request")
        self.assertTrue(
            any(_PNG_B64 in body for body in local),
            "the local model was never shown the screen — that is acting blind",
        )

    def test_the_turn_after_the_screenshot_is_spanned_local_with_the_screens_reason(self):
        wire = _Wire()
        self._run(_gateway(SCPRISM_LOCAL_VISION="1"), wire, "t-screen-2")
        calls = self._model_calls()
        self.assertGreaterEqual(len(calls), 2)
        last = calls[-1]["attrs"]
        self.assertEqual(last.get("provider"), "local")
        self.assertEqual(last.get("reason"), SCREEN_LOCAL_REASON)

    def test_a_local_model_that_cannot_see_is_told_so_and_still_gets_no_cloud_copy(self):
        wire = _Wire()
        self._run(_gateway(), wire, "t-screen-3")  # no SCPRISM_LOCAL_VISION
        for body in wire.cloud_bodies() + wire.local_bodies():
            self.assertNotIn(_PNG_B64, body)
        self.assertTrue(
            any("screenshot saved" in body for body in wire.local_bodies()),
            "the local model was told a screenshot exists",
        )


class TestNoLocalModelMeansWithheld(_ScreenRunMixin, unittest.TestCase):
    def test_the_picture_is_withheld_and_the_model_is_told(self):
        wire = _Wire()
        gateway = _gateway()
        # No local model to flip to: the gateway offers no local route.
        gateway.local_route_for = lambda reason: None  # type: ignore[method-assign]
        self._run(gateway, wire, "t-screen-4")
        cloud = wire.cloud_bodies()
        self.assertGreaterEqual(len(cloud), 2, "the run stayed on the cloud provider")
        for body in cloud:
            self.assertNotIn(_PNG_B64, body, "the screen reached a CLOUD request")
        self.assertTrue(
            any(json.dumps(_WITHHELD_SCREEN_RESULT, ensure_ascii=False)[1:-1] in body for body in cloud),
            "the cloud model was not told the picture was withheld",
        )


class TestTheOwnersSwitch(_ScreenRunMixin, unittest.TestCase):
    def test_with_the_switch_on_a_seeing_cloud_model_is_shown_the_screen(self):
        wire = _Wire()
        self._run(_gateway(SCPRISM_SCREEN_TO_CLOUD="1"), wire, "t-screen-5")
        self.assertEqual(wire.local_bodies(), [], "nothing forced the run local")
        self.assertTrue(
            any(_PNG_B64 in body for body in wire.cloud_bodies()),
            "the switch was on and the cloud model still acted blind",
        )

    def test_the_switch_is_off_unless_it_is_exactly_on(self):
        for value in ("", "0", "false", "no"):
            wire = _Wire()
            self._run(_gateway(SCPRISM_SCREEN_TO_CLOUD=value), wire, "t-screen-6-%s" % (value or "empty"))
            for body in wire.cloud_bodies():
                self.assertNotIn(_PNG_B64, body, "value %r let the screen out" % value)


class TestARunWithoutAScreenshotIsUntouched(_ScreenRunMixin, unittest.TestCase):
    def test_it_stays_on_its_own_route(self):
        wire = _Wire(tool=None)
        self._run(_gateway(), wire, "t-screen-7", intent="say hello")
        self.assertTrue(wire.cloud_bodies())
        self.assertEqual(wire.local_bodies(), [])


if __name__ == "__main__":
    unittest.main()
