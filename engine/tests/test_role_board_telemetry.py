"""Per-agent telemetry in the role board (MV1 — Manager View data foundation).

`run_role_board` runs SILENTLY today: as the injected per-step doer it emits no
per-agent spans mid-run. MV1 threads OPTIONAL telemetry through it so it emits
ONE ``model_call`` span per agent turn + one for the lead synthesis — exactly
like the standalone `run_team` already does (team.py `_call_model`) — so the
Console/Manager View can show which model did what, live.

The invariant these tests pin: WITH telemetry offered, the board emits per-agent
spans (agent · model · route · tokens · pass/fail), parented to the caller's
span; WITHOUT it (``telemetry=None`` — every pre-MV1 caller) the board is
byte-identical: ZERO spans, identical `RoleBoardResult`, unchanged Verdict.

Offline throughout — `team.Gateway` is patched to a deterministic double so
routing identity is honest (from ``SCPRISM_PRIMARY``) while the network call is
a stub, mirroring `test_role_board.py`.
"""

import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import team as team_module
from scprism_engine.contract import parse
from scprism_engine.dispatcher import ModelResult
from scprism_engine.gateway import Gateway
from scprism_engine.loop import run as loop_run
from scprism_engine.team import (
    AgentSpec,
    run_role_board,
    team_model_adapter,
)
from scprism_engine.telemetry import Telemetry, read_spans


class _FakeRoute:
    def __init__(self, provider, model):
        self.provider = provider
        self.model = model
        self.target = "local" if provider == "local" else "cloud"
        self.is_local = provider == "local"
        self.reason = "fake"


class _FakeResult:
    def __init__(self, text, tokens, is_real=True):
        self.text = text
        self.tokens = tokens
        self.is_real = is_real
        self.tokens_in = tokens // 2
        self.tokens_out = tokens - tokens // 2
        self.cache = "miss"


def make_fake_gateway(tokens_per_call=10):
    """A `team.Gateway` double whose provider identity comes from
    ``SCPRISM_PRIMARY`` (honest per-agent routing) and whose model call is a
    deterministic stub. Mirrors `test_role_board.make_fake_gateway`."""

    class _FakeGateway:
        def __init__(self, *, env=None, **_kw):
            e = env or {}
            self.provider = e.get("SCPRISM_PRIMARY", "local")
            self.model = f"{self.provider}-model"

        def route(self, _prompt):
            return _FakeRoute(self.provider, self.model)

        def model_call(self, messages, route):
            return _FakeResult(
                f"[{route.provider}] board contribution over the shared board.",
                tokens_per_call,
                is_real=True,
            )

    return _FakeGateway


def _agents():
    return [
        AgentSpec("lead", "Lead and synthesize.", "openai"),
        AgentSpec("planner", "Plan.", "gemini"),
        AgentSpec("developer", "Implement.", "local"),
    ]


# The exact per-span attributes `run_team` sets (team.py ~357-378) — the client
# reads both paths uniformly, so the role board must carry the same shape.
_REQUIRED_ATTRS = (
    "provider",
    "model",
    "route",
    "is_local",
    "reason",
    "agent",
    "round",
    "tokens_in",
    "tokens_out",
    "cache",
    "is_real",
)


class RunRoleBoardTelemetryTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.env = {"PATH": "/nonexistent", "SCPRISM_VAULT": self.vault}

    def tearDown(self):
        self._tmp.cleanup()

    def test_with_telemetry_emits_span_per_agent_turn_and_synthesis(self):
        spans_path = os.path.join(self.vault, "spans.jsonl")
        telem = Telemetry(spans_path)
        parent_id = "dispatch-span-under-test"

        with mock.patch.object(team_module, "Gateway", make_fake_gateway()):
            result = run_role_board(
                "draft a launch plan",
                "cloud",
                _agents(),
                env=self.env,
                telemetry=telem,
                parent_span_id=parent_id,
            )

        spans = read_spans(spans_path)
        model_calls = [s for s in spans if s["type"] == "model_call"]
        # 3 agents * 1 round + 1 lead synthesis = 4 per-agent model_call spans.
        self.assertEqual(len(model_calls), 4)

        for s in model_calls:
            self.assertEqual(s["name"], "model_call")
            self.assertEqual(s["parent_id"], parent_id, "parented to the caller's span")
            attrs = s["attrs"]
            for key in _REQUIRED_ATTRS:
                self.assertIn(key, attrs, f"span missing attr {key!r}")

        # The three board turns (round 1) + one synthesis turn (round 'synthesis').
        by_round = {}
        for s in model_calls:
            by_round.setdefault(s["attrs"]["round"], []).append(s)
        self.assertEqual(len(by_round.get(1, [])), 3, "one span per agent turn")
        self.assertEqual(len(by_round.get("synthesis", [])), 1, "one synthesis span")

        # Agents named honestly, models/route carried through per agent.
        turn_agents = {s["attrs"]["agent"] for s in by_round[1]}
        self.assertEqual(turn_agents, {"lead", "planner", "developer"})
        self.assertEqual(by_round["synthesis"][0]["attrs"]["agent"], "lead")

        # tokens + pass/fail actually recorded (not just declared).
        developer_span = next(s for s in by_round[1] if s["attrs"]["agent"] == "developer")
        self.assertEqual(developer_span["attrs"]["provider"], "local")
        self.assertEqual(developer_span["attrs"]["model"], "local-model")
        self.assertEqual(developer_span["attrs"]["route"], "local")
        self.assertTrue(developer_span["attrs"]["is_local"])
        self.assertTrue(developer_span["attrs"]["is_real"])
        self.assertEqual(
            developer_span["attrs"]["tokens_in"] + developer_span["attrs"]["tokens_out"],
            10,
        )

    def test_telemetry_none_emits_zero_spans_and_identical_result(self):
        # WITH telemetry (baseline shape) ...
        vault_tel = os.path.join(self.vault, "tel")
        os.makedirs(os.path.join(vault_tel, "agents"), exist_ok=True)
        env_tel = {"PATH": "/nonexistent", "SCPRISM_VAULT": vault_tel}
        telem = Telemetry(os.path.join(vault_tel, "spans.jsonl"))
        with mock.patch.object(team_module, "Gateway", make_fake_gateway()):
            res_tel = run_role_board(
                "draft a launch plan",
                "cloud",
                _agents(),
                env=env_tel,
                telemetry=telem,
                parent_span_id="p",
            )

        # ... vs WITHOUT telemetry (the default; every pre-MV1 caller).
        vault_none = os.path.join(self.vault, "none")
        os.makedirs(os.path.join(vault_none, "agents"), exist_ok=True)
        env_none = {"PATH": "/nonexistent", "SCPRISM_VAULT": vault_none}
        with mock.patch.object(team_module, "Gateway", make_fake_gateway()):
            res_none = run_role_board(
                "draft a launch plan", "cloud", _agents(), env=env_none
            )

        # Byte-identical RoleBoardResult on every meaningful field (board_path is
        # a per-run uuid path, deliberately excluded).
        self.assertEqual(res_none.completion, res_tel.completion)
        self.assertEqual(res_none.tokens, res_tel.tokens)
        self.assertEqual(res_none.models_used, res_tel.models_used)
        self.assertEqual(res_none.disclosed, res_tel.disclosed)

        # telemetry=None ⇒ the board created no Telemetry and wrote NO spans.
        self.assertFalse(os.path.exists(os.path.join(vault_none, "spans.jsonl")))


