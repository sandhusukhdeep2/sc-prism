"""A stand-in tells the truth about itself (2026-11-08).

Follow-on to test_standin_is_not_a_pass. The verdict now refuses a run the
model never answered; this pins the places where the stand-in ITSELF still
dressed up as a completion:

* ``Gateway._stub`` reported 8–47 output tokens, hash-derived, for a reply
  that never came. Every other stand-in already reports 0 — "an estimate
  would be a fabrication" (``_timed_out``).
* The ``model_call`` span of a stand-in was ``status: ok`` with no error, so
  the Console drew a tick beside a call the server had refused, and nothing
  downstream could tell a refused call from an answered one.
* A refusal's human cause read "local refused the request: provider refused
  the request (HTTP 401) …" — the phrase doubled.
"""
import json
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.telemetry import read_spans
from _fakes import RealGateway, fake_openai_server

from scprism_engine.contract import parse
from scprism_engine.gateway import Gateway
from scprism_engine.loop import run

ASK = [{"role": "user", "content": "summarise the new notes"}]


def _offline_gateway():
    # No provider reachable, no key: every call is the deterministic stand-in.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestTheStubIsHonestAboutTokens(unittest.TestCase):
    def test_the_offline_stub_reports_no_output_tokens(self):
        # The stub is the stand-in for an OUTAGE: a retryable status that
        # outlasts the backoff. (An unreachable endpoint takes the named
        # path, which already reported 0.)
        with fake_openai_server(fail_status=503) as (url, _seen), \
                mock.patch("scprism_engine.gateway._sleep"):
            gw = Gateway(openai_base_url=url, env={}, timeout=2)
            res = gw.model_call(ASK, gw.route(ASK[0]["content"]))
        self.assertFalse(res.is_real)
        self.assertTrue(res.text.startswith("[offline:") and "handled:" in res.text, res.text)
        self.assertEqual(res.tokens_out, 0, "no reply came back, so there are no output tokens")


class TestAStandInSpanIsNotOk(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _model_calls(self):
        rows = read_spans(os.path.join(self.vault, "spans.jsonl"))
        return [r for r in rows if r.get("type") == "model_call"]

    def test_a_stand_in_model_call_span_is_an_error_that_names_its_cause(self):
        contract = parse("summarise the new notes", task_id="t-span-standin")
        run(contract, vault=self.vault, gateway=_offline_gateway(), tier1_commands=["true"])
        spans = self._model_calls()
        self.assertTrue(spans, "the run made model calls")
        for s in spans:
            self.assertFalse(s["attrs"]["is_real"])
            self.assertEqual(s["status"], "error", f"a stand-in is not an ok call: {s['attrs']}")
            self.assertTrue(s["attrs"].get("error"), "the span names why there was no completion")

    def test_a_real_model_call_span_stays_ok(self):
        contract = parse("summarise the new notes", task_id="t-span-real")
        run(contract, vault=self.vault, gateway=RealGateway(), tier1_commands=["true"])
        spans = self._model_calls()
        self.assertTrue(spans)
        for s in spans:
            self.assertTrue(s["attrs"]["is_real"])
            self.assertEqual(s["status"], "ok")
            self.assertNotIn("error", s["attrs"])


class TestARefusalReadsOnce(unittest.TestCase):
    def test_a_401_is_a_named_refusal_whose_cause_does_not_repeat_itself(self):
        from scprism_engine.gateway import stand_in_cause

        with fake_openai_server(require_key="the-right-key") as (url, _seen):
            gw = Gateway(openai_base_url=url, env={}, timeout=2)  # keyless → 401
            res = gw.model_call(ASK, gw.route(ASK[0]["content"]))
        self.assertTrue(res.text.startswith("[rejected:"), res.text)
        self.assertIn("HTTP 401", res.text)
        self.assertEqual(res.tokens_out, 0)

        cause = stand_in_cause(res.text)
        self.assertIn("HTTP 401", cause)
        self.assertIn("API key required", cause)
        self.assertEqual(cause.count("refused the request"), 1, cause)


if __name__ == "__main__":
    unittest.main()
