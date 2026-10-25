"""Evidence & Control layer tests (specs/05 §3).

Proves the audit spine's guarantees: append-only + hash-chain tamper-evidence,
end-to-end reconstruction of a decision, and a date-range compliance export.
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine.evidence import EvidenceStore, GENESIS_HASH


def _offline_gateway():
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestEvidenceStore(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.store = EvidenceStore(self.vault)

    def tearDown(self):
        self._tmp.cleanup()

    def _append(self, task_id, tokens=100, passed=True, timestamp=None):
        return self.store.append(
            task_id=task_id,
            who={"agent_id": "orchestrator", "role": "implementer",
                 "requester_role": "cto"},
            what={"action": "orchestrated_task", "diff": {"writes": ["a.py"]}},
            why="do the thing",
            verdict={"passed": passed, "tier1": {"passed": True},
                     "tier2": {"eval_score": 0.9}},
            tokens_spent=tokens,
            model_route=["local"],
            hooks_fired=["plan", "stop"],
            passed=passed,
            timestamp=timestamp,
        )

    def test_append_only_file_grows_and_first_links_to_genesis(self):
        self._append("t1")
        self._append("t2")
        recs = self.store.records()
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[0].seq, 0)
        self.assertEqual(recs[0].prev_hash, GENESIS_HASH)
        # append-only: each record links to its predecessor's hash.
        self.assertEqual(recs[1].prev_hash, recs[0].record_hash)

    def test_chain_intact_on_clean_store(self):
        for i in range(5):
            self._append(f"t{i}")
        report = self.store.verify_chain()
        self.assertTrue(report.ok, report.reason)
        self.assertEqual(report.length, 5)

    def test_mutating_a_record_fails_verify_chain(self):
        self._append("t1")
        self._append("t2")
        self._append("t3")
        self.assertTrue(self.store.verify_chain().ok)

        # Tamper with the middle record's tokens field on disk.
        path = self.store.path
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        rec = json.loads(lines[1])
        rec["tokens_spent"] = 999_999
        lines[1] = json.dumps(rec)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

        report = self.store.verify_chain()
        self.assertFalse(report.ok, "mutation must break the chain")
        self.assertEqual(report.broken_at, 1)
        self.assertIn("tampered", report.reason)

    def test_deleting_a_record_breaks_the_chain(self):
        self._append("t1")
        self._append("t2")
        self._append("t3")
        path = self.store.path
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        del lines[1]  # drop the middle record
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        report = self.store.verify_chain()
        self.assertFalse(report.ok, "a deletion must be detectable")

    def test_reconstruct_from_appended_records(self):
        self._append("task-x", tokens=42)
        rc = self.store.reconstruct("task-x")
        self.assertEqual(rc["task_id"], "task-x")
        self.assertEqual(rc["who"]["requester_role"], "cto")
        self.assertEqual(rc["why"], "do the thing")
        self.assertEqual(rc["tokens_spent"], 42)
        self.assertTrue(rc["chain_ok"])

    def test_export_date_range_selects_right_records(self):
        self._append("early", timestamp="2026-01-01T00:00:00+00:00")
        self._append("mid", timestamp="2026-06-15T00:00:00+00:00")
        self._append("late", timestamp="2026-12-31T00:00:00+00:00")

        exp = self.store.export(
            start="2026-05-01T00:00:00+00:00",
            end="2026-09-01T00:00:00+00:00",
        )
        self.assertEqual(exp["count"], 1)
        self.assertEqual(exp["task_ids"], ["mid"])
        self.assertTrue(exp["chain_verified"])

        # Open-ended lower bound.
        exp2 = self.store.export(end="2026-06-16T00:00:00+00:00")
        self.assertEqual(sorted(exp2["task_ids"]), ["early", "mid"])

        # Whole range.
        exp3 = self.store.export()
        self.assertEqual(exp3["count"], 3)


class TestEvidenceWiredIntoLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_loop_appends_a_verdict_to_the_evidence_spine(self):
        c = parse("add a guard", task_id="wired-1", scope=["engine/**"])
        v = run(c, vault=self.vault, tier1_commands=["true"],
                gateway=_offline_gateway(), requester_role="founder")
        store = EvidenceStore(self.vault)
        recs = store.for_task("wired-1")
        self.assertEqual(len(recs), 1, "the run must leave exactly one evidence record")
        rec = recs[0]
        # who / what / why / verdict all derive from the real Verdict.
        self.assertEqual(rec.who["requester_role"], "founder")
        self.assertEqual(rec.why, c.intent)
        self.assertEqual(rec.passed, v.passed)
        self.assertEqual(rec.tokens_spent, v.tokens_spent)
        self.assertTrue(store.verify_chain().ok)

    def test_reconstruct_replays_the_decision_with_the_span_trajectory(self):
        c = parse("add a guard", task_id="wired-2", scope=["engine/**"])
        run(c, vault=self.vault, tier1_commands=["true"],
            gateway=_offline_gateway())
        store = EvidenceStore(self.vault)
        rc = store.reconstruct("wired-2")
        # The decision is reconstructable end-to-end: verdict + the ordered
        # span trajectory (the spec's test of sufficient instrumentation).
        self.assertTrue(rc["chain_ok"])
        self.assertIn("verdict", rc)
        self.assertTrue(rc["trajectory"], "spans must be reconstructable")
        self.assertEqual(rc["trajectory_steps"][0], "run:wired-2")
        self.assertIn("stop", rc["trajectory_steps"])

    def test_two_runs_chain_together(self):
        for tid in ("a", "b"):
            c = parse("do it", task_id=tid, scope=["engine/**"])
            run(c, vault=self.vault, tier1_commands=["true"],
                gateway=_offline_gateway())
        store = EvidenceStore(self.vault)
        recs = store.records()
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[1].prev_hash, recs[0].record_hash)
        self.assertTrue(store.verify_chain().ok)


if __name__ == "__main__":
    unittest.main()