class LoopRoleBoardDoerSpansTest(unittest.TestCase):
    """The full seam: `loop.run` offers telemetry to a `_RoleBoardDoer` roster so
    the board's per-agent spans land in the step's trace — while the completion
    and Verdict stay byte-identical to a board that ran blind."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.env = {"PATH": "/nonexistent"}

    def tearDown(self):
        self._tmp.cleanup()

    @staticmethod
    def _offline_gateway():
        return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)

    @staticmethod
    def _board_spans(spans_path):
        spans = read_spans(spans_path)
        return [
            s
            for s in spans
            if s["type"] == "model_call"
            and s["name"] == "model_call"
            and "agent" in s.get("attrs", {})
        ]

    def test_loop_run_with_roleboard_doer_emits_board_spans_and_unchanged_verdict(self):
        # --- (a) telemetry-aware doer via team_model_adapter (a _RoleBoardDoer) ---
        vault_tel = os.path.join(self.root, "tel")
        os.makedirs(vault_tel, exist_ok=True)
        contract_tel = parse("draft a launch plan", task_id="t-board-tel")
        with mock.patch.object(team_module, "Gateway", make_fake_gateway()):
            doer = team_model_adapter(_agents(), env=self.env)
            self.assertTrue(
                hasattr(doer, "set_telemetry"),
                "the adapter must return a telemetry-aware doer",
            )
            verdict_tel = loop_run(
                contract_tel,
                vault=vault_tel,
                tier1_commands=["true"],
                gateway=self._offline_gateway(),
                model=doer,
            )

        spans_path_tel = os.path.join(vault_tel, "spans.jsonl")
        board_spans = self._board_spans(spans_path_tel)
        dispatch_spans = [
            s for s in read_spans(spans_path_tel) if s["name"] == "dispatch"
        ]
        self.assertEqual(len(dispatch_spans), 1)
        n_steps = dispatch_spans[0]["attrs"]["steps"]
        self.assertGreaterEqual(n_steps, 1)
        # (agents + synthesis) per dispatched step, all parented to the dispatch span.
        self.assertEqual(len(board_spans), (len(_agents()) + 1) * n_steps)
        disp_id = dispatch_spans[0]["span_id"]
        self.assertTrue(all(s["parent_id"] == disp_id for s in board_spans))

        # --- (b) a plain closure doer (NO set_telemetry) runs blind ---
        # The Gateway is patched ONCE around the whole loop_run (main thread):
        # `dispatch` fans reads out across worker threads, so patching inside the
        # doer would race on the process-global module attr. This board runs the
        # SAME fake, so its completion/Verdict must match the telemetry run.
        vault_plain = os.path.join(self.root, "plain")
        os.makedirs(vault_plain, exist_ok=True)

        def plain_doer(prompt, route):
            r = run_role_board(prompt, route, _agents(), env=self.env)
            return ModelResult(
                text=r.completion,
                tokens=r.tokens,
                route=route,
                models_used=r.models_used,
                disclosed=r.disclosed or None,
            )

        self.assertFalse(hasattr(plain_doer, "set_telemetry"))
        contract_plain = parse("draft a launch plan", task_id="t-board-plain")
        with mock.patch.object(team_module, "Gateway", make_fake_gateway()):
            verdict_plain = loop_run(
                contract_plain,
                vault=vault_plain,
                tier1_commands=["true"],
                gateway=self._offline_gateway(),
                model=plain_doer,
            )
        # A doer without the hook is untouched: ZERO board spans in its trace.
        self.assertEqual(len(self._board_spans(os.path.join(vault_plain, "spans.jsonl"))), 0)

        # --- The completion path is byte-identical; only spans were added. ---
        self.assertEqual(verdict_tel.passed, verdict_plain.passed)
        self.assertEqual(verdict_tel.tokens_spent, verdict_plain.tokens_spent)
        self.assertEqual(verdict_tel.models_used, verdict_plain.models_used)
        self.assertEqual(verdict_tel.response, verdict_plain.response)
        # The board's distinct models rode out onto the step Verdict either way.
        self.assertEqual(
            set(verdict_tel.models_used),
            {"openai · openai-model", "gemini · gemini-model", "local · local-model"},
        )


if __name__ == "__main__":
    unittest.main()
