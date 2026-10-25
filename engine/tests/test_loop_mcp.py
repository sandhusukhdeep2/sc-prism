"""loop.run + run_team over the MCP tool-use loop (v2b Layer 2, ADR-035).

Proves the dispatch wiring end to end with a FAKE duck-typed mcp_client (the
real governed client is covered by test_toolloop_integration) and the REAL
gateway in offline-stub mode: a scripted `gateway.model_call` first requests a
tool, the deterministic loop executes it through the fake client, and the run
completes with one `model_call` span per model TURN. Also pins the
byte-identical guarantee — without an mcp_client the span profile is exactly
the pre-v2b shape (one `model_call` span per dispatch step) — and the CLI's
unknown `--mcp-server` error contract (stderr JSON + exit 1).
"""

import copy
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
from scprism_engine.contract import parse
from scprism_engine.gateway import Gateway, ModelCallResult
from scprism_engine.loop import run
from scprism_engine.mcp import MCPError, MCPTool
from scprism_engine.planner import plan
from scprism_engine.team import AgentSpec, run_team
from scprism_engine.telemetry import read_spans

_ECHO_FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "mcp_echo_server.py"
)


def _offline_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


def _cloud_gateway():
    # An EXPLICIT cloud primary + unreachable endpoint: gateway.route() returns a
    # CLOUD decision (is_local False) so the F1 tool-result egress guard engages,
    # while the network call itself is monkeypatched away (no real HTTP).
    return Gateway(
        openai_base_url="http://127.0.0.1:9",
        env={"SCPRISM_PRIMARY": "openai"},
        timeout=0.2,
    )


def _tool_call_block(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


class FakeMCPClient:
    """Duck-typed stand-in for the governed MCPClient (list_tools + call_tool)."""

    def __init__(self):
        self.calls = []

    def list_tools(self):
        return [
            MCPTool(
                name="lookup",
                description="Look up a fact.",
                input_schema={"type": "object"},
            )
        ]

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "fact: prisms refract light"}]}


class UnreachableMCPClient(FakeMCPClient):
    """A client whose server is gone — list_tools raises, call_tool must never run."""

    def list_tools(self):
        raise MCPError("server unreachable")


class SecretMCPClient(FakeMCPClient):
    """A tool whose RESULT carries a secret — the F1 egress-gate probe."""

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {
            "content": [{"type": "text", "text": "config aws_password=hunter2trapdoor"}]
        }


def _script_gateway_model_call(gateway):
    """Monkeypatch ``gateway.model_call`` on the instance: the FIRST call (from
    any dispatch thread) replies with a tool_call block; every later call —
    including the Tier-2 judge's — is a plain final answer. Returns the shared
    call counter."""
    lock = threading.Lock()
    state = {"n": 0}

    def model_call(messages, route):
        with lock:
            state["n"] += 1
            first = state["n"] == 1
        if first:
            text = _tool_call_block("lookup", {"q": "prisms"})
        else:
            text = "final answer: prisms refract light"
        return ModelCallResult(
            text=text,
            tokens_in=5,
            tokens_out=7,
            cache="miss",
            provider=route.provider,
            model=route.model,
            is_real=False,
        )

    gateway.model_call = model_call
    return state


def _model_call_spans(vault):
    """The dispatch/team ``model_call``-NAMED spans (the Tier-2 judge's own
    span is span_type model_call but named "eval" — excluded on purpose)."""
    spans = read_spans(os.path.join(vault, "spans.jsonl"))
    return [s for s in spans if s["type"] == "model_call" and s["name"] == "model_call"]


