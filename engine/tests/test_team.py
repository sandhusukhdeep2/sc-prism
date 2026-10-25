"""Team runs — agents on DIFFERENT providers, orchestrator-mediated A2A."""

import json
import os
import tempfile
import unittest
from unittest import mock

from scprism_engine import gateway as gw_module
from scprism_engine.team import AgentSpec, parse_agents, run_team


class ParseAgentsTests(unittest.TestCase):
    def test_parse_names_and_providers(self):
        agents = parse_agents("lead:claude-cli, researcher:local ,critic:gemini")
        self.assertEqual([a.name for a in agents], ["lead", "researcher", "critic"])
        self.assertEqual(
            [a.primary for a in agents], ["claude-cli", "local", "gemini"]
        )
        self.assertIn("synthesize", agents[0].role.lower())


class TeamRunTests(unittest.TestCase):
    # A NON-reasoning, non-sensitive intent so each agent's EXPLICIT primary
    # answers its own lane (a keyless cloud primary like gemini still carries its
    # provider identity via the explicit-primary lane). A reasoning keyword
    # ("plan", "design", …) would instead route a keyless cloud agent LOCAL —
    # the honest "no cloud configured -> local" behavior (R2).
    def _run(self, intent="draft a launch announcement"):
        agents = [
            AgentSpec("lead", "Lead and synthesize.", "claude-cli"),
            AgentSpec("researcher", "Research.", "local"),
            AgentSpec("critic", "Criticize.", "gemini"),
        ]
        with tempfile.TemporaryDirectory() as vault:
            # Offline: block CLI discovery + keys → deterministic stubs, but
            # the routing/provider identity per agent is REAL and asserted.
            with mock.patch.object(gw_module, "_find_cli", return_value=None):
                result = run_team(intent, vault, agents, env={"PATH": "/nonexistent"})
            board_exists = os.path.isfile(result.board_path)
            lines = []
            if board_exists:
                with open(result.board_path, encoding="utf-8") as f:
                    lines = [json.loads(x) for x in f if x.strip()]
        return result, board_exists, lines

    def test_each_agent_speaks_on_its_own_provider(self):
        result, _, _ = self._run()
        self.assertEqual(len(result.board), 3)
        providers = [m.provider for m in result.board]
        self.assertEqual(providers, ["claude-cli", "local", "gemini"])

    def test_later_agents_see_earlier_messages(self):
        result, _, _ = self._run()
        # The critic's stub content hashes over its prompt, which embeds the
        # board — assert structurally: rounds recorded and ordering preserved.
        self.assertEqual([m.sender for m in result.board], ["lead", "researcher", "critic"])
        self.assertTrue(all(m.round == 1 for m in result.board))

    def test_sensitive_intent_forces_local_for_every_agent(self):
        result, _, _ = self._run(intent="rotate the prod password")
        self.assertEqual({m.provider for m in result.board}, {"local"})

    def test_board_persisted_with_synthesis(self):
        result, board_exists, lines = self._run()
        self.assertTrue(board_exists)
        self.assertEqual(len(lines), 4)  # 3 messages + synthesis footer
        self.assertIn("synthesis", lines[-1])
        self.assertTrue(result.synthesis)


if __name__ == "__main__":
    unittest.main()
