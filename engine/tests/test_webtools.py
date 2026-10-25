"""Web-research tool source (webtools.py) — stdlib only, NO real internet.

Every HTTP path is exercised against a local ``http.server`` running in a thread
(bound to 127.0.0.1, ephemeral port). ``web_fetch`` reaches it via
``allow_private=True`` (the test-fixture escape hatch); the SSRF guard is proven
with its default (``allow_private=False``), which needs no network at all.
"""

import email.message
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import _bootstrap  # noqa: F401

from scprism_engine.mcp import MCPBlockedError, MCPTool
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.webtools import (
    ApiKeyBackend,
    CompositeToolClient,
    KeylessBackend,
    WebToolProvider,
    _GuardedRedirectHandler,
    make_search_backend,
    web_fetch,
)

_PAGE_HTML = (
    "<html><head><title>Fixture Title</title>"
    "<style>.x{color:red}</style></head>"
    "<body><h1>Hello</h1>"
    "<script>var secretlike = 1;</script>"
    "<p>The quick brown fox jumps over the lazy dog.</p>"
    "</body></html>"
)

_DDG_JSON = {
    "Heading": "Python (programming language)",
    "AbstractText": "Python is a high-level language.",
    "AbstractURL": "https://en.wikipedia.org/wiki/Python",
    "RelatedTopics": [
        {"Text": "CPython reference impl", "FirstURL": "https://example.com/cpython"},
        {
            "Name": "Nested",
            "Topics": [
                {"Text": "PyPy JIT", "FirstURL": "https://example.com/pypy"},
            ],
        },
        {"Result": "no url here"},
    ],
}

_API_JSON = {
    "results": [
        {"title": "First", "url": "https://a.example/1", "snippet": "one"},
        {"name": "Second", "link": "https://a.example/2", "description": "two"},
        {"title": "no url dropped"},
    ]
}


class _Handler(BaseHTTPRequestHandler):
    hits = []  # class-level record of requested paths (SSRF/no-egress proof)

    def log_message(self, *args):  # silence the test log
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    # A redirect Location target for the through-web_fetch redirect-hop test.
    redirect_to = "http://169.254.169.254/latest/meta-data"

    def do_GET(self):
        type(self).hits.append(self.path)
        path = self.path.split("?", 1)[0]
        if path == "/page":
            self._send(200, _PAGE_HTML)
        elif path == "/big":
            self._send(200, "A" * 500_000, ctype="text/plain")
        elif path == "/404":
            self._send(404, "nope")
        elif path == "/ddg":
            self._send(200, json.dumps(_DDG_JSON), ctype="application/json")
        elif path == "/api":
            self._send(200, json.dumps(_API_JSON), ctype="application/json")
        elif path == "/429":  # rate-limited backend -> a transport FAILURE
            self._send(429, "slow down", ctype="text/plain")
        elif path == "/empty":  # a genuinely EMPTY (but successful) search
            self._send(200, "{}", ctype="application/json")
        elif path == "/redirect":  # 302 -> a blocked host (SSRF via redirect)
            raw = b""
            self.send_response(302)
            self.send_header("Location", type(self).redirect_to)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
        else:
            self._send(404, "unknown")

    do_POST = do_GET


class _ServerMixin:
    def setUp(self):
        _Handler.hits = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)


class TestWebFetch(_ServerMixin, unittest.TestCase):
    def test_html_to_text_and_title(self):
        res = web_fetch(self.url("/page"), allow_private=True)
        self.assertNotIn("isError", res)
        text = res["content"][0]["text"]
        self.assertIn("The quick brown fox", text)
        self.assertIn("Hello", text)
        # script/style content is dropped, title is captured separately.
        self.assertNotIn("secretlike", text)
        self.assertNotIn("color:red", text)
        self.assertEqual(res["title"], "Fixture Title")
        self.assertEqual(res["url"], self.url("/page"))

    def test_byte_cap(self):
        res = web_fetch(self.url("/big"), max_bytes=1000, allow_private=True)
        self.assertNotIn("isError", res)
        # The 500 KB body is capped to <= max_bytes of raw before text collapse.
        self.assertLessEqual(len(res["content"][0]["text"]), 1000)

    def test_404_is_honest_error(self):
        res = web_fetch(self.url("/404"), allow_private=True)
        self.assertTrue(res.get("isError"))
        self.assertIn("text", res["content"][0])

    def test_timeout_is_honest_error_never_raises(self):
        # A closed port -> connection failure -> honest isError, not a raise.
        res = web_fetch("http://127.0.0.1:1/", timeout=0.5, allow_private=True)
        self.assertTrue(res.get("isError"))

    def test_ssrf_rejects_without_network(self):
        # Default allow_private=False: each of these is rejected BEFORE any socket.
        for bad in (
            "http://localhost:80/",
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data",  # cloud metadata SSRF
            "file:///etc/passwd",
            "ftp://example.com/x",
        ):
            res = web_fetch(bad)
            self.assertTrue(res.get("isError"), bad)
            self.assertIn("blocked", res["content"][0]["text"].lower(), bad)

    def test_malformed_url_never_raises(self):
        res = web_fetch("://::::not a url")
        self.assertTrue(res.get("isError"))


