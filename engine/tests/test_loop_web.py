"""Integration: the tool-use loop over the REAL governed web provider.

Mirrors ``test_toolloop_integration`` but with ``WebToolProvider`` as the tool
source: a scripted fake model asks to ``web_fetch`` a LOCAL http.server fixture
URL, the loop executes it (real provider, real gates, a real ``tool_exec`` span
on a tmp spans file), feeds the page text back, and the model answers quoting
the observation — so the final text carries the REAL fixture content and a web
``tool_exec`` span landed. Proves list_tools -> gated call_tool -> span ->
feed-back -> final, end-to-end, offline (no real internet).
"""

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import _bootstrap  # noqa: F401

from scprism_engine.gateway import ModelCallResult
from scprism_engine.loop import _emit_withheld_spans
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.toolloop import ToolCallTrace, run_tool_loop
from scprism_engine.webtools import CompositeToolClient, WebToolProvider

_FIXTURE_HTML = (
    "<html><head><title>Loop Fixture</title></head>"
    "<body><p>MAGIC_TOKEN_XYZ the fox is here.</p></body></html>"
)


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = _FIXTURE_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _res(text):
    return ModelCallResult(
        text=text,
        tokens_in=len(text) // 4 + 1,
        tokens_out=len(text) // 4 + 1,
        cache="miss",
        provider="stub",
        model="stub",
        is_real=False,
    )


def _tool_call(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


def _fetch_then_cite_model(url):
    """Round 1: request web_fetch(url). Round 2: a final answer that CITES the
    url it fetched and quotes the observation the loop fed back."""
    state = {"round": 0}

    def model_fn(messages):
        state["round"] += 1
        if state["round"] == 1:
            return _res(_tool_call("web_fetch", {"url": url}))
        return _res("Per %s the page says: %s" % (url, messages[-1]["content"]))

    return model_fn


class TestToolLoopOverRealWeb(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self._tmp = tempfile.TemporaryDirectory()
        self.spans_path = os.path.join(self._tmp.name, "spans.jsonl")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)
        self._tmp.cleanup()

    def test_web_fetch_round_trip_with_real_span(self):
        url = "http://127.0.0.1:%d/page" % self.port
        tel = Telemetry(self.spans_path)
        provider = WebToolProvider(telemetry=tel, allow_private=True)
        tools = provider.list_tools()
        self.assertIn("web_fetch", {t.name for t in tools})

        result = run_tool_loop(
            messages=[
                {"role": "system", "content": "You are the companion."},
                {"role": "user", "content": "look up that page for me"},
            ],
            tools=tools,
            model_fn=_fetch_then_cite_model(url),
            tool_exec=provider.call_tool,
        )

        # The final text quotes the observation, which carries the REAL fetched
        # page content — nothing fabricated, and the source URL survives.
        self.assertIn("MAGIC_TOKEN_XYZ", result.text)
        self.assertIn(url, result.text)
        self.assertIn("```tool_result", result.text)
        self.assertEqual(result.iterations, 1)
        trace = result.tool_calls[0]
        self.assertEqual(trace.tool, "web_fetch")
        self.assertTrue(trace.ok)
        self.assertFalse(trace.blocked)

        # Exactly one real web tool_exec span landed.
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["attrs"]["provider"], "web")
        self.assertEqual(spans[0]["attrs"]["tool"], "web_fetch")
        self.assertEqual(spans[0]["status"], "ok")
        self.assertFalse(spans[0]["attrs"]["is_error"])


class _StubBackend:
    def search(self, query):
        return [{"title": "T", "url": "https://x.example/", "snippet": "s"}]


class TestWithheldSpanProvider(unittest.TestCase):
    """W4: a WITHHELD web result must be audited ``provider="web"`` (derived from
    the tool source), not the old hardcoded ``provider="mcp"``. Reverting to the
    hardcoded provider fails this."""

    def _withheld_web_spans(self, spans):
        return [
            s
            for s in spans
            if s["type"] == "tool_exec" and s["attrs"].get("withheld") is True
        ]

    def test_withheld_web_result_is_audited_provider_web(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "spans.jsonl")
            tel = Telemetry(path)
            web = WebToolProvider(search_backend=_StubBackend(), allow_private=True)
            # The loop passes the (possibly composite) tool source; a composite
            # routes web_fetch to the web provider via its _owner map.
            comp = CompositeToolClient([web])
            comp.list_tools()  # populate the ownership map (as the loop does)
            traces = [
                ToolCallTrace(
                    tool="web_fetch", ok=True, blocked=False, detail="", withheld=True
                )
            ]
            _emit_withheld_spans(tel, "PARENT-SPAN", comp, traces)

            got = self._withheld_web_spans(read_spans(path))
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0]["attrs"]["provider"], "web")  # not "mcp"
            self.assertEqual(got[0]["attrs"]["server"], "web")
            self.assertEqual(got[0]["attrs"]["tool"], "web_fetch")
            self.assertEqual(got[0]["parent_id"], "PARENT-SPAN")

    def test_web_provider_directly_as_source_still_web(self):
        # A web-only run passes the WebToolProvider itself (no composite).
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "spans.jsonl")
            tel = Telemetry(path)
            web = WebToolProvider(search_backend=_StubBackend(), allow_private=True)
            traces = [
                ToolCallTrace(
                    tool="web_fetch", ok=True, blocked=False, detail="", withheld=True
                )
            ]
            _emit_withheld_spans(tel, "PARENT-SPAN", web, traces)
            got = self._withheld_web_spans(read_spans(path))
            self.assertEqual(got[0]["attrs"]["provider"], "web")


if __name__ == "__main__":
    unittest.main()
