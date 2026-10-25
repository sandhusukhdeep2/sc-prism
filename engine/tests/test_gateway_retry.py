"""Rate-limit backoff in the gateway (specs/02 §7).

429/503/529 responses retry with exponential backoff (1s, 2s, 4s — patched
here so tests are instant); other HTTP errors never retry; exhausting the
retries falls back to the deterministic offline stub like any other failure.
"""

import json
import unittest
import urllib.error
from unittest import mock

import _bootstrap  # noqa: F401

import scprism_engine.gateway as gw_module
from scprism_engine.gateway import Gateway, RETRY_ATTEMPTS


def _gw(**kw):
    kw.setdefault("openai_base_url", "http://127.0.0.1:9")
    kw.setdefault("env", {})
    kw.setdefault("timeout", 0.2)
    return Gateway(**kw)


class _FakeResp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(code):
    return urllib.error.HTTPError("http://x", code, "err", {}, None)


_OK = {"choices": [{"message": {"content": "recovered"}}],
       "usage": {"prompt_tokens": 1, "completion_tokens": 2}}


class TestGatewayRateLimitBackoff(unittest.TestCase):
    _MSGS = [{"role": "user", "content": "hello"}]

    def _route(self, gw):
        route = gw.route("design a distributed system")  # reasoning -> cloud
        self.assertEqual(route.provider, "openai")
        return route

    def test_429_retries_with_exponential_backoff_then_succeeds(self):
        gw = _gw(openai_api_key="sk", primary="openai")
        calls = {"n": 0}

        def flaky(req, timeout=None):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise _http_error(429)
            return _FakeResp(_OK)

        sleeps = []
        with mock.patch("urllib.request.urlopen", flaky), \
                mock.patch.object(gw_module, "_sleep", sleeps.append):
            res = gw.model_call(self._MSGS, self._route(gw))
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "recovered")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(sleeps, [1.0, 2.0])  # exponential: 1s then 2s

    def test_gives_up_after_max_retries_and_stubs(self):
        gw = _gw(openai_api_key="sk", primary="openai")
        calls = {"n": 0}

        def always_429(req, timeout=None):
            calls["n"] += 1
            raise _http_error(429)

        with mock.patch("urllib.request.urlopen", always_429), \
                mock.patch.object(gw_module, "_sleep", lambda s: None):
            res = gw.model_call(self._MSGS, self._route(gw))
        self.assertFalse(res.is_real)  # offline stub, not a crash
        self.assertEqual(calls["n"], RETRY_ATTEMPTS + 1)

    def test_non_retryable_error_never_retries(self):
        gw = _gw(openai_api_key="sk", primary="openai")
        calls = {"n": 0}

        def unauthorized(req, timeout=None):
            calls["n"] += 1
            raise _http_error(401)

        sleeps = []
        with mock.patch("urllib.request.urlopen", unauthorized), \
                mock.patch.object(gw_module, "_sleep", sleeps.append):
            res = gw.model_call(self._MSGS, self._route(gw))
        self.assertFalse(res.is_real)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(sleeps, [])


if __name__ == "__main__":
    unittest.main()
