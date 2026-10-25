"""Engine-level approval gate (MCP follow-ons, Part B).

The THIRD governance gate: a required-but-ungranted tool call is HELD for
sign-off — it NEVER egresses, NEVER fabricates success, and is audited as a
``held=True`` tool_exec span, while the loop continues on an honest observation.
Approval is additive: an ALLOWED call still runs the allowlist + sensitivity
gates. Empty policy → byte-identical (every call delegates).
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
from scprism_engine.__main__ import main
from scprism_engine.approval import (
    ApprovalGate,
    ToolApprovalPolicy,
    load_approval_policy,
)
from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPBlockedError, MCPClient, MCPError, MCPTool
from scprism_engine.telemetry import Telemetry, read_spans

_ECHO_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_echo_server.py"
)


def _tool_call_block(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


class SpyInner:
    """Duck-typed inner tool source that RECORDS every call_tool invocation — so
    a held call can be proven never to have reached the inner source."""

    def __init__(self, telemetry=None, server_name="spy"):
        self.calls = []
        self.telemetry = telemetry
        self.server_name = server_name
        self.parent_span_id = None

    def list_tools(self):
        return [
            MCPTool(name="secret", description="s", input_schema={}),
            MCPTool(name="safe", description="s", input_schema={}),
        ]

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "ran:%s" % name}]}


class TestToolApprovalPolicy(unittest.TestCase):
    def test_empty_require_allows_everything(self):
        p = ToolApprovalPolicy()
        self.assertFalse(p.is_active())
        self.assertEqual(p.decide("srv", "anything", {}), "allow")

    def test_tool_name_is_held_others_allowed(self):
        p = ToolApprovalPolicy(require={"secret"})
        self.assertTrue(p.is_active())
        self.assertEqual(p.decide("srv", "secret", {}), "hold")
        self.assertEqual(p.decide("srv", "safe", {}), "allow")

    def test_server_name_holds_all_its_tools(self):
        p = ToolApprovalPolicy(require={"echo"})  # 'echo' is a SERVER name
        self.assertEqual(p.decide("echo", "add", {}), "hold")
        self.assertEqual(p.decide("echo", "echo", {}), "hold")
        self.assertEqual(p.decide("other", "add", {}), "allow")

    def test_granted_server_lets_its_tools_through(self):
        p = ToolApprovalPolicy(require={"echo"}, granted={"echo"})
        self.assertEqual(p.decide("echo", "add", {}), "allow")

    def test_all_holds_everything_ungranted(self):
        p = ToolApprovalPolicy(require="all", granted={"safe"})
        self.assertEqual(p.decide("s1", "secret", {}), "hold")
        self.assertEqual(p.decide("s2", "anything", {}), "hold")
        self.assertEqual(p.decide("s1", "safe", {}), "allow")

    def test_comma_and_whitespace_normalization(self):
        p = ToolApprovalPolicy(require="secret, ,danger")
        self.assertEqual(p.require, {"secret", "danger"})


class TestApprovalGate(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.spans = os.path.join(self._tmp.name, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def _held_spans(self):
        if not os.path.exists(self.spans):
            return []
        return [
            s
            for s in read_spans(self.spans)
            if s["type"] == "tool_exec" and s["attrs"].get("held") is True
        ]

    def test_held_call_never_reaches_inner_and_is_honest(self):
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel, server_name="spy")
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}))
        gate.parent_span_id = "P1"

        res = gate.call_tool("secret", {"x": 1})

        # The inner source's call_tool was NEVER invoked — nothing egressed.
        self.assertEqual(inner.calls, [])
        # The observation is honest: isError-shaped, held=True, "needs approval".
        self.assertIs(res["isError"], True)
        self.assertIs(res["held"], True)
        self.assertIn("needs approval", res["content"][0]["text"])
        self.assertIn("not run", res["content"][0]["text"])
        # A held=True tool_exec span was audited (provider/server from the inner
        # source), parented under the caller's span.
        held = self._held_spans()
        self.assertTrue(held, "a held=True tool_exec span must be recorded")
        self.assertEqual(held[0]["attrs"]["tool"], "secret")
        self.assertEqual(held[0]["attrs"]["provider"], "mcp")
        self.assertEqual(held[0]["attrs"]["server"], "spy")
        self.assertEqual(held[0]["parent_id"], "P1")

    def test_allowed_call_delegates_to_inner(self):
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}))

        res = gate.call_tool("safe", {"q": 1})

        self.assertEqual(inner.calls, [("safe", {"q": 1})])
        self.assertEqual(res["content"][0]["text"], "ran:safe")
        self.assertEqual(self._held_spans(), [])

    def test_empty_policy_delegates_every_call(self):
        # Byte-identical: an inactive policy holds nothing — every call passes.
        inner = SpyInner()
        gate = ApprovalGate(inner, ToolApprovalPolicy())
        gate.call_tool("secret", {})
        gate.call_tool("safe", {})
        self.assertEqual(inner.calls, [("secret", {}), ("safe", {})])

    def test_list_tools_and_parent_span_pass_through(self):
        inner = SpyInner()
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}))
        self.assertEqual([t.name for t in gate.list_tools()], ["secret", "safe"])
        gate.parent_span_id = "PX"
        self.assertEqual(inner.parent_span_id, "PX")
        self.assertEqual(gate.parent_span_id, "PX")

    def test_approval_is_additive_sensitivity_gate_still_runs(self):
        # A GRANTED call is not held, but the inner MCPClient's sensitivity gate
        # still blocks secrets before egress — approval is on top of, never
        # instead of, the existing gates.
        with MCPClient(
            [sys.executable, _ECHO_FIXTURE], server_name="echo"
        ) as client:
            gate = ApprovalGate(
                client, ToolApprovalPolicy(require={"echo"}, granted={"echo"})
            )
            with self.assertRaises(MCPBlockedError):
                gate.call_tool("echo", {"text": "my password is hunter2"})

    def test_held_over_composite_attributes_to_owning_provider(self):
        # Over a CompositeToolClient the held span must name the OWNING provider,
        # not a generic default — the audit must not lie about who would run it.
        from scprism_engine.webtools import CompositeToolClient

        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel, server_name="alpha")
        comp = CompositeToolClient([inner])
        comp.list_tools()  # populate the owner map
        gate = ApprovalGate(comp, ToolApprovalPolicy(require={"secret"}))
        gate.parent_span_id = "PC"
        gate.call_tool("secret", {})
        self.assertEqual(inner.calls, [])
        held = self._held_spans()
        self.assertTrue(held)
        self.assertEqual(held[0]["attrs"]["server"], "alpha")


class TestLoadApprovalPolicy(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, obj_or_text):
        path = os.path.join(self.vault, "mcp-approvals.json")
        with open(path, "w", encoding="utf-8") as fh:
            if isinstance(obj_or_text, str):
                fh.write(obj_or_text)
            else:
                json.dump(obj_or_text, fh)

    def test_no_file_no_flags_is_inactive(self):
        p = load_approval_policy(self.vault)
        self.assertFalse(p.is_active())

    def test_file_is_loaded(self):
        self._write({"require": ["echo", "add"], "granted": ["add"]})
        p = load_approval_policy(self.vault)
        self.assertEqual(p.require, {"echo", "add"})
        self.assertEqual(p.granted, {"add"})
        self.assertTrue(p.is_active())

    def test_flags_union_with_file(self):
        self._write({"require": ["echo"], "granted": ["add"]})
        p = load_approval_policy(
            self.vault, require=["upper", "danger"], approve=["echo"]
        )
        self.assertEqual(p.require, {"echo", "upper", "danger"})
        self.assertEqual(p.granted, {"add", "echo"})

    def test_flags_only_no_file(self):
        p = load_approval_policy(self.vault, require="all")
        self.assertEqual(p.require, {"all"})
        self.assertTrue(p.is_active())

    def test_malformed_json_raises_honest_error(self):
        self._write("{ not json")
        with self.assertRaises(MCPError):
            load_approval_policy(self.vault)

    def test_malformed_shape_raises_honest_error(self):
        self._write({"require": 5})
        with self.assertRaises(MCPError):
            load_approval_policy(self.vault)

    def test_non_object_root_raises(self):
        self._write(["echo"])
        with self.assertRaises(MCPError):
            load_approval_policy(self.vault)


class TestCLIApprovalGate(unittest.TestCase):
    """--require-approval end to end: a required tool is HELD — the real MCP
    call never runs (no non-held mcp tool_exec span) yet a held=True span lands
    and the run completes honestly (exit 0)."""

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
            json.dump([{"name": "echo", "command": [sys.executable, _ECHO_FIXTURE]}], fh)

    def _patch_first_call_requests_echo(self):
        lock = threading.Lock()
        state = {"n": 0}

        def patched(self, messages, route):  # noqa: ANN001 (test double)
            with lock:
                state["n"] += 1
                first = state["n"] == 1
            text = _tool_call_block("echo", {"text": "hi"}) if first else "final: done"
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

    def test_required_tool_is_held_and_never_egresses(self):
        self._seed_config()
        self._patch_first_call_requests_echo()
        code, out, err = self._run_cli(
            [
                "run", "echo a thing", "--vault", self.vault,
                "--mcp-server", "echo", "--require-approval", "echo",
            ]
        )
        self.assertEqual(code, 0)
        execs = self._mcp_tool_execs()
        held = [s for s in execs if s["attrs"].get("held") is True]
        self.assertTrue(held, "a held=True tool_exec span must be recorded")
        self.assertEqual(held[0]["attrs"]["tool"], "echo")
        # The real call NEVER ran: no non-held mcp tool_exec span for echo.
        non_held = [s for s in execs if not s["attrs"].get("held")]
        self.assertEqual(non_held, [], "the held call must not egress to the server")

    def test_malformed_approvals_file_exits_1_with_json_error(self):
        self._seed_config()
        self._patch_first_call_requests_echo()
        with open(os.path.join(self.vault, "mcp-approvals.json"), "w") as fh:
            fh.write("{ not json")
        code, out, err = self._run_cli(
            ["run", "echo a thing", "--vault", self.vault, "--mcp-server", "echo"]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        obj = json.loads(err.splitlines()[-1])
        self.assertFalse(obj["ok"])


if __name__ == "__main__":
    unittest.main()
