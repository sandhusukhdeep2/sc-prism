"""Integration: the tool-use loop over the REAL governed MCP client.

Spawns the stdlib fixture server (``fixtures/mcp_echo_server.py``) through the
real ``MCPClient`` — real handshake, real gates, real ``tool_exec`` spans on a
tmp spans file — driven by a scripted fake model that first requests a tool and
then answers quoting the observation. Proves connect -> list_tools -> gated
call_tool -> span -> feed-back -> final, end-to-end, offline.
"""

import json
import os
import sys
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPClient
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.toolloop import run_tool_loop

_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_echo_server.py"
)


def _cmd():
    return [sys.executable, _FIXTURE]


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


def _quoting_model(first_call):
    """Round 1: emit ``first_call``. Round 2: a final answer quoting the
    observation turn the loop fed back."""
    state = {"round": 0}

    def model_fn(messages):
        state["round"] += 1
        if state["round"] == 1:
            return _res(first_call)
        return _res("final answer quoting: %s" % messages[-1]["content"])

    return model_fn


class TestToolLoopOverRealMCP(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.spans_path = os.path.join(self._tmp.name, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_echo_tool_round_trip_with_real_span(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            tools = client.list_tools()
            self.assertIn("echo", {t.name for t in tools})
            result = run_tool_loop(
                messages=[
                    {"role": "system", "content": "You are the companion."},
                    {"role": "user", "content": "echo something for me"},
                ],
                tools=tools,
                model_fn=_quoting_model(
                    _tool_call("echo", {"text": "hello from the loop"})
                ),
                tool_exec=client.call_tool,
            )
        # The final text quotes the observation, which carries the server's
        # REAL echoed content — nothing fabricated.
        self.assertIn("hello from the loop", result.text)
        self.assertIn("```tool_result", result.text)
        self.assertEqual(result.iterations, 1)
        trace = result.tool_calls[0]
        self.assertEqual(trace.tool, "echo")
        self.assertTrue(trace.ok)
        self.assertFalse(trace.blocked)
        # Exactly one real tool_exec span landed on the spans file.
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span["attrs"]["tool"], "echo")
        self.assertEqual(span["attrs"]["provider"], "mcp")
        self.assertEqual(span["status"], "ok")
        self.assertFalse(span["attrs"]["is_error"])

    def test_disallowed_tool_is_blocked_audited_and_loop_completes(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(
            _cmd(), allowed_tools=["echo"], telemetry=tel, server_name="echo"
        ) as client:
            tools = client.list_tools()
            result = run_tool_loop(
                messages=[
                    {"role": "system", "content": "You are the companion."},
                    {"role": "user", "content": "add 2 and 3"},
                ],
                tools=tools,
                model_fn=_quoting_model(_tool_call("add", {"a": 2, "b": 3})),
                tool_exec=client.call_tool,
            )
        # The loop fed back an honest ok:false observation and completed.
        self.assertIn('"ok": false', result.text)
        self.assertNotIn("5", result.text)  # the blocked add never produced a sum
        trace = result.tool_calls[0]
        self.assertFalse(trace.ok)
        self.assertTrue(trace.blocked)
        self.assertIn("not allowed", trace.detail)
        # The block was audited: a blocked=True tool_exec span, status error.
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        self.assertTrue(spans[0]["attrs"].get("blocked"))
        self.assertEqual(spans[0]["attrs"]["tool"], "add")
        self.assertEqual(spans[0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
