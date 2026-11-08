"""The Bifrost path's model-call bound is the HTTP bound, not 2 s (2026-11-08).

Seen in the app: an agent's proof on the local model closed after 2003 ms with
"local returned no completion" while oMLX was still loading the model (9.4 s
by its own log). ``BifrostGateway`` defaulted ``timeout`` to 2.0 s and forwarded
it to the Go daemon as SCPRISM_BIFROST_TIMEOUT, and ``make_gateway`` — the
engine's only caller — never passed one. The Python ``Gateway`` stopped doing
this long ago ("the old 2.0s default starved EVERY real HTTP provider into the
honest stub"): explicit arg > SCPRISM_HTTP_TIMEOUT > 120 s. One rule for both.
"""
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.bifrost_client import BifrostGateway
from scprism_engine.gateway import http_timeout


class TestHttpTimeoutRule(unittest.TestCase):
    def test_default_is_the_python_gateways_120s(self):
        self.assertEqual(http_timeout({}), 120.0)

    def test_the_env_bound_wins_over_the_default(self):
        self.assertEqual(http_timeout({"SCPRISM_HTTP_TIMEOUT": "45"}), 45.0)

    def test_an_explicit_bound_wins_over_the_env(self):
        self.assertEqual(http_timeout({"SCPRISM_HTTP_TIMEOUT": "45"}, 0.2), 0.2)

    def test_garbage_falls_back_to_the_default(self):
        for bad in ("nope", "-3", "0", "inf", "nan", ""):
            with self.subTest(bad=bad):
                self.assertEqual(http_timeout({"SCPRISM_HTTP_TIMEOUT": bad}), 120.0)
        self.assertEqual(http_timeout({}, 0.0), 120.0)
        self.assertEqual(http_timeout({}, float("inf")), 120.0)


def _child_env(base, timeout):
    return BifrostGateway._build_child_env(
        base,
        openai_base_url=None,
        openai_api_key=None,
        claude_api_key=None,
        gemini_api_key=None,
        primary=None,
        timeout=timeout,
    )


class TestBifrostChildEnv(unittest.TestCase):
    """What the daemon is told — the same precedence the Python gateway applies."""

    def test_no_bound_given_means_the_http_default_not_two_seconds(self):
        env = _child_env({"PATH": ""}, None)
        self.assertEqual(env["SCPRISM_BIFROST_TIMEOUT"], "120.0")

    def test_the_users_env_bound_reaches_the_daemon(self):
        env = _child_env({"PATH": "", "SCPRISM_HTTP_TIMEOUT": "45"}, None)
        self.assertEqual(env["SCPRISM_BIFROST_TIMEOUT"], "45.0")

    def test_an_explicit_bound_still_wins(self):
        env = _child_env({"PATH": "", "SCPRISM_HTTP_TIMEOUT": "45"}, 0.2)
        self.assertEqual(env["SCPRISM_BIFROST_TIMEOUT"], "0.2")


if __name__ == "__main__":
    unittest.main()
