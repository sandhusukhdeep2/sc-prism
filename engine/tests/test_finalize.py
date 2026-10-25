"""Tests for the extracted governance tail: `finalize.run_tier2` + `finalize_run`.

The tail is split into two reusable helpers (so the loop keeps its exact
original order, and a team run can reuse both):

  * `run_tier2(...)`   — the Tier-2 judge step, with the Tier-1 short-circuit.
  * `finalize_run(...)` — build/write the Verdict + emit the training record,
    given an already-computed `tier2_result`.

These tests exercise both directly (offline gateway, synthetic Tier-1, a minimal
dispatch-trace stand-in), plus a GOLDEN end-to-end assertion through `loop.run`
that pins the exact `hooks_fired` sequence — the byte-identical-order regression
guard (tier2 BEFORE stop BEFORE writeback).
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.finalize import run_tier2, finalize_run
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine.telemetry import Telemetry
from scprism_engine.verifier import Tier1Result, Tier2Result
from scprism_engine.evidence import EvidenceStore
from scprism_engine.writeback import Verdict


def _offline_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only
    # (exactly as test_spans_and_verdict / test_evals build theirs).
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class _FakeStep:
    """A dispatch step_result stand-in: `observe_trace` reads output/route/
    kind/index via getattr, so this minimal shape is enough for Tier-2."""

    def __init__(self, output="synthesized answer", route="local", kind="read", index=0):
        self.output = output
        self.route = route
        self.kind = kind
        self.index = index


class _FakeTrace:
    """A minimal dispatch trace: just `tokens_spent` + `step_results`, the two
    attributes `evals.evaluate` / `observe_trace` actually read."""

    def __init__(self, tokens_spent=12):
        self.tokens_spent = tokens_spent
        self.step_results = [_FakeStep()]


class FinalizeRunTest(unittest.TestCase):
    """Direct unit tests of run_tier2 + finalize_run (no full loop.run)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.spans_path = os.path.join(self.vault, "spans.jsonl")
        self.telemetry = Telemetry(self.spans_path)

    def tearDown(self):
        self._tmp.cleanup()

    def _drive(self, tier1_passed, *, stop_compliant=True, threshold=0.0):
        """Drive run_tier2 -> finalize_run inside a root run span (their child
        spans nest under it, exactly as loop.run wires them). Returns the Verdict
        and the mutated hooks_fired accumulator."""
        contract = parse(
            "advisory team run: summarize the board",
            task_id="fin-1",
            scope=["**"],
            mode="read",
        )
        trace = _FakeTrace()
        t1 = Tier1Result(passed=tier1_passed, commands=[], tokens=0, skipped=True)
        # The loop's accumulator as it stands the moment Tier-2 runs.
        hooks_fired = ["plan", "memory", "dispatch", "tier1"]
        with self.telemetry.span(
            f"run:{contract.task_id}", span_type="run", task_id=contract.task_id
        ) as run_span:
            run_id = run_span.span_id
            t2 = run_tier2(
                contract,
                trace,
                tier1_passed=t1.passed,
                gateway=_offline_gateway(),
                telemetry=self.telemetry,
                parent_id=run_id,
                threshold=threshold,
                hooks_fired=hooks_fired,
            )
            self.assertIsInstance(t2, (Tier2Result, type(None)))
            verdict = finalize_run(
                contract=contract,
                tier1_result=t1,
                tier2_result=t2,
                vault=self.vault,
                telemetry=self.telemetry,
                run_id=run_id,
                spans_path=self.spans_path,
                tokens_spent=trace.tokens_spent,
                model_route=["local"],
                models_used=["local · offline"],
                response="synthesized answer",
                artifacts=[],
                cache_hits=0,
                cache_misses=1,
                steps=[_FakeStep()],
                stop_compliant=stop_compliant,
                hooks_fired=hooks_fired,
            )
        return verdict, hooks_fired

    def test_passing_finalize_writes_verdict_and_training(self):
        verdict, hooks_fired = self._drive(tier1_passed=True)

        # (1) A Verdict is returned, and it passed (Tier-1 pass + Tier-2 at a
        #     0.0 threshold within the default envelope, no blocks/rejections).
        self.assertIsInstance(verdict, Verdict)
        self.assertTrue(verdict.passed)
        self.assertTrue(verdict.tier1["passed"])
        self.assertTrue(verdict.tier2["ran"])
        # run_tier2 appended "tier2" before finalize_run appended "writeback".
        self.assertEqual(
            hooks_fired,
            ["plan", "memory", "dispatch", "tier1", "tier2", "writeback"],
        )

        # (2) The Verdict was persisted to <vault>/verdicts/<id>.json, and the
        #     written path was appended to verdict.artifacts.
        verdict_path = os.path.join(self.vault, "verdicts", "fin-1.json")
        self.assertTrue(os.path.exists(verdict_path))
        self.assertIn(verdict_path, verdict.artifacts)
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk["task_id"], "fin-1")
        self.assertTrue(on_disk["passed"])

        # (3) A training record was emitted for the passing verdict.
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        self.assertTrue(os.path.exists(records_path))
        with open(records_path, encoding="utf-8") as fh:
            records = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertEqual(len(records), 1, "exactly one training record on a pass")
        self.assertEqual(records[0]["task_id"], "fin-1")
        self.assertTrue(records[0]["final_verdict"]["passed"])

        # (4) The Verdict is auditable: appending it to the evidence spine (the
        #     step loop.run runs post-span) leaves the hash chain intact.
        EvidenceStore(self.vault).append_verdict(
            verdict, agent_id="orchestrator", role="data-reader",
            requester_role="", intent="advisory team run: summarize the board",
            diff={"writes": [], "scope": ["**"]},
        )
        report = EvidenceStore(self.vault).verify_chain()
        self.assertTrue(report.ok, report.reason)
        self.assertEqual(report.length, 1)

    def test_tier1_fail_short_circuits_tier2_and_emits_no_training(self):
        verdict, hooks_fired = self._drive(tier1_passed=False)

        # Tier-1 fail: run_tier2 returns None, no tier2 span/hook, verdict fails.
        self.assertFalse(verdict.passed)
        self.assertFalse(verdict.tier2["ran"])
        self.assertNotIn("tier2", hooks_fired)
        self.assertNotIn("tier2", verdict.hooks_fired)

        # The Verdict is still written (a fail is a real outcome)...
        self.assertTrue(os.path.exists(os.path.join(self.vault, "verdicts", "fin-1.json")))
        # ...but a failing verdict emits NO training record.
        self.assertFalse(self._training_emitted(), "a Tier-1 fail must emit no training record")

    def test_stop_noncompliant_pass_emits_no_training(self):
        # Even a passing Verdict emits nothing when the Stop ratchet is not
        # compliant (should_emit = stop_compliant AND verdict.passed).
        verdict, _ = self._drive(tier1_passed=True, stop_compliant=False)
        self.assertTrue(verdict.passed)
        self.assertFalse(self._training_emitted(), "stop-noncompliant run emits no record")

    def _training_emitted(self):
        p = os.path.join(self.vault, "training", "records.jsonl")
        return os.path.exists(p) and any(ln.strip() for ln in open(p, encoding="utf-8"))