class TestRedirectGuard(unittest.TestCase):
    """The per-hop SSRF guard: a redirect onto a blocked host is rejected."""

    def test_redirect_to_private_host_raises(self):
        handler = _GuardedRedirectHandler(allow_private=False)
        req = urllib.request.Request("http://example.com/")
        hdrs = email.message.Message()
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(
                req, None, 302, "Found", hdrs, "http://169.254.169.254/meta"
            )

    def test_allowed_redirect_defers_to_stdlib(self):
        handler = _GuardedRedirectHandler(allow_private=True)  # skip DNS in test
        req = urllib.request.Request("http://example.com/")
        hdrs = email.message.Message()
        new = handler.redirect_request(
            req, None, 302, "Found", hdrs, "http://example.com/next"
        )
        self.assertIsInstance(new, urllib.request.Request)


class TestPeerRevet(_ServerMixin, unittest.TestCase):
    """W1's real security boundary: web_fetch re-vets the ACTUAL connected peer
    IP after connect, so DNS-rebinding/TOCTOU (and every redirect hop) is caught
    even if the pre-resolution check is bypassed."""

    def test_private_peer_rejected_even_when_pre_resolution_allows_all(self):
        # MUTATION / PINNING TEST: allow-all the pre-resolution reject (return
        # None). The fetch to a loopback fixture must STILL be rejected — proving
        # the boundary is the POST-CONNECT peer re-vet, not the pre-check. Revert
        # the peer guard and this fails (the fixture would be fetched).
        from unittest import mock

        from scprism_engine import webtools as wt

        with mock.patch.object(wt, "_ssrf_reject_reason", return_value=None):
            res = wt.web_fetch(self.url("/page"), allow_private=False, timeout=2.0)
        self.assertTrue(res.get("isError"), res)
        self.assertIn("peer", res["content"][0]["text"].lower())
        # Blocked before any request bytes egress: the fixture served nothing.
        self.assertEqual(_Handler.hits, [])

    def test_redirect_to_blocked_host_rejected_through_web_fetch(self):
        # W3: the fixture serves a REAL 302 -> a blocked (metadata) host; driven
        # through the real web_fetch/opener path (not the isolated handler), the
        # redirect hop is vetted and the fetch is rejected. allow_private=True
        # reaches the loopback fixture; the gate seam blocks only the target so
        # the test stays offline (no real egress to 169.254.169.254).
        from unittest import mock

        from scprism_engine import webtools as wt

        def gate(url, allow_private=False):
            if "169.254.169.254" in url:
                return "metadata endpoint blocked (test)"
            return None  # allow the loopback first hop

        with mock.patch.object(wt, "_ssrf_reject_reason", side_effect=gate):
            res = wt.web_fetch(self.url("/redirect"), allow_private=True, timeout=2.0)
        self.assertTrue(res.get("isError"), res)
        self.assertIn("blocked", res["content"][0]["text"].lower())
        # The fixture actually served the 302 — the redirect hop is real.
        self.assertIn("/redirect", _Handler.hits)


