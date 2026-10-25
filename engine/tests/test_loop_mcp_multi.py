"""Multiple MCP servers in one run (MCP follow-ons, Part A).

``--mcp-server`` now takes MANY (repeatable or comma-list): each is opened and
their tools are merged into one CompositeToolClient (name-deduped, first wins),
so the loop sees tools from ALL of them. A single server stays unchanged (no
composite — byte-identical). Proven at the composition-helper level and end to
end through the CLI against two real stdlib fixtures.
"""

import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout

import _bootstrap  # noqa: F401

import scprism_engine.gateway as gateway_mod
from scprism_engine.__main__ import (
    _compose_tool_source,
    _parse_server_names,
    main,
)
from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPTool
from scprism_engine.telemetry import read_spans
from scprism_engine.webtools import CompositeToolClient

_ECHO_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_echo_server.py"
)
_UPPER_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_upper_server.py"
)


def _tool_call_block(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


class _FakeSource:
    def __init__(self, names):
        self.names = names
        self.calls = []
        self.parent_span_id = None

    def list_tools(self):
        return [MCPTool(name=n, description=n, input_schema={}) for n in self.names]

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "from:%s" % name}]}


class TestParseServerNames(unittest.TestCase):
    def test_none_and_empty(self):
        self.assertEqual(_parse_server_names(None), [])
        self.assertEqual(_parse_server_names([]), [])

    def test_single_string_list(self):
        self.assertEqual(_parse_server_names(["echo"]), ["echo"])

    def test_comma_list_within_one_flag(self):
        self.assertEqual(_parse_server_names(["a,b, c"]), ["a", "b", "c"])

    def test_repeated_flags(self):
        self.assertEqual(_parse_server_names(["a", "b"]), ["a", "b"])

    def test_dedupe_preserves_first_order(self):
        self.assertEqual(_parse_server_names(["a,b", "a", "c"]), ["a", "b", "c"])


class TestComposeToolSource(unittest.TestCase):
    def test_none_when_no_sources(self):
        self.assertIsNone(_compose_tool_source([], None))
        self.assertIsNone(_compose_tool_source(None, None))
        self.assertIsNone(_compose_tool_source([None], None))

    def test_single_client_is_not_wrapped(self):
        a = _FakeSource(["x"])
        # One server, no web -> the source itself, NO composite (byte-identical).
        # The live denylist (toolhooks.PreToolUseGate) now wraps whatever this
        # function composes, so every run path gets it by construction. These
        # assertions are about the COMPOSITE — that a single source is not
        # needlessly fanned — so they look through the denylist to the source
        # underneath. `.source` is the wrapper's inner handle.
        self.assertIs(_compose_tool_source([a], None).source, a)

    def test_two_clients_compose_and_merge_deduped(self):
        a = _FakeSource(["echo", "add"])
        b = _FakeSource(["echo", "upper"])  # 'echo' collides with a
        comp = _compose_tool_source([a, b], None).source
        self.assertIsInstance(comp, CompositeToolClient)
        names = [t.name for t in comp.list_tools()]
        # Tools from BOTH, echo deduped (first source wins).
        self.assertEqual(names, ["echo", "add", "upper"])
        # 'upper' (only on b) routes to b.
        comp.call_tool("upper", {"t": 1})
        self.assertEqual(b.calls, [("upper", {"t": 1})])
        # 'echo' routes to a (first advertiser), never b.
        comp.call_tool("echo", {})
        self.assertEqual(a.calls, [("echo", {})])

    def test_single_client_plus_web_composes(self):
        a = _FakeSource(["x"])
        web = _FakeSource(["web_search"])
        comp = _compose_tool_source([a], web).source
        self.assertIsInstance(comp, CompositeToolClient)
        self.assertEqual([t.name for t in comp.list_tools()], ["x", "web_search"])


class TestCLIMultiServer(unittest.TestCase):
    """Two real fixtures via --mcp-server echo,upper: the loop calls a tool that
    ONLY the second server advertises, proving the composite merged both."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self._orig_model_call = gateway_mod.Gateway.model_call

    def tearDown(self):
        gateway_mod.Gateway.model_call = self._orig_model_call
        self._tmp.cleanup()

    def _run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue().strip(), err.getvalue().strip()

    def _seed_config(self):
        path = os.path.join(self.vault, "mcp-servers.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                [
                    {"name": "echo", "command": [sys.executable, _ECHO_FIXTURE]},
                    {"name": "upper", "command": [sys.executable, _UPPER_FIXTURE]},
                ],
                fh,
            )

    def _patch_first_call_requests(self, tool, args):
        lock = threading.Lock()
        state = {"n": 0}

        def patched(self, messages, route):  # noqa: ANN001 (test double)
            with lock:
                state["n"] += 1
                first = state["n"] == 1
            text = _tool_call_block(tool, args) if first else "final: done"
            return ModelCallResult(
                text=text, tokens_in=5, tokens_out=7, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway_mod.Gateway.model_call = patched

    def _mcp_tool_execs(self):
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        return [
            s for s in spans
            if s["type"] == "tool_exec" and s["attrs"].get("provider") == "mcp"
        ]

    def test_comma_list_attaches_both_servers(self):
        self._seed_config()
        # 'upper' lives ONLY on the second server — calling it proves the loop
        # saw the merged toolset from BOTH servers.
        self._patch_first_call_requests("upper", {"text": "hi"})
        code, out, err = self._run_cli(
            [
                "run", "shout a thing", "--vault", self.vault,
                "--mcp-server", "echo,upper",
            ]
        )
        self.assertEqual(code, 0)
        execs = self._mcp_tool_execs()
        upper_execs = [s for s in execs if s["attrs"].get("tool") == "upper"]
        self.assertTrue(upper_execs, "the second server's tool must be callable")
        self.assertEqual(upper_execs[0]["attrs"]["server"], "upper")
        # One shared run_id across every span (shared Telemetry, no phantom run).
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertEqual(len({s["run_id"] for s in spans}), 1)

    def test_repeated_flag_form_also_attaches_both(self):
        self._seed_config()
        self._patch_first_call_requests("upper", {"text": "hey"})
        code, out, err = self._run_cli(
            [
                "run", "shout a thing", "--vault", self.vault,
                "--mcp-server", "echo", "--mcp-server", "upper",
            ]
        )
        self.assertEqual(code, 0)
        upper_execs = [
            s for s in self._mcp_tool_execs() if s["attrs"].get("tool") == "upper"
        ]
        self.assertTrue(upper_execs)

    def test_unknown_among_many_exits_1(self):
        self._seed_config()
        code, out, err = self._run_cli(
            [
                "run", "do a thing", "--vault", self.vault,
                "--mcp-server", "echo,nope",
            ]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        obj = json.loads(err.splitlines()[-1])
        self.assertFalse(obj["ok"])
        self.assertIn("'nope' not found", obj["error"])


if __name__ == "__main__":
    unittest.main()
