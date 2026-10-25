"""Integration: memory + context routing wired into the Orchestrator loop."""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.memory import MemoryStore, RuleSet, RuleFact, VaultWrite
from scprism_engine.context import CatalogEntry
from scprism_engine.telemetry import read_spans


class TestLoopWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _verdict_json(self, task_id):
        with open(os.path.join(self.vault, "verdicts", f"{task_id}.json")) as fh:
            return json.load(fh)

    def test_rejected_vault_write_fails_closed_and_is_recorded(self):
        rules = RuleSet([RuleFact("max_retries", "3", "policies/retry.md")])
        bad = VaultWrite(
            path="policies/new-retry.md",
            content="---\ntype: policy\nmax_retries: 9\n---\ncontradiction\n",
        )
        contract = parse("add a retry policy", task_id="t-reject")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            vault_writes=[bad],
            vault_rules=rules,
        )
        self.assertFalse(verdict.passed, "a rejected write fails the task closed")
        self.assertEqual(len(verdict.rejected_writes), 1)
        self.assertIn("max_retries", verdict.rejected_writes[0]["reason"])
        # Nothing was persisted to L3.
        self.assertFalse(os.path.exists(os.path.join(self.vault, "policies", "new-retry.md")))

    def test_valid_vault_write_persists_through_gate(self):
        good = VaultWrite(
            path="policies/budget.md",
            content="---\ntype: policy\nmax_tokens: 5000\n---\nok\n",
        )
        contract = parse("add a token budget policy", task_id="t-accept")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            vault_writes=[good],
        )
        self.assertEqual(verdict.rejected_writes, [])
        self.assertTrue(os.path.exists(os.path.join(self.vault, "policies", "budget.md")))
        self.assertTrue(verdict.passed)

    def test_memory_injected_under_budget_and_recorded(self):
        store = MemoryStore(
            profile={"name": "Sukhdeep", "role": "founder", "domain": "governance"},
        )
        store.working("t-mem").put("focus", "retry policy work")
        contract = parse("review the retry policy", task_id="t-mem")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            memory=store,
            session_id="t-mem",
            memory_budget=50,
        )
        self.assertTrue(len(verdict.memory_injected) > 0)
        total = sum(m["tokens"] for m in verdict.memory_injected)
        self.assertLessEqual(total, 50)

    def test_progressive_disclosure_injects_only_matching_skills(self):
        # S2: disclosure is real now — a matching skill's instructions are
        # injected and Verdict.disclosed honestly lists the INJECTED skills
        # (only the one whose trigger matched, never the non-matching one).
        catalog = [
            CatalogEntry(name="retry-policy", triggers=["retry"], instructions="R" * 400),
            CatalogEntry(name="auth-policy", triggers=["auth"], instructions="A" * 400),
        ]
        contract = parse("add a retry guard", task_id="t-disc")
        verdict = run(
            contract, vault=self.vault, tier1_commands=["true"], skill_catalog=catalog
        )
        self.assertEqual(verdict.disclosed, ["retry-policy"])

    def test_memory_span_emitted(self):
        contract = parse("do a thing", task_id="t-span")
        run(contract, vault=self.vault, tier1_commands=["true"])
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        mem = [s for s in spans if s["name"] == "memory"]
        self.assertEqual(len(mem), 1)
        self.assertIn("budget", mem[0]["attrs"])
        self.assertIn("query", mem[0]["attrs"])

    def test_two_concurrent_runs_isolated_working_memory(self):
        store = MemoryStore()
        store.working("run-a").put("policy", "A-only")
        store.working("run-b").put("policy", "B-only")
        # A run keyed to run-a can never surface run-b's working item.
        contract = parse("review policy", task_id="run-a")
        verdict = run(
            contract, vault=self.vault, tier1_commands=["true"],
            memory=store, session_id="run-a", memory_budget=500,
        )
        blob = json.dumps(verdict.memory_injected)
        self.assertIn("run-a", blob)
        self.assertNotIn("run-b", blob)


if __name__ == "__main__":
    unittest.main()