class TestSearchFailureHonesty(_ServerMixin, unittest.TestCase):
    """W2: a backend transport/HTTP FAILURE is an honest isError, distinct from a
    genuinely empty (successful) search that honestly says 'no results'."""

    def _provider(self, endpoint, timeout=2.0):
        return WebToolProvider(
            search_backend=KeylessBackend(endpoint=endpoint, timeout=timeout),
            allow_private=True,
        )

    def test_http_429_is_honest_iserror_not_no_results(self):
        res = self._provider(self.url("/429")).call_tool(
            "web_search", {"query": "python"}
        )
        self.assertTrue(res.get("isError"), res)
        text = res["content"][0]["text"].lower()
        self.assertIn("failed", text)
        self.assertNotIn("no web results", text)

    def test_transport_failure_is_honest_iserror(self):
        # A closed port -> connection failure -> WebSearchBackendError -> isError,
        # never a success-shaped 'No web results'.
        res = self._provider("http://127.0.0.1:1/", timeout=0.5).call_tool(
            "web_search", {"query": "x"}
        )
        self.assertTrue(res.get("isError"), res)

    def test_empty_success_is_honest_no_results_not_iserror(self):
        # Instant answers empty AND the results-page fallback empty (2026-08-31:
        # the fallback exists because instant answers answer almost nothing —
        # stubbed here so this stays an offline unit test of the HONEST-EMPTY
        # path, which is what it has always guarded).
        from unittest import mock

        class _Empty:
            def read(self, _n=None):
                return b""

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch("urllib.request.urlopen", return_value=_Empty()):
            res = self._provider(self.url("/empty")).call_tool(
                "web_search", {"query": "python"}
            )
        self.assertNotIn("isError", res)
        self.assertIn("No web results", res["content"][0]["text"])


class TestSearchBackends(unittest.TestCase):
    def test_keyless_parses_canned_response(self):
        results = KeylessBackend.parse(_DDG_JSON)
        urls = [r["url"] for r in results]
        self.assertIn("https://en.wikipedia.org/wiki/Python", urls)
        self.assertIn("https://example.com/cpython", urls)
        self.assertIn("https://example.com/pypy", urls)  # nested Topics flattened
        for r in results:
            self.assertTrue(r["url"])
            self.assertIn("title", r)

    def test_keyless_empty_and_malformed_yield_empty(self):
        self.assertEqual(KeylessBackend.parse({}), [])
        self.assertEqual(KeylessBackend.parse(b"not json at all"), [])
        self.assertEqual(KeylessBackend.parse(None), [])
        self.assertEqual(KeylessBackend.parse("[1,2,3]"), [])  # list, not a dict

    def test_apikey_parses_defensively(self):
        results = ApiKeyBackend.parse(_API_JSON)
        self.assertEqual(len(results), 2)  # the url-less row is dropped
        self.assertEqual(results[0]["url"], "https://a.example/1")
        self.assertEqual(results[1]["title"], "Second")
        self.assertEqual(results[1]["url"], "https://a.example/2")
        self.assertEqual(results[1]["snippet"], "two")

    def test_apikey_empty_and_malformed_yield_empty(self):
        self.assertEqual(ApiKeyBackend.parse({}), [])
        self.assertEqual(ApiKeyBackend.parse(b"garbage"), [])
        self.assertEqual(ApiKeyBackend.parse({"results": "not a list"}), [])

    def test_make_search_backend_picks_by_config(self):
        self.assertIsInstance(make_search_backend(), KeylessBackend)
        self.assertIsInstance(
            make_search_backend(api_key="k", endpoint="https://x/"), ApiKeyBackend
        )
        # A key with no endpoint has nowhere to go -> honest keyless fallback.
        self.assertIsInstance(make_search_backend(api_key="k"), KeylessBackend)


class TestKeylessOverRealHttp(_ServerMixin, unittest.TestCase):
    def test_keyless_search_real_http_roundtrip(self):
        # Point the keyless backend at the local fixture (real urllib path).
        backend = KeylessBackend(endpoint=self.url("/ddg"))
        results = backend.search("python")
        urls = [r["url"] for r in results]
        self.assertIn("https://example.com/cpython", urls)


class _RecordingBackend:
    def __init__(self):
        self.calls = []

    def search(self, query):
        self.calls.append(query)
        return [{"title": "T", "url": "https://x.example/", "snippet": "s"}]


