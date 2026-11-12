"""The thinking effort you set for one AI is that AI's alone (2026-11-12).

Settings holds an effort level PER provider. The bridge forwarded only the
primary's, and the gateway applied that one level to every provider in the
run — so a critic seat on Gemini was sent the level chosen for Claude. On the
owner's machine that seat answered ~70 tokens in 10–117 s and timed out at the
120 s bound three times, stalling whole team runs.

`SCPRISM_EFFORTS` carries each provider's own level (`gemini=low,claude=high`).
When it is present a provider gets ITS level or none at all; when it is absent
(an older caller) the single `SCPRISM_EFFORT` applies as before.
"""

import json
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.gateway import Gateway, parse_efforts


class _Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _capture(payload):
    seen = {}

    def fake(req, timeout=None):
        seen["body"] = json.loads(req.data.decode("utf-8"))
        seen["url"] = req.full_url
        return _Resp(payload)

    return fake, seen


_MSGS = [{"role": "user", "content": "review this"}]
_OPENAI_OK = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {}}


def _gemini_body(env):
    gw = Gateway(env={"GEMINI_API_KEY": "gk", "SCPRISM_PRIMARY": "gemini", **env})
    route = gw.route("review this")
    assert route.provider == "gemini", route
    fake, seen = _capture(_OPENAI_OK)
    with mock.patch("urllib.request.urlopen", fake):
        gw.model_call(_MSGS, route)
    return seen["body"]


class ParseEffortsTest(unittest.TestCase):
    def test_absent_means_the_caller_did_not_say(self):
        self.assertIsNone(parse_efforts(None))
        self.assertIsNone(parse_efforts(""))

    def test_reads_each_providers_own_level(self):
        self.assertEqual(
            parse_efforts("gemini=low, claude-cli=MAX ,openai="),
            {"gemini": "low", "claude-cli": "max", "openai": ""},
        )

    def test_a_level_that_is_not_a_level_is_no_level(self):
        self.assertEqual(parse_efforts("gemini=turbo,claude=high"), {"gemini": "", "claude": "high"})

    def test_garbage_is_skipped_but_the_list_still_counts_as_given(self):
        # "the caller said, and said nothing usable" is still the caller saying:
        # no provider inherits another's level.
        self.assertEqual(parse_efforts("nonsense,,=high"), {})


class EffortIsPerProviderTest(unittest.TestCase):
    def test_a_seat_on_gemini_is_not_sent_the_level_chosen_for_claude(self):
        body = _gemini_body({"SCPRISM_EFFORT": "max", "SCPRISM_EFFORTS": "claude-cli=max"})
        self.assertNotIn("reasoning_effort", body)

    def test_gemini_gets_its_own_level_when_it_has_one(self):
        body = _gemini_body({"SCPRISM_EFFORT": "max", "SCPRISM_EFFORTS": "claude-cli=max,gemini=low"})
        self.assertEqual(body["reasoning_effort"], "low")

    def test_an_older_caller_keeps_the_single_level(self):
        body = _gemini_body({"SCPRISM_EFFORT": "medium"})
        self.assertEqual(body["reasoning_effort"], "medium")

    def test_effort_for_names_the_provider(self):
        gw = Gateway(env={"SCPRISM_EFFORT": "high", "SCPRISM_EFFORTS": "gemini=low,claude="})
        self.assertEqual(gw.effort_for("gemini"), "low")
        self.assertEqual(gw.effort_for("claude"), "")
        self.assertEqual(gw.effort_for("openai"), "")
        legacy = Gateway(env={"SCPRISM_EFFORT": "high"})
        self.assertEqual(legacy.effort_for("gemini"), "high")


if __name__ == "__main__":
    unittest.main()