class ConverseFinalizeTest(unittest.TestCase):
    """A chat turn that clears the judge is `replied` — and trains nothing.

    The GRPO seam exists for VERIFIED task work (specs/10 §1: the flywheel only
    ingests verified outcomes). A conversational reply has `passed=True` so the
    downstream pass-gates treat it as success, but there is no tier-1 evidence
    behind it and no repo work in it — feeding it to the reward record would
    teach the flywheel that chatting is task completion.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.spans_path = os.path.join(self.vault, "spans.jsonl")
        self.telemetry = Telemetry(self.spans_path)

    def tearDown(self):
        self._tmp.cleanup()

    def _drive_converse(self):
        contract = parse(
            "Create a wordpress theme like moppers slashcreative",
            task_id="conv-1",
            mode="converse",
        )
        trace = _FakeTrace()
        t1 = Tier1Result(passed=True, commands=[], tokens=0, skipped=True)
        hooks_fired = ["plan", "memory", "dispatch", "tier1"]
        with self.telemetry.span(
            f"run:{contract.task_id}", span_type="run", task_id=contract.task_id
        ) as run_span:
            run_id = run_span.span_id
            t2 = run_tier2(
                contract,
                trace,
                tier1_passed=t1.passed,
                gateway=_offline_gateway(),
                telemetry=self.telemetry,
                parent_id=run_id,
                threshold=0.0,
                hooks_fired=hooks_fired,
            )
            return finalize_run(
                contract=contract,
                tier1_result=t1,
                tier2_result=t2,
                vault=self.vault,
                telemetry=self.telemetry,
                run_id=run_id,
                spans_path=self.spans_path,
                tokens_spent=trace.tokens_spent,
                model_route=["local"],
                models_used=["local · offline"],
                response="What look do you want — minimal, bold, editorial?",
                artifacts=[],
                steps=[_FakeStep()],
                stop_compliant=True,
                hooks_fired=hooks_fired,
            )

    def test_a_replied_turn_emits_no_training_record(self):
        verdict = self._drive_converse()
        # The verdict itself says what happened, and counts as a success...
        self.assertEqual(verdict.outcome, "replied")
        self.assertTrue(verdict.passed)
        # ...but the flywheel never hears about it.
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        emitted = os.path.exists(records_path) and any(
            ln.strip() for ln in open(records_path, encoding="utf-8")
        )
        self.assertFalse(emitted, "a chat turn must emit no GRPO training record")

    def test_the_replied_verdict_is_still_persisted(self):
        # No training does not mean no record: the run's verdict is written
        # like any other, so the ledger and the Work page can show the turn.
        self._drive_converse()
        self.assertTrue(
            os.path.exists(os.path.join(self.vault, "verdicts", "conv-1.json"))
        )


class GoldenLoopOrderTest(unittest.TestCase):
    """The byte-identical-ORDER regression guard: a known offline loop.run must
    produce EXACTLY this hooks_fired sequence. This is the assertion that fails
    if the finalize extraction ever swaps tier2/stop again (the earlier bug)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_loop_hooks_fired_exact_sequence_and_audit_intact(self):
        contract = parse("add a rate-limit guard", task_id="golden-1")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            gateway=_offline_gateway(),
        )

        # GOLDEN: the exact order the inline loop always produced. Tier-2 is
        # appended BEFORE stop, and stop BEFORE writeback — the whole point of
        # keeping run_tier2 at its original position ahead of the Stop ratchet.
        self.assertEqual(
            verdict.hooks_fired,
            ["plan", "memory", "dispatch", "tier1", "tier2", "stop", "writeback"],
        )

        # The full governed run still writes the Verdict, emits a training
        # record, and appends to the evidence spine with the chain intact.
        self.assertTrue(verdict.passed)
        self.assertTrue(os.path.exists(os.path.join(self.vault, "verdicts", "golden-1.json")))
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        self.assertTrue(os.path.exists(records_path))
        report = EvidenceStore(self.vault).verify_chain()
        self.assertTrue(report.ok, report.reason)


if __name__ == "__main__":
    unittest.main()
