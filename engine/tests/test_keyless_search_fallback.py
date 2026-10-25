"""Keyless web search must actually FIND things.

Found live 2026-08-31 by asking "is it working, or just showing?": the
default keyless backend used DuckDuckGo's Instant-Answer API, which answers
almost no ordinary research query — every field came back empty, so
`web_search` reported an honest "No web results" for everything and the
tool only LOOKED like it worked. It now falls back to the ordinary
(no-JavaScript) results page and unwraps each hit to its REAL destination
URL, so a citation points where it claims to. A transport failure still
raises rather than posing as an empty result.
"""
import unittest
from unittest import mock

import _bootstrap  # noqa: F401
from scprism_engine.webtools import KeylessBackend, WebSearchBackendError

_PAGE = (
    '<a rel="nofollow" class="result__a" '
    'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.gov%2Fhours&amp;rut=x">'
    "Counting hours - Example Agency</a>"
    '<a rel="nofollow" class="result__a" '
    'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second hit</a>'
)


class _Resp:
    def __init__(self, body):
        self._body = body.encode()

    def read(self, _n=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestKeylessFallback(unittest.TestCase):
    def test_empty_instant_answers_fall_through_to_real_results(self):
        b = KeylessBackend()
        with mock.patch("scprism_engine.webtools._http_json", return_value={}):
            with mock.patch("urllib.request.urlopen", return_value=_Resp(_PAGE)):
                out = b.search("working hours rules")
        self.assertEqual(len(out), 2)
        # Unwrapped to the REAL destination, not the redirector.
        self.assertEqual(out[0]["url"], "https://www.example.gov/hours")
        self.assertIn("Example Agency", out[0]["title"])

    def test_instant_answers_still_win_when_they_have_something(self):
        b = KeylessBackend()
        payload = {"AbstractURL": "https://x.example/a", "Heading": "A", "AbstractText": "t"}
        with mock.patch("scprism_engine.webtools._http_json", return_value=payload):
            with mock.patch("urllib.request.urlopen", side_effect=AssertionError("no fallback")):
                out = b.search("anything")
        self.assertEqual(out[0]["url"], "https://x.example/a")

    def test_a_transport_failure_is_a_failure_not_an_empty_result(self):
        b = KeylessBackend()
        with mock.patch("scprism_engine.webtools._http_json", return_value={}):
            with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
                with self.assertRaises(WebSearchBackendError):
                    b.search("anything")


if __name__ == "__main__":
    unittest.main()