class TestRunWithMCPClient(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_dispatch_step_runs_the_tool_loop_and_spans_show_each_turn(self):
        gateway = _offline_gateway()
        _script_gateway_model_call(gateway)
        fake = FakeMCPClient()
        contract = parse("add a rate-limit guard", task_id="t-mcp-1")
        steps = len(plan(contract))

        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=gateway,
            mcp_client=fake,
        )

        # The run completed and verdicted as normal (tier1 real, tier2 ran).
        self.assertTrue(verdict.tier1["passed"])
        self.assertTrue(verdict.tier2["ran"])
        self.assertIsInstance(verdict.passed, bool)
        # The fake tool was executed exactly once, with the PARSED arguments.
        self.assertEqual(fake.calls, [("lookup", {"q": "prisms"})])
        # One span per model TURN: the tool-using step made 2 model calls
        # (tool request + final), every other step 1 -> steps + 1 total, so
        # the trace shows the real interleaving (>= 2 spans for that step).
        self.assertEqual(len(_model_call_spans(self.vault)), steps + 1)

    def test_unreachable_server_degrades_to_a_normal_run(self):
        # list_tools raising MCPError must not kill the run: no tools -> the
        # loop is single-shot and the span profile is the pre-v2b baseline.
        fake = UnreachableMCPClient()
        contract = parse("add a rate-limit guard", task_id="t-mcp-degrade")
        steps = len(plan(contract))

        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
            mcp_client=fake,
        )

        self.assertTrue(verdict.tier1["passed"])
        self.assertEqual(fake.calls, [])
        self.assertEqual(len(_model_call_spans(self.vault)), steps)

    def test_cloud_route_withholds_sensitive_tool_result_from_the_gateway(self):
        # F1: on a CLOUD route, a tool RESULT carrying a secret must be redacted
        # BEFORE it is fed back — the secret can never reach the next cloud POST.
        gateway = _cloud_gateway()
        seen = []
        lock = threading.Lock()
        state = {"n": 0}

        def model_call(messages, route):
            with lock:
                seen.append(copy.deepcopy(messages))
                state["n"] += 1
                first = state["n"] == 1
            text = (
                _tool_call_block("lookup", {"q": "prisms"})
                if first
                else "final answer"
            )
            return ModelCallResult(
                text=text, tokens_in=5, tokens_out=7, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway.model_call = model_call
        # Precondition: this really is a cloud route (else the guard would not run).
        self.assertFalse(gateway.route("Implement change: add a rate-limit guard").is_local)

        fake = SecretMCPClient()
        contract = parse("add a rate-limit guard", task_id="t-mcp-egress")
        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=gateway,
            mcp_client=fake,
        )
        self.assertEqual(fake.calls, [("lookup", {"q": "prisms"})])
        blob = json.dumps(seen)
        # The secret NEVER appears in any messages POSTed to the gateway...
        self.assertNotIn("hunter2trapdoor", blob)
        # ...and the model was told, honestly, that the content was withheld.
        self.assertIn("withheld", blob)

    def test_withheld_result_emits_a_governance_span(self):
        # M3: the F1 egress gate firing is a governance WIN the Manager View must
        # SEE. A `tool_exec` span with withheld=True (provider mcp) must land in
        # spans.jsonl so the UI can surface "result withheld from cloud". Reverts
        # (dropping _emit_withheld_spans) leave no such span -> this fails.
        gateway = _cloud_gateway()
        _script_gateway_model_call(gateway)
        fake = SecretMCPClient()
        contract = parse("add a rate-limit guard", task_id="t-mcp-withheld-span")
        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=gateway,
            mcp_client=fake,
        )
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        withheld = [
            s
            for s in spans
            if s["type"] == "tool_exec"
            and s["attrs"].get("provider") == "mcp"
            and s["attrs"].get("withheld") is True
        ]
        self.assertTrue(withheld, "a withheld=True tool_exec span must be recorded")
        self.assertEqual(withheld[0]["attrs"]["tool"], "lookup")
        # Parented under a real span (the dispatch phase), not dangling at null.
        self.assertIsNotNone(withheld[0]["parent_id"])

    def test_mcp_max_iters_is_threaded_not_hardcoded(self):
        # F10: a greedy model (always asks for a tool) + mcp_max_iters=2 must
        # produce EXACTLY 2 tool execs on the tool-using step and the honest
        # max-iters note — proving the param is threaded, not pinned to 1.
        gateway = _offline_gateway()

        def greedy(messages, route):
            # Always requests another tool — never a final answer.
            return ModelCallResult(
                text=_tool_call_block("lookup", {"q": "x"}),
                tokens_in=2, tokens_out=2, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway.model_call = greedy
        fake = FakeMCPClient()
        contract = parse("summarize the notes", task_id="t-mcp-iters")
        steps = len(plan(contract))
        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=gateway,
            mcp_client=fake,
            mcp_max_iters=2,
        )
        # Every dispatch step runs the loop; a greedy model caps at 2 execs per
        # step -> exactly 2 * steps tool executions (would be 1 * steps if the
        # cap were hardcoded to 1).
        self.assertEqual(len(fake.calls), 2 * steps)

    def test_no_mcp_client_keeps_the_pre_v2b_span_profile(self):
        # The byte-identical guarantee: without an mcp_client, the CURRENT
        # (pre-change) behavior holds — exactly ONE model_call span per
        # dispatch step, and no other span types appear.
        contract = parse("add a rate-limit guard", task_id="t-mcp-baseline")
        steps = len(plan(contract))

        run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
        )

        self.assertEqual(len(_model_call_spans(self.vault)), steps)
        types = {s["type"] for s in read_spans(os.path.join(self.vault, "spans.jsonl"))}
        self.assertEqual(
            types, {"run", "hook", "retrieval", "model_call", "tool_exec", "verdict"}
        )