class TestWebToolProvider(_ServerMixin, unittest.TestCase):
    def _provider(self, tel=None, backend=None):
        return WebToolProvider(
            telemetry=tel,
            search_backend=backend or _RecordingBackend(),
            allow_private=True,
        )

    def _spans(self, path):
        return [s for s in read_spans(path) if s["type"] == "tool_exec"]

    def test_lists_two_tools(self):
        tools = self._provider().list_tools()
        names = {t.name for t in tools}
        self.assertEqual(names, {"web_fetch", "web_search"})
        self.assertTrue(all(isinstance(t, MCPTool) for t in tools))

    def test_secret_bearing_query_is_blocked_no_egress(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            tel = Telemetry(spans)
            backend = _RecordingBackend()
            prov = self._provider(tel=tel, backend=backend)
            with self.assertRaises(MCPBlockedError):
                prov.call_tool("web_search", {"query": "my password is hunter2"})
            # No egress: the backend was never called.
            self.assertEqual(backend.calls, [])
            got = self._spans(spans)
            self.assertEqual(len(got), 1)
            self.assertTrue(got[0]["attrs"]["blocked"])
            self.assertEqual(got[0]["attrs"]["provider"], "web")
            self.assertEqual(got[0]["status"], "error")

    def test_secret_bearing_url_is_blocked_before_fetch(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            tel = Telemetry(spans)
            prov = self._provider(tel=tel)
            secret_url = self.url("/page?token=abc123")
            with self.assertRaises(MCPBlockedError):
                prov.call_tool("web_fetch", {"url": secret_url})
            # The gate fired BEFORE egress: the fixture server saw no request.
            self.assertEqual(_Handler.hits, [])
            got = self._spans(spans)
            self.assertEqual(len(got), 1)
            self.assertTrue(got[0]["attrs"]["blocked"])

    def test_normal_fetch_emits_truthful_span_and_shape(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            tel = Telemetry(spans)
            prov = self._provider(tel=tel)
            res = prov.call_tool("web_fetch", {"url": self.url("/page")})
            self.assertNotIn("isError", res)
            self.assertEqual(res["content"][0]["type"], "text")
            self.assertIn("brown fox", res["content"][0]["text"])
            got = self._spans(spans)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0]["attrs"]["provider"], "web")
            self.assertEqual(got[0]["attrs"]["tool"], "web_fetch")
            self.assertFalse(got[0]["attrs"]["is_error"])
            self.assertEqual(got[0]["status"], "ok")

    def test_search_result_carries_urls_for_citation(self):
        prov = self._provider()
        res = prov.call_tool("web_search", {"query": "python"})
        self.assertNotIn("isError", res)
        self.assertIn("https://x.example/", res["content"][0]["text"])
        self.assertEqual(res["results"][0]["url"], "https://x.example/")

    def test_unknown_tool_is_error_not_raise(self):
        res = self._provider().call_tool("nope", {})
        self.assertTrue(res.get("isError"))


class TestWebSpanDisclosure(_ServerMixin, unittest.TestCase):
    """WHAT the web call actually did, recorded on its span (2026-08-17).

    The complaint this closes: the engine ran 44 fetches and 22 searches for the
    user and every one rendered as the generic "fetching a page from the web…",
    because the span carried no URL, no query and no outcome — indistinguishable
    from the feature not existing.
    """

    def _prov(self, spans_path, backend=None):
        return WebToolProvider(
            telemetry=Telemetry(spans_path),
            search_backend=backend or _RecordingBackend(),
            allow_private=True,
        )

    def _tool_spans(self, path):
        return [s for s in read_spans(path) if s["type"] == "tool_exec"]

    def test_fetch_span_carries_url_host_status_and_size(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            res = self._prov(spans).call_tool("web_fetch", {"url": self.url("/page")})
            self.assertNotIn("isError", res)
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertEqual(attrs["url"], self.url("/page"))
            self.assertEqual(attrs["host"], "127.0.0.1")
            self.assertEqual(attrs["status"], 200)
            # The REAL body size, not an estimate.
            self.assertEqual(attrs["bytes"], len(_PAGE_HTML.encode("utf-8")))

    def test_failed_fetch_span_still_carries_the_real_http_status(self):
        """A 404 is a fact worth showing — "the page is gone" reads very
        differently from "something went wrong"."""
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            res = self._prov(spans).call_tool("web_fetch", {"url": self.url("/404")})
            self.assertTrue(res.get("isError"))
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertEqual(attrs["status"], 404)
            self.assertEqual(attrs["host"], "127.0.0.1")
            self.assertTrue(attrs["is_error"])

    def test_search_span_carries_the_query_and_the_result_count(self):
        # NB: the obvious example query, "mlx multi token prediction", can never
        # reach this path — SENSITIVE_KEYWORDS contains "token", so the gate
        # blocks it before egress (see the blocked tests below). That is the gate
        # working, not a bug, but it means a legitimate research query with an
        # unlucky word never runs at all.
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            prov = self._prov(spans)
            prov.call_tool("web_search", {"query": "mlx speculative decoding"})
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertEqual(attrs["query"], "mlx speculative decoding")
            self.assertEqual(attrs["result_count"], 1)  # _RecordingBackend: 1 hit

    def test_zero_hit_search_records_zero_not_nothing(self):
        """0 results is a real answer to "did that find anything?" — it must be
        recorded, not left absent (which the UI reads as "unknown")."""
        import tempfile, os

        class _Empty(_RecordingBackend):
            def search(self, query):
                self.calls.append(query)
                return []

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            self._prov(spans, backend=_Empty()).call_tool(
                "web_search", {"query": "nothing at all"}
            )
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertEqual(attrs["result_count"], 0)

    # -- THE PRIVACY LINE ---------------------------------------------------
    #
    # A web argument may be recorded because it ALREADY LEFT THE MACHINE. Two
    # things follow, and both are asserted here rather than left to a comment:
    # a call that never egressed records nothing, and a call the gate BLOCKED
    # records nothing (it was blocked because its argument looked like a secret,
    # so writing it to spans.jsonl would defeat the gate).

    def test_blocked_call_records_no_argument_at_all(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            prov = self._prov(spans)
            with self.assertRaises(MCPBlockedError):
                prov.call_tool("web_search", {"query": "my password is hunter2"})
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertTrue(attrs["blocked"])
            for forbidden in ("query", "url", "host", "arguments", "args"):
                self.assertNotIn(forbidden, attrs)
            # And the secret is nowhere in the raw span line, under any key.
            with open(spans, "r", encoding="utf-8") as fh:
                self.assertNotIn("hunter2", fh.read())

    def test_blocked_fetch_records_no_url(self):
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            prov = self._prov(spans)
            with self.assertRaises(MCPBlockedError):
                prov.call_tool("web_fetch", {"url": self.url("/page?token=abc123")})
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertTrue(attrs["blocked"])
            self.assertNotIn("url", attrs)
            self.assertNotIn("host", attrs)
            with open(spans, "r", encoding="utf-8") as fh:
                self.assertNotIn("abc123", fh.read())

    def test_pre_egress_ssrf_reject_records_no_destination(self):
        """The URL never reached the network, so the "it already egressed"
        justification does not hold and nothing is recorded."""
        import tempfile, os

        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            prov = WebToolProvider(
                telemetry=Telemetry(spans),
                search_backend=_RecordingBackend(),
                allow_private=False,  # the SSRF guard is LIVE
            )
            res = prov.call_tool("web_fetch", {"url": "http://169.254.169.254/creds"})
            self.assertTrue(res.get("isError"))
            attrs = self._tool_spans(spans)[0]["attrs"]
            self.assertNotIn("url", attrs)
            self.assertNotIn("host", attrs)
            self.assertTrue(attrs["is_error"])


class _FakeMCPSource:
    """An MCP-SHAPED fake tool source (list_tools + call_tool + parent_span_id)."""

    def __init__(self, tool_names):
        self.tool_names = tool_names
        self.parent_span_id = None
        self.calls = []

    def list_tools(self):
        return [MCPTool(name=n, description=n, input_schema={}) for n in self.tool_names]

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "from-fake:%s" % name}]}


