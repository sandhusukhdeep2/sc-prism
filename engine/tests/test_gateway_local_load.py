"""A LOCAL model that could not be LOADED is named, not called an outage.

The failure this holds (2026-08-17): oMLX answers a chat POST for a model that
does not fit with HTTP 507 and its own arithmetic —

    projected memory 42.36GB would exceed the metal_cap memory ceiling 24.96GB

— which fell into `_invoke`'s 5xx branch, became the deterministic offline
stub ("handled: …"), and reached the user as "your local provider is
unreachable". The server was up, fast and explicit; he went looking for a
network fault that never existed.

The client contract is the `LOAD_FAILED_MARK` string, shared byte-for-byte with
src/lib/runBudget.ts and engine/bifrost/provider.go.
"""

import io
import unittest
import unittest.mock
import urllib.error

import _bootstrap  # noqa: F401

from scprism_engine.gateway import LOAD_FAILED_MARK, Gateway, local_load_failure

OMLX_507 = (
    '{"detail":"projected memory 42.36GB would exceed the '
    'metal_cap memory ceiling 24.96GB"}'
)


def _http_error(code, body):
    return urllib.error.HTTPError(
        "http://localhost:1234/v1/chat/completions",
        code,
        "err",
        {},
        io.BytesIO(body.encode("utf-8")),
    )


class TestLocalLoadFailureClassifier(unittest.TestCase):
    """Pure classification — status + body in, one honest sentence out."""

    def test_507_with_the_servers_numbers_is_a_load_failure(self):
        reason = local_load_failure(507, OMLX_507)
        self.assertIsNotNone(reason)
        self.assertIn(LOAD_FAILED_MARK, reason)
        # The SERVER's own figures, rounded for reading, never re-derived.
        self.assertIn("42.4 GB", reason)
        self.assertIn("25.0 GB", reason)
        self.assertIn("metal_cap", reason)  # quoted verbatim

    def test_a_memory_body_without_507_still_counts(self):
        reason = local_load_failure(500, "model load failed: out of memory")
        self.assertIsNotNone(reason)
        self.assertIn(LOAD_FAILED_MARK, reason)
        # No figures were given, so none are printed.
        self.assertNotIn("GB and the server", reason)

    def test_an_ordinary_server_error_is_NOT_a_load_failure(self):
        self.assertIsNone(local_load_failure(500, '{"detail":"internal error"}'))
        self.assertIsNone(local_load_failure(503, "service unavailable"))

    def test_no_body_at_all_still_names_the_status(self):
        reason = local_load_failure(507, "")
        self.assertIn(LOAD_FAILED_MARK, reason)
        self.assertIn("507", reason)


class TestGatewayReportsTheLoadFailure(unittest.TestCase):
    _MSGS = [{"role": "user", "content": "write the report"}]

    def _local_route(self, gw):
        route = gw.route("summarise this note")
        self.assertTrue(route.is_local)
        return route

    def test_a_507_never_becomes_the_deterministic_stub(self):
        gw = Gateway(openai_base_url="http://localhost:1234", env={}, timeout=0.2)
        route = self._local_route(gw)

        def refuse(req, timeout=None):
            raise _http_error(507, OMLX_507)

        with unittest.mock.patch("urllib.request.urlopen", refuse):
            res = gw.model_call(self._MSGS, route)

        self.assertFalse(res.is_real)
        self.assertIn(LOAD_FAILED_MARK, res.text)
        self.assertIn("42.4 GB", res.text)
        # The offline prefix stays (the client's "not model output" contract)…
        self.assertTrue(res.text.startswith("[offline:"))
        # …but the deterministic stub's words must be gone: that is the text
        # the app rendered as "the provider is unreachable".
        self.assertNotIn("handled:", res.text)
        # Nothing was generated, so nothing may be claimed as generated.
        self.assertEqual(res.tokens_out, 0)

    def test_an_ordinary_local_5xx_still_stubs(self):
        """The fix must not relabel every server error as a memory problem."""
        gw = Gateway(openai_base_url="http://localhost:1234", env={}, timeout=0.2)
        route = self._local_route(gw)

        def boom(req, timeout=None):
            raise _http_error(500, '{"detail":"internal error"}')

        with unittest.mock.patch("urllib.request.urlopen", boom):
            res = gw.model_call(self._MSGS, route)

        self.assertNotIn(LOAD_FAILED_MARK, res.text)
        self.assertIn("handled:", res.text)


if __name__ == "__main__":
    unittest.main()
