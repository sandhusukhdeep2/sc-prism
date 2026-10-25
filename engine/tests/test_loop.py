import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run, _who


class TestFullLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_full_loop_emits_exactly_one_persisted_verdict(self):
        contract = parse("add a rate-limit guard", task_id="t-loop-1")
        verdict = run(contract, vault=self.vault, tier1_commands=["true"])

        verdicts_dir = os.path.join(self.vault, "verdicts")
        files = os.listdir(verdicts_dir)
        self.assertEqual(files, ["t-loop-1.json"], "exactly one verdict file")

        with open(os.path.join(verdicts_dir, files[0])) as fh:
            data = json.load(fh)
        self.assertEqual(data["task_id"], "t-loop-1")
        self.assertTrue(data["tier1"]["ran"])
        self.assertTrue(data["tier2"]["ran"])
        self.assertTrue(verdict.passed)

        # log.md was appended.
        log = os.path.join(self.vault, "log.md")
        self.assertTrue(os.path.exists(log))
        with open(log) as fh:
            self.assertIn("t-loop-1", fh.read())

    def test_tier1_failure_short_circuits_tier2(self):
        contract = parse("add a broken thing", task_id="t-fail-1")
        verdict = run(contract, vault=self.vault, tier1_commands=["exit 3"])

        self.assertFalse(verdict.passed)
        self.assertFalse(verdict.tier1["passed"])
        # Tier-2 must NOT have run.
        self.assertFalse(verdict.tier2["ran"])
        self.assertNotIn("tier2", verdict.hooks_fired)
        # Persisted with same short-circuit shape.
        with open(os.path.join(self.vault, "verdicts", "t-fail-1.json")) as fh:
            data = json.load(fh)
        self.assertFalse(data["tier2"]["ran"])

    def test_writeback_is_atomic_single_file(self):
        contract = parse("add another guard", task_id="t-atomic")
        run(contract, vault=self.vault, tier1_commands=["true"])
        # No leftover .tmp files from the atomic write.
        leftovers = [
            f
            for f in os.listdir(os.path.join(self.vault, "verdicts"))
            if f.endswith(".tmp")
        ]
        self.assertEqual(leftovers, [])


class TestTier1IsAProjectGate(unittest.TestCase):
    """A run with nothing to verify SKIPS the gate — it does not fail it.

    The app attaches the interview's verify command to EVERY run, including a
    plain chat message ("hello, are you real?"). With no project bound the cwd
    is '' and the gate could not run, so the run FAILED — which is why
    essentially every run in the user's history read `passed: False`, chat and
    manager report jobs included. A verify command over no codebase is not a
    check that can mean anything, and failing the run for not doing it is a
    false negative that poisons pass rates, agent stats and the desk everywhere.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _spans(self, name):
        with open(os.path.join(self.vault, "spans.jsonl"), encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        return [r for r in rows if r.get("name") == name]

    def test_a_chat_shaped_run_skips_the_gate_honestly_and_can_pass(self):
        contract = parse("hello, are you real?", task_id="t-chat-1")
        verdict = run(contract, vault=self.vault, tier1_commands=["npm test"], tier1_cwd="")

        self.assertTrue(verdict.tier1["skipped"], "nothing to verify -> the gate skips")
        self.assertTrue(verdict.passed, "a chat message must not FAIL for having no tests")
        self.assertTrue(verdict.tier2["ran"], "a skipped gate does not short-circuit the judge")
        # A skip is never silent: the reason and the unrun command ride the verdict.
        self.assertIn("nothing to verify", verdict.tier1["skip_reason"])
        self.assertIn("no project bound", verdict.tier1["skip_reason"])
        self.assertEqual(verdict.tier1["skipped_commands"], ["npm test"])

    def test_the_skipped_tier1_span_is_not_an_error_and_carries_the_reason(self):
        # The span is what the Console, the desk and tier1_stats read. A skip
        # recorded as status=error is the same false negative one layer down.
        contract = parse("hello again", task_id="t-chat-2")
        run(contract, vault=self.vault, tier1_commands=["npm test"], tier1_cwd="")
        span = self._spans("tier1")[0]
        self.assertNotEqual(span["status"], "error")
        self.assertTrue(span["attrs"]["skipped"])
        self.assertEqual(span["attrs"]["skipped_commands"], ["npm test"])
        self.assertEqual(span["attrs"]["commands"], [], "nothing ran")
        self.assertEqual(span["attrs"]["not_found"], [], "a skip is not an unrunnable gate")

    def test_a_bound_project_still_gates_and_a_failing_check_still_fails(self):
        # The gate is unchanged wherever it can actually mean something.
        with tempfile.TemporaryDirectory() as proj:
            contract = parse("break something", task_id="t-proj-1")
            verdict = run(
                contract, vault=self.vault, tier1_commands=["exit 3"], tier1_cwd=proj
            )
        self.assertFalse(verdict.passed)
        self.assertFalse(verdict.tier1["passed"])
        self.assertFalse(verdict.tier1["skipped"], "a gate that RAN is never a skip")
        self.assertFalse(verdict.tier2["ran"], "a real Tier-1 failure still short-circuits")

    def test_a_bound_project_that_passes_is_a_real_pass(self):
        with tempfile.TemporaryDirectory() as proj:
            contract = parse("do the thing", task_id="t-proj-2")
            verdict = run(
                contract, vault=self.vault, tier1_commands=["true"], tier1_cwd=proj
            )
        self.assertTrue(verdict.tier1["passed"])
        self.assertFalse(verdict.tier1["skipped"])
        self.assertEqual(verdict.tier1["commands"], ["true"])


if __name__ == "__main__":
    unittest.main()


class TestSoloRunNamesItsWorker(unittest.TestCase):
    """A solo run can say WHO did it and WHICH phase it was.

    A team run has always written `agent` and `round` onto its model_call spans.
    A solo run wrote neither, so a chat reply, a companion wake and a project
    plan step were all unattributable — 209 of 219 runs in Sukhdeep's real vault
    carry no agent at all, which is why the crew board is absent on almost every
    run he does.

    Empty (the default) writes NEITHER attr: an absent attr and an empty one are
    different claims, and every reader treats a present `agent` as "this run had
    a named worker".
    """

    def test_unnamed_run_writes_neither_attr(self):
        self.assertEqual(_who("", ""), {})
        self.assertEqual(_who("   ", "  "), {})

    def test_a_named_worker_lands_on_the_span_as_agent(self):
        self.assertEqual(_who("companion", ""), {"agent": "companion"})

    def test_a_named_phase_lands_as_round_which_is_what_the_board_groups_by(self):
        self.assertEqual(_who("", "Research"), {"round": "Research"})

    def test_both_together(self):
        self.assertEqual(
            _who("researcher", "Research"),
            {"agent": "researcher", "round": "Research"},
        )

    def test_surrounding_whitespace_is_not_a_name(self):
        self.assertEqual(_who("  writer  ", "  Drafting  "),
                         {"agent": "writer", "round": "Drafting"})