class TestCompositeToolClient(unittest.TestCase):
    def test_merges_dedupes_and_routes(self):
        fake = _FakeMCPSource(["echo", "web_fetch"])  # web_fetch collides with web
        web = WebToolProvider(search_backend=_RecordingBackend(), allow_private=True)
        comp = CompositeToolClient([fake, web])

        names = [t.name for t in comp.list_tools()]
        # echo + web_fetch (fake, first wins) + web_search (web).
        self.assertEqual(names, ["echo", "web_fetch", "web_search"])
        self.assertEqual(names.count("web_fetch"), 1)  # de-duped by name

        # 'echo' routes to the fake source.
        r1 = comp.call_tool("echo", {})
        self.assertEqual(r1["content"][0]["text"], "from-fake:echo")
        # 'web_fetch' was advertised first by the fake, so it routes there.
        r2 = comp.call_tool("web_fetch", {"url": "x"})
        self.assertEqual(r2["content"][0]["text"], "from-fake:web_fetch")
        # 'web_search' routes to the web provider.
        r3 = comp.call_tool("web_search", {"query": "q"})
        self.assertIn("Web search results", r3["content"][0]["text"])

        # Unknown tool -> honest isError, never a raise.
        self.assertTrue(comp.call_tool("ghost", {}).get("isError"))

    def test_parent_span_id_fans_out(self):
        a = _FakeMCPSource(["a"])
        b = _FakeMCPSource(["b"])
        comp = CompositeToolClient([a, b])
        comp.parent_span_id = "SPAN-123"
        self.assertEqual(comp.parent_span_id, "SPAN-123")
        self.assertEqual(a.parent_span_id, "SPAN-123")
        self.assertEqual(b.parent_span_id, "SPAN-123")


if __name__ == "__main__":
    unittest.main()