class TestRunTeamWithMCPClient(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_agent_turn_uses_the_tool_then_synthesis_answers(self):
        fake = FakeMCPClient()
        state = {"n": 0}

        def scripted(messages, route):
            # run_team is serial: call 1 (lead's turn) requests the tool,
            # every later call (the fed-back turn + synthesis) answers.
            state["n"] += 1
            text = (
                _tool_call_block("lookup", {"q": "refraction"})
                if state["n"] == 1
                else "team answer: refraction covered"
            )
            return ModelCallResult(
                text=text,
                tokens_in=4,
                tokens_out=6,
                cache="miss",
                provider=route.provider,
                model=route.model,
                is_real=False,
            )

        result = run_team(
            "investigate refraction",
            self.vault,
            [AgentSpec("lead", "Lead and synthesize.", "local")],
            rounds=1,
            env={"PATH": "/nonexistent"},
            model=scripted,
            mcp_client=fake,
        )

        # The tool ran once (gated by the fake), the board carries the REAL
        # final text, and each model TURN got its own span: 2 for the lead's
        # tool-using contribution + 1 synthesis = 3.
        self.assertEqual(fake.calls, [("lookup", {"q": "refraction"})])
        self.assertEqual(result.board[0].content, "team answer: refraction covered")
        self.assertEqual(result.synthesis, "team answer: refraction covered")
        self.assertEqual(len(_model_call_spans(self.vault)), 3)

    def test_team_cloud_route_withholds_sensitive_tool_result(self):
        # F1 (team path): a cloud agent's tool RESULT carrying a secret is
        # redacted before it is fed back — never reaches the next cloud POST.
        fake = SecretMCPClient()
        seen = []
        state = {"n": 0}

        def scripted(messages, route):
            seen.append(copy.deepcopy(messages))
            state["n"] += 1
            text = (
                _tool_call_block("lookup", {"q": "x"})
                if state["n"] == 1
                else "team answer"
            )
            return ModelCallResult(
                text=text, tokens_in=4, tokens_out=6, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        result = run_team(
            "investigate refraction",
            self.vault,
            [AgentSpec("lead", "Lead and synthesize.", "openai")],  # cloud primary
            rounds=1,
            env={"PATH": "/nonexistent"},
            model=scripted,
            mcp_client=fake,
        )
        self.assertEqual(fake.calls, [("lookup", {"q": "x"})])
        blob = json.dumps(seen)
        self.assertNotIn("hunter2trapdoor", blob)
        self.assertIn("withheld", blob)
        self.assertEqual(result.synthesis, "team answer")


class TestCLIMCPServerFlag(unittest.TestCase):
    """--mcp-server with an unknown name: the same stderr JSON + exit 1
    contract as the `mcp` subcommand, before any model call happens."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue().strip(), err.getvalue().strip()

    def _seed_config(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump([{"name": "echo", "command": ["true"]}], fh)

    def test_run_with_unknown_server_exits_1_with_json_error(self):
        self._seed_config(os.path.join(self.vault, "mcp-servers.json"))
        code, out, err = self._run_cli(
            ["run", "do a thing", "--vault", self.vault, "--mcp-server", "nope"]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "", "no Verdict may be printed on a config error")
        obj = json.loads(err)
        self.assertFalse(obj["ok"])
        self.assertIn("'nope' not found", obj["error"])

    def test_team_with_unknown_server_exits_1_with_json_error(self):
        config = os.path.join(self.vault, "custom-mcp.json")
        self._seed_config(config)
        code, out, err = self._run_cli(
            [
                "team", "do a thing", "--vault", self.vault,
                "--mcp-server", "nope", "--mcp-config", config,
            ]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        obj = json.loads(err)
        self.assertFalse(obj["ok"])
        self.assertIn("'nope' not found", obj["error"])
        self.assertIn(config, obj["error"])


class TestCLIMCPServerRealFixture(unittest.TestCase):
    """--mcp-server pointing at the REAL stdlib echo fixture (F5): exercises
    ``_open_mcp_client`` (open + handshake), the shared-telemetry handoff, the
    (MCPError, OSError) degrade catch, a real ``tool_exec`` span in the SINGLE
    spans.jsonl, its parent (F4), and one run_id for team (F3). The offline stub
    never emits a tool_call block, so ``Gateway.model_call`` is class-patched to
    request the echo tool once."""

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

    def _seed_config(self, command):
        path = os.path.join(self.vault, "mcp-servers.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump([{"name": "echo", "command": command}], fh)

    def _patch_first_call_requests_echo(self):
        lock = threading.Lock()
        state = {"n": 0}

        def patched(self, messages, route):  # noqa: ANN001 (test double)
            with lock:
                state["n"] += 1
                first = state["n"] == 1
            text = (
                _tool_call_block("echo", {"text": "hi"})
                if first
                else "final answer: done"
            )
            return ModelCallResult(
                text=text, tokens_in=5, tokens_out=7, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway_mod.Gateway.model_call = patched

    def test_run_with_valid_echo_server_emits_a_parented_tool_exec_span(self):
        self._seed_config([sys.executable, _ECHO_FIXTURE])
        self._patch_first_call_requests_echo()
        code, out, err = self._run_cli(
            ["run", "echo a thing", "--vault", self.vault, "--mcp-server", "echo"]
        )
        self.assertEqual(code, 0)
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        # tier1/tier2 also use span_type tool_exec; select the MCP tool calls.
        tool_execs = [
            s for s in spans
            if s["type"] == "tool_exec" and s["attrs"].get("provider") == "mcp"
        ]
        self.assertTrue(tool_execs, "a real MCP tool_exec span must land in spans.jsonl")
        te = tool_execs[0]
        self.assertEqual(te["attrs"]["tool"], "echo")
        self.assertEqual(te["attrs"]["provider"], "mcp")
        # F4: the tool_exec span is PARENTED under the dispatch span (not null).
        self.assertIsNotNone(te["parent_id"])
        dispatch_ids = {
            s["span_id"] for s in spans if s["type"] == "hook" and s["name"] == "dispatch"
        }
        self.assertIn(te["parent_id"], dispatch_ids)
        # Shared telemetry: exactly ONE run_id across the whole file.
        self.assertEqual(len({s["run_id"] for s in spans}), 1)

    def test_run_with_failing_server_degrades_tool_less(self):
        # A server that fails the handshake (exits immediately) -> _open_mcp_client
        # catches (MCPError, OSError), reports on stderr, and the run proceeds
        # tool-less (no crash) — the degrade path.
        self._seed_config([sys.executable, "-c", "import sys; sys.exit(0)"])
        self._patch_first_call_requests_echo()
        code, out, err = self._run_cli(
            ["run", "echo a thing", "--vault", self.vault, "--mcp-server", "echo"]
        )
        self.assertEqual(code, 0)
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertEqual(
            [s for s in spans
             if s["type"] == "tool_exec" and s["attrs"].get("provider") == "mcp"],
            [],
        )
        self.assertIn("ok", json.loads(err.splitlines()[0]))  # degrade JSON on stderr

    def test_team_with_valid_echo_server_shares_one_run_id(self):
        # F3: team + mcp shares ONE Telemetry -> a single run_id (no phantom
        # run) AND a real tool_exec span, nested under the run span (F4).
        self._seed_config([sys.executable, _ECHO_FIXTURE])
        self._patch_first_call_requests_echo()
        code, out, err = self._run_cli(
            [
                "team", "echo a thing", "--vault", self.vault,
                "--agents", "lead:local", "--mcp-server", "echo",
            ]
        )
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        tool_execs = [
            s for s in spans
            if s["type"] == "tool_exec" and s["attrs"].get("provider") == "mcp"
        ]
        self.assertTrue(tool_execs, "a real MCP tool_exec span must land in spans.jsonl")
        # ONE run_id across the team's spans AND the client's tool_exec spans:
        # the phantom-run bug produced two distinct run_ids here.
        self.assertEqual(len({s["run_id"] for s in spans}), 1)
        # F4: the tool_exec span nests under a real parent, not parent=null.
        self.assertIsNotNone(tool_execs[0]["parent_id"])
        run_ids = {s["span_id"] for s in spans if s["type"] == "run"}
        self.assertIn(tool_execs[0]["parent_id"], run_ids)


if __name__ == "__main__":
    unittest.main()
