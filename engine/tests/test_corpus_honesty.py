"""The stored corpus tells the truth about no-answer runs (2026-11-08).

Before today a run the model never answered was filed as passed and trained
on. The engine refuses that now — for NEW runs. The old files remain: in one
real vault 113 of 200 passed verdicts and 113 of 199 training records. A
training record carries no response and no is_real, so it cannot identify
itself; only the join to its verdict (``verdicts/<task_id>.json``) can.

* ``training.read_records`` never returns a record whose verdict was a
  stand-in, migrated or not.
* ``training.set_aside_unanswered`` moves such legacy records from
  ``records.jsonl`` to ``records.set-aside.jsonl`` with the reason — nothing
  deleted, idempotent — so the app's plain line count is honest too.
* ``observability.outcome_stats`` counts a "pass" whose model calls were all
  stand-ins as ``unanswered``, not ``passed``. Runs whose spans predate
  ``is_real`` are left alone: we do not guess.
"""
import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import observability, training

STAND_IN = "[offline:local:gemma-3] handled: summarise the new notes (ab12cd34)"


def _verdict(vault, task_id, response, passed=True):
    d = os.path.join(vault, "verdicts")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{task_id}.json"), "w", encoding="utf-8") as fh:
        json.dump({"task_id": task_id, "response": response, "passed": passed}, fh)


def _record(task_id):
    return {"task_id": task_id, "schema": "training-record/v1", "reward": {"value": 0.97}}


class TestLegacyNoAnswerRecords(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        _verdict(self.vault, "t-real", "a real answer")
        _verdict(self.vault, "t-standin", STAND_IN)
        for tid in ("t-real", "t-standin", "t-orphan"):  # t-orphan: no verdict on file
            training.emit_record(_record(tid), self.vault)
        self.records = os.path.join(self.vault, "training", "records.jsonl")
        self.aside = os.path.join(self.vault, "training", "records.set-aside.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def _ids(self, path):
        with open(path, encoding="utf-8") as fh:
            return [json.loads(l)["task_id"] for l in fh if l.strip()]

    def test_read_records_never_returns_a_record_whose_verdict_was_a_stand_in(self):
        ids = [r["task_id"] for r in training.read_records(self.vault)]
        self.assertEqual(ids, ["t-real", "t-orphan"], "a record with no verdict on file is kept: we do not guess")

    def test_set_aside_moves_them_with_the_reason_and_nothing_is_lost(self):
        self.assertEqual(training.set_aside_unanswered(self.vault), 1)
        self.assertEqual(self._ids(self.records), ["t-real", "t-orphan"])
        with open(self.aside, encoding="utf-8") as fh:
            moved = [json.loads(l) for l in fh if l.strip()]
        self.assertEqual([m["task_id"] for m in moved], ["t-standin"])
        self.assertIn("never answered", moved[0]["set_aside_reason"])
        self.assertTrue(moved[0]["set_aside_at"])
        self.assertEqual(moved[0]["reward"], {"value": 0.97}, "the record itself travels intact")

    def test_set_aside_is_idempotent(self):
        training.set_aside_unanswered(self.vault)
        self.assertEqual(training.set_aside_unanswered(self.vault), 0)
        self.assertEqual(self._ids(self.records), ["t-real", "t-orphan"])
        self.assertEqual(self._ids(self.aside), ["t-standin"])

    def test_a_vault_with_no_records_or_no_verdicts_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(training.set_aside_unanswered(empty), 0)
            self.assertEqual(training.read_records(empty), [])


def _run(run_id, outcome, calls):
    """A run's spans: root + verdict + one model_call per entry in ``calls``
    (each entry is the attrs dict, or None for a span with no is_real key)."""
    spans = [{"run_id": run_id, "span_id": run_id, "parent_id": None, "name": f"run:{run_id}",
              "type": "run", "start": 1.0, "end": 2.0, "duration_ms": 1000.0, "status": "ok",
              "attrs": {"task_id": run_id}},
             {"run_id": run_id, "span_id": f"{run_id}-v", "parent_id": run_id, "name": "verdict",
              "type": "verdict", "start": 1.9, "end": 2.0, "duration_ms": 100.0, "status": "ok",
              "attrs": {"passed": outcome != "failed", "outcome": outcome}}]
    for i, attrs in enumerate(calls):
        a = {"provider": "local", "model": "gemma-3", "tokens_in": 10, "tokens_out": 0, "cache": "miss"}
        if attrs is not None:
            a.update(attrs)
        spans.append({"run_id": run_id, "span_id": f"{run_id}-m{i}", "parent_id": run_id,
                      "name": "model_call", "type": "model_call", "start": 1.1 + i / 10, "end": 1.2 + i / 10,
                      "duration_ms": 100.0, "status": "ok", "attrs": a})
    return spans


class TestAPassWithNoRealCompletionIsUnanswered(unittest.TestCase):
    def setUp(self):
        self.spans = (
            _run("r-fake", "passed", [{"is_real": False}, {"is_real": False}])  # every call a stand-in
            + _run("r-real", "passed", [{"is_real": False}, {"is_real": True}])  # one real answer
            + _run("r-old", "passed", [None])  # spans from before is_real existed
            + _run("r-chat", "replied", [{"is_real": False}])
        )

    def test_run_series_says_whether_the_model_answered(self):
        by = {r.run_id: r.answered for r in observability.run_series(self.spans)}
        self.assertEqual(by, {"r-fake": False, "r-real": True, "r-old": None, "r-chat": False})

    def test_a_judge_that_stood_in_does_not_make_an_answered_run_unanswered(self):
        # A project step's doer may emit no span of its own; the only flagged
        # model_call is then the Tier-2 judge's, which can stand in while the
        # work was real. That run keeps its outcome: answered is unknown.
        spans = _run("r-judge", "passed", [])
        judge = dict(spans[-1] if spans[-1]["type"] == "model_call" else spans[1])
        spans.append({"run_id": "r-judge", "span_id": "r-judge-eval", "parent_id": "r-judge",
                      "name": 'eval', "type": "model_call", "start": 1.5, "end": 1.6, "duration_ms": 100.0,
                      "status": "ok", "attrs": {"provider": "local", "model": "gemma-3", "is_real": False}})
        r = observability.run_series(spans)[0]
        self.assertIsNone(r.answered)
        self.assertEqual(observability.outcome_stats(spans)["passed"], 1)

    def test_outcome_stats_counts_them_as_unanswered_not_passed(self):
        o = observability.outcome_stats(self.spans)
        self.assertEqual(o["passed"], 2, "the real pass and the pre-is_real pass we do not second-guess")
        self.assertEqual(o["replied"], 0)
        self.assertEqual(o["unanswered"], 2)
        self.assertEqual(o["total"], 4)


if __name__ == "__main__":
    unittest.main()
