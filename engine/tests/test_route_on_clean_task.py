"""LF-fix B — routing + learned-policy bucketing run on the CLEAN task text, not
on the COMPOSED prompt (disclosed skills + LF-1 memory).

Before the fix, ``loop.run`` prepended the skills/memory prefix to the prompt
BEFORE ``_gateway_model`` routed it, so injected skill/vault text participated in
the SENSITIVE/REASONING keyword scans AND the learned-policy ``task_bucket`` —
flipping a default-local run to cloud on a note title and naming a training
bucket the task never used (false provenance). The fix routes on the raw step
and applies the prefix to the MODEL input only, AFTER the route decision.

Offline throughout (no network): the gateway falls back to its deterministic
stub, and we read the real route back from the model_call span + ModelResult.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import grpo
from scprism_engine.gateway import Gateway
from scprism_engine.grpo import RoutePolicy
from scprism_engine.loop import _gateway_model
from scprism_engine.telemetry import Telemetry, read_spans


class TestRouteOnCleanTask(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.spans_path = os.path.join(self._tmp.name, "spans.jsonl")
        self.tel = Telemetry(self.spans_path)

    def tearDown(self):
        self._tmp.cleanup()

    def _model_call_reasons(self):
        return [
            s["attrs"].get("reason", "")
            for s in read_spans(self.spans_path)
            if s["type"] == "model_call"
        ]

    def test_prefix_reasoning_keyword_does_not_flip_a_local_route(self):
        gw = Gateway(env={})  # keyless, no explicit primary -> default lane
        # A disclosed-skill prefix that contains gateway REASONING keywords
        # ('architect'): before the fix this leaked into routing and flipped the
        # clean, benign local task to cloud.
        prefix = (
            "Relevant saved skills — follow the matching procedure:\n\n"
            "## design-doc\narchitect the whole distributed system and optimize it"
        )
        # Spy on model_call so we can prove the model STILL saw the prefix.
        seen = {}
        orig = gw.model_call

        def spy(messages, decision):
            seen["messages"] = messages
            return orig(messages, decision)

        gw.model_call = spy  # type: ignore[assignment]

        call = _gateway_model(gw, self.tel, "parent", context_prefix=prefix)
        res = call("list the files in the repo", "read")

        # The route was decided on the CLEAN task -> local (no keyword leak).
        self.assertEqual(res.route, "local")
        reasons = self._model_call_reasons()
        self.assertTrue(reasons)
        self.assertIn("default -> local", reasons[-1])
        self.assertNotIn("reasoning keyword", reasons[-1])
        # ...yet the disclosed skill still reached the model verbatim (LF-1/S2).
        blob = "\n".join(str(m.get("content", "")) for m in seen["messages"])
        self.assertIn("architect the whole distributed system", blob)
        self.assertIn("list the files in the repo", blob)

    def test_empty_prefix_is_byte_identical(self):
        # No prefix -> the model input is exactly companion_messages(prompt), the
        # pre-LF behavior. Prove it by comparing captured messages with and
        # without an empty prefix.
        from scprism_engine.companion import companion_messages

        gw = Gateway(env={})
        seen = {}
        orig = gw.model_call

        def spy(messages, decision):
            seen["messages"] = messages
            return orig(messages, decision)

        gw.model_call = spy  # type: ignore[assignment]
        call = _gateway_model(gw, self.tel, "parent", context_prefix="")
        call("summarize the changelog", "read")
        self.assertEqual(seen["messages"], companion_messages("summarize the changelog"))

    def test_learned_policy_bucket_is_the_raw_intent_not_the_composed_prompt(self):
        gw = Gateway(env={})
        # A uniform policy routes every bucket to local (tie) but names the bucket
        # in the honest reason — which is what we assert on.
        gw.set_route_policy(RoutePolicy(), "v1")
        intent = "add a test for the parser"  # task_bucket -> 'test-gen'
        # A prefix whose words bucket DIFFERENTLY ('architecture' -> 'reasoning')
        # AND contain gateway reasoning keywords ('refactor'/'optimize'): if it
        # leaked, routing would either hit the reasoning-keyword branch or bucket
        # as 'reasoning'. Neither may happen.
        prefix = "## skill\nrefactor and optimize the whole architecture"
        call = _gateway_model(gw, self.tel, "parent", context_prefix=prefix)
        res = call(intent, "read")

        self.assertEqual(res.route, "local")
        reason = self._model_call_reasons()[-1]
        self.assertIn("learned route policy", reason)
        expected_bucket = grpo.task_bucket({"task_intent": intent})
        self.assertEqual(expected_bucket, "test-gen")  # sanity
        self.assertIn(f"bucket '{expected_bucket}'", reason)
        self.assertNotIn("bucket 'reasoning'", reason)
        self.assertNotIn("reasoning keyword", reason)


if __name__ == "__main__":
    unittest.main()
