"""Concurrent PROCESSES must not fork the audit chain.

Found by verifying the founder's real ledger (2026-08-31): seq 142 appears
twice, written 1.4ms apart, and the hash link across it does not verify —
two engine runs (separate processes) both read seq=N and both appended.
A threading.Lock cannot span processes; the append now holds an exclusive
OS lock for the whole read→seal→append section.
"""
import json
import multiprocessing as mp
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.evidence import EvidenceStore


def _append_many(vault, n):
    store = EvidenceStore(vault)
    for i in range(n):
        store.append(
            task_id=f"t-{os.getpid()}-{i}",
            who={"agent_id": "probe"},
            what={"action": "probe"},
            why="concurrency probe",
            verdict={},
            tokens_spent=0,
            model_route=[],
            hooks_fired=[],
            passed=True,
            spans_path="",
        )


class TestConcurrentAppend(unittest.TestCase):
    def test_four_processes_appending_keep_one_unbroken_chain(self):
        with tempfile.TemporaryDirectory() as vault:
            procs = [mp.Process(target=_append_many, args=(vault, 8)) for _ in range(4)]
            for p in procs:
                p.start()
            for p in procs:
                p.join(60)

            path = os.path.join(vault, "evidence", "audit.jsonl")
            entries = [json.loads(l) for l in open(path) if l.strip()]
            self.assertEqual(len(entries), 32)

            seqs = [e["seq"] for e in entries]
            self.assertEqual(sorted(seqs), list(range(32)), "a seq was duplicated or skipped")

            for prev, cur in zip(entries, entries[1:]):
                self.assertEqual(
                    cur["prev_hash"],
                    prev["record_hash"],
                    f"chain forked between seq {prev['seq']} and {cur['seq']}",
                )


if __name__ == "__main__":
    unittest.main()
