"""Role board (P1-1) — the reusable per-step "doer" extracted from `run_team`.

`run_role_board` runs the SAME serial board loop `run_team` runs (each agent on
its own Gateway via ``SCPRISM_PRIMARY=spec.primary``, the lead synthesizes at
the end) but returns ONE completion STRING that carries ``===FILE:===`` blocks
so a later project step can write files from it — no governance/verdict, no
200-word prose cap. `team_model_adapter` wraps it as a `dispatcher.ModelCall`.

These tests fake the Gateway (patching ``team.Gateway``) so routing identity is
honest (from ``SCPRISM_PRIMARY``) while the network call is a deterministic
double, mirroring `test_team_governance.make_fake_model` and `test_team`'s
offline pattern. A tempdir stands in for the board directory.
"""

import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import team as team_module
from scprism_engine.dispatcher import ModelResult
from scprism_engine.team import AgentSpec, RoleBoardResult, run_role_board, team_model_adapter


# A distinctive marker so the fake lead can tell it received the injected
# FILE-block instructions on its synthesis prompt (and only then emit a block).
FILE_INSTR = "FORMAT: emit ===FILE: path=== ... ===END=== blocks."


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
    """A `team.Gateway` replacement whose provider identity comes from
    ``SCPRISM_PRIMARY`` (so per-agent routing stays honest) and whose lead
    synthesis emits a REAL FILE block whenever its prompt carries the injected
    FILE-block instructions. Every call is recorded on the class-level ``calls``
    list so tests can assert prompt content + call count."""
    calls = []

    class _FakeGateway:
        calls_log = calls

        def __init__(self, *, env=None, **_kw):
            e = env or {}
            self.provider = e.get("SCPRISM_PRIMARY", "local")
            self.model = f"{self.provider}-model"

        def route(self, _prompt):
            return _FakeRoute(self.provider, self.model)

        def model_call(self, messages, route):
            user = "\n".join(
                str(m.get("content", "")) for m in messages if m.get("role") == "user"
            )
            calls.append({"provider": route.provider, "user": user})
            if FILE_INSTR in user:
                text = (
                    "Here is the finished work product.\n"
                    "===FILE: app/main.py===\n"
                    "print('hello from the board')\n"
                    "===END===\n"
                )
            else:
                text = f"[{route.provider}] board contribution over the shared board."
            return _FakeResult(text, tokens_per_call, is_real=True)

    return _FakeGateway


def _agents():
    return [
        AgentSpec("lead", "Lead and synthesize.", "openai"),
        AgentSpec("planner", "Plan.", "gemini"),
        AgentSpec("developer", "Implement.", "local"),
    ]


class RunRoleBoardTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.env = {"PATH": "/nonexistent", "SCPRISM_VAULT": self.vault}

    def tearDown(self):
        self._tmp.cleanup()

    def test_board_returns_a_completion(self):
        Fake = make_fake_gateway()
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board("draft a launch plan", "cloud", _agents(), env=self.env)
        self.assertIsInstance(result, RoleBoardResult)
        self.assertTrue(result.completion, "the board must yield a non-empty completion")
        self.assertGreater(result.tokens, 0)
        # The board is persisted (audit trail) and the path exists.
        self.assertTrue(result.board_path)
        self.assertTrue(os.path.isfile(result.board_path))

    def test_lead_synthesis_injects_file_block_instructions_and_emits_a_block(self):
        Fake = make_fake_gateway()
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board(
                "build a tiny app",
                "cloud",
                _agents(),
                env=self.env,
                file_block_instructions=FILE_INSTR,
            )
        # The injected instructions reached the LEAD synthesis prompt (the only
        # call whose user message carries FILE_INSTR).
        synth_calls = [c for c in Fake.calls_log if FILE_INSTR in c["user"]]
        self.assertEqual(len(synth_calls), 1, "exactly the lead synthesis is instructed")
        self.assertEqual(synth_calls[0]["provider"], "openai")  # the lead's provider
        # The agent-round prompts must NOT carry the FILE-block instructions.
        agent_calls = [c for c in Fake.calls_log if FILE_INSTR not in c["user"]]
        self.assertEqual(len(agent_calls), 3)
        # ...and the completion carries a real FILE block the fake lead emitted.
        self.assertIn("===FILE: app/main.py===", result.completion)
        self.assertIn("===END===", result.completion)

    def test_models_used_lists_each_agents_model(self):
        Fake = make_fake_gateway()
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board("plan the work", "cloud", _agents(), env=self.env)
        # distinct provider · model per agent that spoke + the lead.
        self.assertEqual(
            result.models_used,
            ["openai · openai-model", "gemini · gemini-model", "local · local-model"],
        )

    def test_budget_breach_stops_before_next_call_but_still_returns_completion(self):
        # tokens_per_call=10; budget=15 -> agent1 (0<15) speaks -> 10; agent2
        # (10<15) speaks -> 20; agent3 (20>=15) is SKIPPED. The lead still
        # synthesizes over the partial board, so a completion is returned and
        # nothing raises.
        Fake = make_fake_gateway(tokens_per_call=10)
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board(
                "plan the work", "cloud", _agents(), env=self.env, token_budget=15
            )
        # 2 agent contributions + 1 synthesis = 3 calls (NOT the 4 a full run makes).
        self.assertEqual(len(Fake.calls_log), 3)
        self.assertTrue(result.completion, "a partial-board synthesis still returns a completion")

    def test_team_model_adapter_returns_a_modelresult(self):
        Fake = make_fake_gateway()
        adapter = team_model_adapter(_agents(), env=self.env)
        with mock.patch.object(team_module, "Gateway", Fake):
            mr = adapter("draft a launch plan", "cloud")
        self.assertIsInstance(mr, ModelResult)
        self.assertTrue(mr.text)
        self.assertEqual(mr.route, "cloud")
        self.assertGreater(mr.tokens, 0)

    def test_adapter_forwards_file_block_instructions(self):
        Fake = make_fake_gateway()
        adapter = team_model_adapter(_agents(), env=self.env, file_block_instructions=FILE_INSTR)
        with mock.patch.object(team_module, "Gateway", Fake):
            mr = adapter("build a tiny app", "cloud")
        # The adapter's completion carries the FILE block (instructions flowed
        # through run_role_board's lead synthesis).
        self.assertIn("===FILE: app/main.py===", mr.text)


if __name__ == "__main__":
    unittest.main()
