"""Tests for the governed MCP client (ADR-009) against a local fixture server.

A stdlib fixture MCP server (``fixtures/mcp_echo_server.py``) is spawned over
stdio. These exercise the REAL handshake (initialize -> notifications/
initialized -> tools/list -> tools/call), the two governance gates (tool
allowlist + sensitivity), the ``tool_exec`` telemetry (allowed AND blocked), and
clean subprocess shutdown. No network, no providers.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main
from scprism_engine.mcp import MCPClient, MCPError, MCPTool, load_mcp_servers
from scprism_engine.telemetry import Telemetry, read_spans

_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_echo_server.py"
)


def _cmd():
    return [sys.executable, _FIXTURE]


class TestMCPHandshakeAndCalls(unittest.TestCase):
    def test_list_tools_after_handshake(self):
        with MCPClient(_cmd()) as client:
            tools = client.list_tools()
        by_name = {t.name: t for t in tools}
        self.assertIn("echo", by_name)
        self.assertIn("add", by_name)
        self.assertIsInstance(by_name["echo"], MCPTool)
        # Descriptions come through from the server.
        self.assertTrue(by_name["echo"].description)
        self.assertTrue(by_name["add"].description)
        self.assertIn("text", by_name["echo"].input_schema.get("properties", {}))

    def test_initialize_returns_server_info(self):
        with MCPClient(_cmd()) as client:
            info = client.initialize()  # idempotent; already called by __enter__
        self.assertEqual(info["serverInfo"]["name"], "echo")

    def test_call_echo_and_add(self):
        with MCPClient(_cmd()) as client:
            echoed = client.call_tool("echo", {"text": "hi there"})
            self.assertEqual(echoed["content"][0]["text"], "hi there")
            summed = client.call_tool("add", {"a": 2, "b": 3})
            self.assertEqual(summed["content"][0]["text"], "5")


class TestGovernanceGates(unittest.TestCase):
    def test_tool_allowlist_blocks_unlisted_tool(self):
        with MCPClient(_cmd(), allowed_tools=["echo"]) as client:
            with self.assertRaises(MCPError):
                client.call_tool("add", {"a": 2, "b": 3})
            # The block happened BEFORE the server was reached: a subsequent
            # ALLOWED call still round-trips (the connection is intact and the
            # blocked 'add' never produced a "5").
            echoed = client.call_tool("echo", {"text": "still alive"})
            self.assertEqual(echoed["content"][0]["text"], "still alive")

    def test_allowlist_allows_listed_tool(self):
        with MCPClient(_cmd(), allowed_tools=["echo", "add"]) as client:
            summed = client.call_tool("add", {"a": 4, "b": 1})
            self.assertEqual(summed["content"][0]["text"], "5")

    def test_sensitivity_gate_blocks_secret_arguments(self):
        with MCPClient(_cmd()) as client:
            with self.assertRaises(MCPError) as ctx:
                client.call_tool("echo", {"text": "my api-key is sk-123"})
            self.assertIn("sensitive", str(ctx.exception).lower())
            # The secret never went to the server; the client is still usable.
            ok = client.call_tool("echo", {"text": "harmless"})
            self.assertEqual(ok["content"][0]["text"], "harmless")


class TestTelemetry(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.spans_path = os.path.join(self._tmp.name, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_successful_call_emits_tool_exec_span(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            client.call_tool("echo", {"text": "traced"})
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span["attrs"]["server"], "echo")
        self.assertEqual(span["attrs"]["tool"], "echo")
        self.assertEqual(span["attrs"]["provider"], "mcp")
        self.assertEqual(span["status"], "ok")
        self.assertFalse(span["attrs"]["is_error"])

    def test_blocked_call_emits_audited_tool_exec_span(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(
            _cmd(), allowed_tools=["echo"], telemetry=tel, server_name="echo"
        ) as client:
            with self.assertRaises(MCPError):
                client.call_tool("add", {"a": 2, "b": 3})
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertTrue(span["attrs"].get("blocked"))
        self.assertEqual(span["attrs"]["tool"], "add")
        self.assertEqual(span["status"], "error")

    def test_sensitivity_block_is_also_audited(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            with self.assertRaises(MCPError):
                client.call_tool("echo", {"text": "the secret token"})
        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        self.assertTrue(spans[0]["attrs"].get("blocked"))
        self.assertEqual(spans[0]["status"], "error")

    def test_no_telemetry_writes_no_spans(self):
        # A None telemetry must be byte-identical to a no-telemetry caller.
        with MCPClient(_cmd()) as client:
            client.call_tool("echo", {"text": "quiet"})
        self.assertFalse(os.path.exists(self.spans_path))

    def test_call_records_result_size_so_the_row_is_not_blank(self):
        """The SAFE half of the disclosure: an MCP row used to read
        `⛭ echo·echo` and nothing else, so a call that came back with a page of
        results and one that came back empty were the same row. A SIZE is not
        content and not arguments."""
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            client.call_tool("echo", {"text": "traced"})
        span = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"][0]
        self.assertIsInstance(span["attrs"]["bytes"], int)
        self.assertGreater(span["attrs"]["bytes"], 0)

    # -- THE PRIVACY LINE (see engine/scprism_engine/webtools.py) -----------
    #
    # webtools may record a URL / a search query because those ALREADY LEFT THE
    # MACHINE. An MCP tool's arguments have NOT egressed and may hold material
    # the user never authorised sending anywhere — so they are never written to
    # a span, and this asserts it rather than trusting the comment.

    def test_mcp_arguments_are_never_recorded_on_the_span(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            client.call_tool("echo", {"text": "kangaroo-canary-9182"})
        span = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"][0]
        for forbidden in ("arguments", "args", "text", "query", "url", "input"):
            self.assertNotIn(forbidden, span["attrs"])
        with open(self.spans_path, "r", encoding="utf-8") as fh:
            self.assertNotIn("kangaroo-canary-9182", fh.read())

    def test_blocked_mcp_call_records_no_arguments_either(self):
        tel = Telemetry(self.spans_path)
        with MCPClient(_cmd(), telemetry=tel, server_name="echo") as client:
            with self.assertRaises(MCPError):
                client.call_tool("echo", {"text": "the secret token wallaby-4471"})
        span = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"][0]
        self.assertTrue(span["attrs"].get("blocked"))
        self.assertNotIn("arguments", span["attrs"])
        with open(self.spans_path, "r", encoding="utf-8") as fh:
            self.assertNotIn("wallaby-4471", fh.read())


class TestShutdown(unittest.TestCase):
    def test_child_is_terminated_after_context(self):
        client = MCPClient(_cmd())
        with client:
            client.call_tool("echo", {"text": "x"})
            proc = client._proc
            self.assertIsNone(proc.poll(), "child should be alive inside the block")
        # After the with-block the child must be reaped (no orphan).
        self.assertIsNotNone(proc.poll(), "child must be terminated after close")
        # Idempotent second close.
        client.close()

    def test_no_orphan_when_handshake_fails(self):
        # A server that accepts the connection but never answers `initialize`.
        # __enter__ must close() the child before re-raising, or it would orphan
        # (Python never calls __exit__ when __enter__ raises).
        hang = [sys.executable, "-c", "import sys, time\nsys.stdin.readline()\ntime.sleep(30)"]
        client = MCPClient(hang, timeout=1.0)
        with self.assertRaises(MCPError):
            with client:
                pass
        self.assertIsNotNone(client._proc, "child was spawned")
        self.assertIsNotNone(
            client._proc.poll(), "child must be terminated after a failed handshake (no orphan)"
        )


class TestConfigLoader(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_returns_empty(self):
        self.assertEqual(load_mcp_servers(os.path.join(self.dir, "nope.json")), {})

    def test_valid_config_parses_by_name(self):
        path = os.path.join(self.dir, "mcp-servers.json")
        with open(path, "w") as fh:
            fh.write(
                '[{"name":"echo","command":["python","srv.py"],'
                '"allowed_tools":["echo"]}]'
            )
        servers = load_mcp_servers(path)
        self.assertIn("echo", servers)
        self.assertEqual(servers["echo"]["command"], ["python", "srv.py"])
        self.assertEqual(servers["echo"]["allowed_tools"], ["echo"])

    def test_malformed_config_raises(self):
        path = os.path.join(self.dir, "bad.json")
        with open(path, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(MCPError):
            load_mcp_servers(path)

    def test_entry_without_command_raises(self):
        path = os.path.join(self.dir, "nocmd.json")
        with open(path, "w") as fh:
            fh.write('[{"name":"x"}]')
        with self.assertRaises(MCPError):
            load_mcp_servers(path)


def _run_cli(argv):
    """Invoke the CLI, capturing (exit_code, parsed_stdout_json_or_None)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    return code, (json.loads(text) if text else None)


class TestMCPCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.config = os.path.join(self.vault, "mcp-servers.json")
        with open(self.config, "w") as fh:
            json.dump(
                [
                    {"name": "echo", "command": _cmd()},
                    {"name": "echo-locked", "command": _cmd(), "allowed_tools": ["echo"]},
                ],
                fh,
            )

    def tearDown(self):
        self._tmp.cleanup()

    def test_cli_list_tools(self):
        code, obj = _run_cli(["mcp", "--vault", self.vault, "--server", "echo",
                              "--action", "list"])
        self.assertEqual(code, 0)
        names = {t["name"] for t in obj["tools"]}
        self.assertEqual(names, {"echo", "add"})

    def test_cli_call_tool(self):
        code, obj = _run_cli([
            "mcp", "--vault", self.vault, "--server", "echo",
            "--action", "call", "--tool", "add", "--args", '{"a": 2, "b": 3}',
        ])
        self.assertEqual(code, 0)
        self.assertEqual(obj["result"]["content"][0]["text"], "5")
        # The real call was traced.
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertTrue(any(s["type"] == "tool_exec" for s in spans))

    def test_cli_blocked_call_exits_nonzero_and_is_not_faked(self):
        code, obj = _run_cli([
            "mcp", "--vault", self.vault, "--server", "echo-locked",
            "--action", "call", "--tool", "add", "--args", '{"a": 2, "b": 3}',
        ])
        self.assertNotEqual(code, 0)  # honest failure, not a faked "5"
        self.assertIsNone(obj)  # nothing printed to stdout
        # The block was audited on the vault's span spine.
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        blocked = [s for s in spans if s["type"] == "tool_exec"
                   and s["attrs"].get("blocked")]
        self.assertEqual(len(blocked), 1)

    def test_cli_unknown_server_exits_nonzero(self):
        code, _ = _run_cli(["mcp", "--vault", self.vault, "--server", "ghost",
                            "--action", "list"])
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
