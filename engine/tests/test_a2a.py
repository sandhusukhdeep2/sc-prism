"""A2A serialisation seam (specs/11 §7, ADR-015).

Acceptance: handoff artifacts validate against the A2A schema — the Verdict
serialises as an Artifact, agents as Agent Cards, contracts as Tasks, board
entries as Messages — and a team run persists a portable A2A bundle.
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.a2a import (
    agent_card,
    artifact_from_verdict,
    message_from_board,
    task_from_contract,
    team_bundle,
    validate,
)
from scprism_engine.contract import parse
from scprism_engine.verifier import Tier1Result, Tier2Result
from scprism_engine.writeback import build_verdict
import scprism_engine.gateway as gw_module
import scprism_engine.team as team


def _contract():
    return parse(
        "summarize the vault",
        task_id="t-1",
        acceptance_criteria=["a summary exists"],
        scope=["notes/"],
    )


class TestA2ASerialisers(unittest.TestCase):
    def test_agent_card_validates(self):
        card = agent_card("lead", "synthesizes the answer", "claude-cli")
        self.assertEqual(validate("agent_card", card), [])
        self.assertEqual(card["protocolVersion"], "1.0")
        self.assertEqual(card["metadata"]["provider"], "claude-cli")

    def test_task_from_contract_validates(self):
        task = task_from_contract(_contract())
        self.assertEqual(validate("task", task), [])
        self.assertEqual(task["id"], "t-1")
        self.assertEqual(task["metadata"]["intent"], "summarize the vault")
        self.assertEqual(task["status"]["state"], "submitted")

    def test_message_from_board_entry_validates(self):
        entry = {
            "from": "critic",
            "provider": "gemini",
            "model": "gemini-2.5-flash",
            "content": "I disagree with step 2",
            "is_real": True,
            "round": 1,
        }
        msg = message_from_board(entry, "t-1")
        self.assertEqual(validate("message", msg), [])
        self.assertEqual(msg["parts"][0], {"kind": "text", "text": "I disagree with step 2"})
        self.assertEqual(msg["metadata"]["sender"], "critic")

    def test_verdict_serialises_as_artifact(self):
        verdict = build_verdict(
            task_id="t-1",
            tier1_result=Tier1Result(passed=True),
            tier2_result=Tier2Result(ran=True, score=0.9, passed=True),
            tokens_spent=123,
        )
        art = artifact_from_verdict(verdict)
        self.assertEqual(validate("artifact", art), [])
        self.assertEqual(art["parts"][0]["kind"], "data")
        self.assertEqual(art["parts"][0]["data"]["task_id"], "t-1")

    def test_validate_reports_problems(self):
        self.assertIn("task.id missing", validate("task", {"contextId": "x", "status": {}, "metadata": {}}))
        self.assertTrue(validate("message", {"role": "boss", "messageId": "m", "taskId": "t", "parts": []}))
        self.assertEqual(validate("unknown-kind", {}), ["unknown A2A kind: unknown-kind"])


class TestTeamPersistsA2ABundle(unittest.TestCase):
    def test_team_run_writes_valid_a2a_document(self):
        specs = team.parse_agents("lead:local,critic:gemini")
        with tempfile.TemporaryDirectory() as vault, \
                mock.patch.object(gw_module, "_find_cli", return_value=None):
            result = team.run_team(
                "plan the sprint", vault, specs, rounds=1, env={}
            )
            a2a_path = result.board_path.replace(".jsonl", ".a2a.json")
            self.assertTrue(os.path.exists(a2a_path))
            with open(a2a_path, encoding="utf-8") as f:
                doc = json.load(f)
        self.assertEqual(doc["protocolVersion"], "1.0")
        for card in doc["agents"]:
            self.assertEqual(validate("agent_card", card), [])
        self.assertEqual(validate("task", doc["task"]), [])
        for msg in doc["messages"]:
            self.assertEqual(validate("message", msg), [])
        for art in doc["artifacts"]:
            self.assertEqual(validate("artifact", art), [])
        self.assertEqual(len(doc["messages"]), len(result.board))

    def test_bundle_shape_from_result(self):
        specs = team.parse_agents("lead:local")
        fake_result = {
            "run_id": "r1",
            "board": [{"from": "lead", "provider": "local", "model": "m", "content": "hi", "is_real": False, "round": 1}],
            "synthesis": "done",
        }
        doc = team_bundle(fake_result, specs, "an intent")
        self.assertEqual(doc["task"]["metadata"]["intent"], "an intent")
        self.assertEqual(doc["artifacts"][0]["parts"][0]["text"], "done")


if __name__ == "__main__":
    unittest.main()
