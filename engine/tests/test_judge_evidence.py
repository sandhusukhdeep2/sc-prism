"""The judge must be able to SEE what the run produced (and the tier hierarchy
must survive the judge disagreeing with it).

The bug these tests pin down, found on the first real `project` build: a run
wrote 6 files / 397 lines of a Node CLI, `npm test` reported `# pass 11 /
# fail 0`, and Tier-1 genuinely RAN and PASSED. The run was recorded
`passed: false` because the Tier-2 LLM judge scored 0.5 with "the execution
trace is incomplete and the produced artifact is truncated, failing to provide
the actual implementation or the required files."

That sentence was an accurate description of the PROMPT. The judge was shown a
200-char slice of the trace and a 500-char slice of the completion, both cut
mid-word with no marker, and nothing at all about the files on disk or the
Tier-1 result. An LLM opinion formed without the artifact then outranked a
deterministic gate holding real evidence — inverting this product's stated
hierarchy and putting failures on work that had succeeded.

Two halves, tested here:

  1. The judge prompt carries the MEASURED truth — the written-file list with
     sizes, the real Tier-1 outcome with its command, bounded file excerpts read
     back from disk, and an explicit label on every cut the harness makes.
  2. A run whose deterministic checks ran over real files and passed is recorded
     as `outcome="attention"` when the judge dissents — "tests passed, reviewer
     wasn't satisfied" — never as a flat failure. A run that produced nothing
     still fails.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import evals
from scprism_engine.contract import parse
from scprism_engine.dispatcher import DispatchResult, StepResult
from scprism_engine.gateway import Gateway
from scprism_engine.verifier import CommandResult, Tier1Result, Tier2Result
from scprism_engine.writeback import build_verdict, write_verdict

# The six files of the real run, and its real `npm test` output.
REAL_FILES = [
    "package.json",
    "bin/vault-report.js",
    "src/parseLog.js",
    "src/generateReport.js",
    "test/parseLog.test.js",
    "test/report.test.js",
]
REAL_TEST_OUTPUT = "# tests 11\n# suites 2\n# pass 11\n# fail 0\n# cancelled 0\n"


def _project_on_disk(root, files=REAL_FILES, body_lines=60):
    """Write a project's files so evidence gathering has something to measure."""
    for rel in files:
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path) or root, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"// {rel}\n" + ("const x = 1;\n" * body_lines))
    return list(files)


def _tier1_pass(command="npm test"):
    return Tier1Result(
        passed=True,
        commands=[
            CommandResult(
                command=command, returncode=0, stdout=REAL_TEST_OUTPUT, stderr=""
            )
        ],
        tokens=0,
    )


def _tier1_skipped(command="npm test"):
    return Tier1Result(
        passed=True,
        commands=[],
        tokens=0,
        skipped=True,
        skip_reason="skipped — no project bound, nothing to verify.",
        skipped_commands=[command],
    )


def _dissenting_judge(score=0.5, notes="", contradictions=()):
    """A Tier-2 result that RAN, cleared its envelope, and scored below bar."""
    return Tier2Result(
        ran=True,
        score=score,
        eval_score=score,
        metrics={n: score for n in evals.METRIC_NAMES},
        threshold=0.7,
        passed=False,
        envelope_ok=True,
        tokens=120,
        judge_notes=notes,
        rationale=notes,
        contradictions=list(contradictions),
    )


def _big_completion(chars=12543):
    return "I'll build the vault report CLI.\n\n" + ("// implementation\n" * (chars // 18))


def _fake_model(text):
    """A `ModelCall` double: `(description, route) -> ModelResult`."""
    from scprism_engine.dispatcher import ModelResult

    def call(description, route):
        return ModelResult(text=text, tokens=len(text) // 4, route=route)

    return call


def _write_trace(output):
    return DispatchResult(
        step_results=[
            StepResult(
                index=0,
                description="build the CLI",
                kind="write",
                route="cloud",
                output=output,
                tokens=4000,
                truncated=False,
            )
        ],
        tokens_spent=4000,
    )


class TestJudgeSeesWhatWasProduced(unittest.TestCase):
    """(1) The prompt carries the file list and the real Tier-1 outcome."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        self.files = _project_on_disk(self.root)
        self.evidence = evals.build_evidence(
            tier1_result=_tier1_pass(), files_written=self.files, root=self.root
        )

    def _prompt(self, evidence=None, artifact=None):
        contract = parse("Build a Node CLI that reports on a vault log", task_id="t-p")
        trace = _write_trace(artifact if artifact is not None else _big_completion())
        obs = evals.observe_trace(trace)
        msgs = evals._build_judge_messages(
            contract, obs, obs["outputs"][0], evidence=evidence
        )
        return msgs[-1]["content"]

    def test_prompt_names_every_written_file_and_its_size(self):
        prompt = self._prompt(self.evidence)
        for rel in self.files:
            self.assertIn(rel, prompt, f"{rel} missing from the judge prompt")
        # Sizes, not just names: "6 files exist" is the claim being evidenced.
        for f in self.evidence.files:
            self.assertIn(f"({f['bytes']} bytes)", prompt)
        self.assertIn("FILES WRITTEN: 6 file(s)", prompt)

    def test_prompt_states_the_real_tier1_outcome_and_command(self):
        prompt = self._prompt(self.evidence)
        self.assertIn("RAN AND PASSED", prompt)
        self.assertIn("`npm test`", prompt)
        # The gate's own output is the proof, not our summary of it.
        self.assertIn("# pass 11", prompt)
        self.assertIn("# fail 0", prompt)

    def test_prompt_includes_a_bounded_excerpt_of_the_written_files(self):
        prompt = self._prompt(self.evidence)
        self.assertIn("FILE CONTENT (read back from disk", prompt)
        self.assertIn("// package.json", prompt)

    def test_a_failing_tier1_is_reported_as_failing_not_hidden(self):
        t1 = Tier1Result(
            passed=False,
            commands=[
                CommandResult(
                    command="npm test", returncode=1, stdout="# fail 3", stderr=""
                )
            ],
        )
        ev = evals.build_evidence(
            tier1_result=t1, files_written=self.files, root=self.root
        )
        prompt = self._prompt(ev)
        self.assertIn("RAN AND FAILED", prompt)
        self.assertNotIn("RAN AND PASSED", prompt)

    def test_a_skipped_tier1_is_never_presented_as_a_pass(self):
        ev = evals.build_evidence(
            tier1_result=_tier1_skipped(), files_written=[], root=self.root
        )
        prompt = self._prompt(ev)
        self.assertIn("SKIPPED", prompt)
        self.assertIn("A skip is NOT a pass", prompt)
        self.assertNotIn("RAN AND PASSED", prompt)

    def test_harness_truncation_is_labelled_as_the_harness_not_the_agent(self):
        """The exact cause of the 0.5: a silent cut that reads as a cut-off model."""
        prompt = self._prompt(self.evidence)
        self.assertIn("cut by the evaluation harness", prompt)
        self.assertIn("NOT a truncated model response", prompt)

    def test_an_empty_run_is_reported_as_empty(self):
        ev = evals.build_evidence(tier1_result=_tier1_pass(), files_written=[])
        prompt = self._prompt(ev, artifact="")
        self.assertIn("FILES WRITTEN: none", prompt)

    def test_a_converse_turn_is_not_framed_as_a_build_that_wrote_nothing(self):
        """The sentence the judge quoted in both real failing chat verdicts:
        "FILES WRITTEN: none ... if the task required producing files, it did
        not." True of a build. For a chat turn it hands the judge a
        no-deliverable frame for a run whose deliverable is the reply."""
        contract = parse(
            "Create a wordpress theme like moppers slashcreative",
            task_id="t-conv",
            mode="converse",
        )
        ev = evals.build_evidence(tier1_result=None, files_written=[])
        trace = _write_trace("What look do you want — minimal, bold, editorial?")
        obs = evals.observe_trace(trace)
        prompt = evals._build_judge_messages(
            contract, obs, obs["outputs"][0], evidence=ev
        )[-1]["content"]
        self.assertNotIn("FILES WRITTEN: none", prompt)
        self.assertNotIn("if the task required producing files", prompt)
        # Replaced, not merely dropped — silence would leave the judge to
        # infer the same no-deliverable story.
        self.assertIn("conversational turn", prompt)

    def test_read_and_write_turns_keep_the_files_frame(self):
        # The build-frame sentence stays load-bearing everywhere it was true.
        for mode in ("read", "write"):
            contract = parse("summarise the log", task_id=f"t-{mode}", mode=mode)
            ev = evals.build_evidence(tier1_result=None, files_written=[])
            obs = evals.observe_trace(_write_trace("done"))
            prompt = evals._build_judge_messages(
                contract, obs, obs["outputs"][0], evidence=ev
            )[-1]["content"]
            self.assertIn("FILES WRITTEN: none", prompt, f"mode={mode}")

    def test_evidence_reaches_the_gateway_judge_call(self):
        """End to end through `evals.evaluate` — the prompt the model receives."""

        class _Spy(Gateway):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                self.messages = []

            def model_call(self, messages, route):
                self.messages.append(messages)
                return super().model_call(messages, route)

        gw = _Spy(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        contract = parse("Build a Node CLI", task_id="t-e2e")
        evals.evaluate(
            contract,
            _write_trace(_big_completion()),
            gateway=gw,
            run_evidence=self.evidence,
        )
        sent = "\n".join(m["content"] for msgs in gw.messages for m in msgs)
        self.assertIn("WHAT THIS RUN ACTUALLY PRODUCED", sent)
        self.assertIn("bin/vault-report.js", sent)
        self.assertIn("RAN AND PASSED", sent)


class TestTokenEnvelope(unittest.TestCase):
    """(4) A large file set must not blow the prompt budget."""

    def test_evidence_block_stays_inside_its_budget_with_many_files(self):
        with tempfile.TemporaryDirectory() as root:
            files = _project_on_disk(
                root, [f"src/mod{i:03d}.js" for i in range(500)], body_lines=200
            )
            ev = evals.build_evidence(
                tier1_result=_tier1_pass(), files_written=files, root=root
            )
            block = evals.format_evidence(ev)
            self.assertLessEqual(len(block), evals.JUDGE_EVIDENCE_CHAR_BUDGET)
            # Bounded, but still TRUE: the count and total size are exact, and
            # the elision says the files exist rather than implying they don't.
            self.assertIn("500 file(s)", block)
            self.assertIn(f"{ev.total_bytes} bytes total", block)

    def test_excerpts_respect_the_per_file_and_total_budgets(self):
        with tempfile.TemporaryDirectory() as root:
            files = _project_on_disk(
                root, [f"src/mod{i:02d}.js" for i in range(20)], body_lines=5000
            )
            ev = evals.build_evidence(
                tier1_result=_tier1_pass(), files_written=files, root=root
            )
            total = sum(len(f["excerpt"]) for f in ev.files)
            self.assertLessEqual(total, evals.JUDGE_EXCERPT_BUDGET)
            for f in ev.files:
                self.assertLessEqual(len(f["excerpt"]), evals.JUDGE_EXCERPT_PER_FILE)

    def test_the_whole_prompt_stays_proportionate(self):
        with tempfile.TemporaryDirectory() as root:
            files = _project_on_disk(root, [f"f{i}.js" for i in range(300)])
            ev = evals.build_evidence(
                tier1_result=_tier1_pass(), files_written=files, root=root
            )
            contract = parse("Build a big thing", task_id="t-big")
            obs = evals.observe_trace(_write_trace(_big_completion()))
            prompt = evals._build_judge_messages(
                contract, obs, obs["outputs"][0], evidence=ev
            )[-1]["content"]
            ceiling = (
                evals.JUDGE_EVIDENCE_CHAR_BUDGET
                + evals.JUDGE_ARTIFACT_CHARS
                + evals.JUDGE_STEP_CHARS
                + len(contract.intent)
                + 2000  # fixed instruction text + criteria
            )
            self.assertLessEqual(len(prompt), ceiling)


class TestContradictionsAreSurfaced(unittest.TestCase):
    """A judge claim the deterministic layer disproves is a JUDGE error."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.files = _project_on_disk(self.tmp.name)
        self.evidence = evals.build_evidence(
            tier1_result=_tier1_pass(), files_written=self.files, root=self.tmp.name
        )

    def test_the_real_judge_sentence_is_flagged(self):
        found = evals.detect_contradictions(
            {n: 0.5 for n in evals.METRIC_NAMES},
            "The execution trace is incomplete and the produced artifact is "
            "truncated, failing to provide the actual implementation or the "
            "required files.",
            self.evidence,
        )
        self.assertTrue(found)
        self.assertIn("npm test", " ".join(found))

    def test_a_zero_completion_score_over_written_files_is_flagged(self):
        found = evals.detect_contradictions(
            {**{n: 0.9 for n in evals.METRIC_NAMES}, "task_completion": 0.0},
            "looks fine",
            self.evidence,
        )
        self.assertTrue(any("task_completion" in f for f in found))

    def test_an_honest_criticism_of_an_empty_run_is_not_flagged(self):
        ev = evals.build_evidence(tier1_result=_tier1_pass(), files_written=[])
        self.assertEqual(
            evals.detect_contradictions(
                {n: 0.1 for n in evals.METRIC_NAMES},
                "no files were produced and the implementation is incomplete",
                ev,
            ),
            [],
        )

    def test_dissent_without_a_factual_claim_is_not_flagged(self):
        self.assertEqual(
            evals.detect_contradictions(
                {n: 0.6 for n in evals.METRIC_NAMES},
                "the CLI works but the error handling is thin and untested",
                self.evidence,
            ),
            [],
        )

    def test_a_skipped_tier1_cannot_contradict_anything(self):
        ev = evals.build_evidence(
            tier1_result=_tier1_skipped(), files_written=self.files, root=self.tmp.name
        )
        self.assertEqual(
            evals.detect_contradictions(
                {n: 0.1 for n in evals.METRIC_NAMES}, "truncated", ev
            ),
            [],
        )

    def test_contradictions_ride_out_on_the_tier2_result(self):
        class _Judge(Gateway):
            def model_call(self, messages, route):
                res = super().model_call(messages, route)
                res.text = (
                    '{"trajectory_sensibility": 0.5, "tool_use_accuracy": 0.5, '
                    '"acceptance_criteria_satisfaction": 0.5, "task_completion": 0.5, '
                    '"notes": "the produced artifact is truncated"}'
                )
                return res

        gw = _Judge(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)
        t2 = evals.evaluate(
            parse("Build a Node CLI", task_id="t-c"),
            _write_trace(_big_completion()),
            gateway=gw,
            run_evidence=self.evidence,
        )
        self.assertTrue(t2.contradictions)
        self.assertIn("JUDGE ERROR", t2.judge_notes)


class TestVerdictOutcome(unittest.TestCase):
    """(2)+(3) The hierarchy, recorded honestly."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.files = _project_on_disk(self.tmp.name)

    def _verdict(self, **kw):
        args = dict(
            task_id="t-outcome",
            tier1_result=_tier1_pass(),
            tier2_result=_dissenting_judge(),
            tokens_spent=100,
            produced_files=self.files,
        )
        args.update(kw)
        return build_verdict(**args)

    def test_tier1_passed_plus_artifact_plus_judge_dissent_is_attention(self):
        v = self._verdict()
        self.assertEqual(v.outcome, "attention")
        self.assertFalse(v.passed)  # not laundered into a pass either
        self.assertIn("tests passed, reviewer dissented", v.outcome_reason)
        self.assertIn("NOT a failure", v.outcome_reason)

    def test_both_tiers_recorded_distinctly_on_an_attention_verdict(self):
        v = self._verdict()
        self.assertTrue(v.tier1["passed"])
        self.assertFalse(v.tier1["skipped"])
        self.assertTrue(v.tier2["ran"])
        self.assertFalse(v.tier2["passed"])
        self.assertEqual(v.tier2["eval_score"], 0.5)

    def test_an_empty_run_still_fails(self):
        v = self._verdict(produced_files=[])
        self.assertEqual(v.outcome, "failed")
        self.assertFalse(v.passed)
        self.assertIn("no files were produced", v.outcome_reason)

    def test_a_skipped_tier1_cannot_earn_attention(self):
        """A skip verifies nothing, so it outranks no opinion."""
        v = self._verdict(tier1_result=_tier1_skipped())
        self.assertEqual(v.outcome, "failed")
        self.assertIn("tier-1 was skipped", v.outcome_reason)

    def test_a_failing_tier1_still_fails(self):
        t1 = Tier1Result(
            passed=False,
            commands=[CommandResult(command="npm test", returncode=1, stdout="", stderr="")],
        )
        v = self._verdict(tier1_result=t1, tier2_result=None)
        self.assertEqual(v.outcome, "failed")

    def test_an_envelope_breach_is_deterministic_and_still_fails(self):
        """Tier-2 is not being ignored: its DETERMINISTIC half still fails hard."""
        t2 = _dissenting_judge(score=0.95)
        t2.envelope_ok = False
        t2.breaches = ["token_budget: 90000 > 8000"]
        v = self._verdict(tier2_result=t2)
        self.assertEqual(v.outcome, "failed")
        self.assertIn("envelope BREACH", v.outcome_reason)

    def test_a_governance_block_still_fails(self):
        v = self._verdict(blocks=[{"hook": "pre_tool", "reason": "denied"}])
        self.assertEqual(v.outcome, "failed")

    def test_a_rejected_vault_write_still_fails(self):
        v = self._verdict(rejected_writes=[{"path": "a.md", "reason": "contradiction"}])
        self.assertEqual(v.outcome, "failed")

    def test_a_clean_run_is_passed(self):
        t2 = _dissenting_judge(score=0.9)
        t2.passed = True
        v = self._verdict(tier2_result=t2)
        self.assertEqual(v.outcome, "passed")
        self.assertTrue(v.passed)

    def test_passed_and_outcome_can_never_disagree(self):
        from scprism_engine.writeback import Verdict, VerdictError

        bad = Verdict(task_id="x", tier1={}, tier2={}, tokens_spent=0,
                      passed=True, outcome="attention")
        with self.assertRaises(VerdictError):
            bad.validate()

    def test_a_converse_turn_that_clears_the_judge_is_replied_not_passed(self):
        """A chat turn writes no files and runs no checks BY DESIGN. When the
        judge clears the reply, the verdict says what actually happened — a
        reply — instead of borrowing a build's vocabulary either way."""
        t2 = _dissenting_judge(score=0.82)
        t2.passed = True
        v = build_verdict(
            task_id="t-conv-pass",
            tier1_result=_tier1_skipped(),
            tier2_result=t2,
            tokens_spent=100,
            produced_files=[],
            mode="converse",
        )
        self.assertEqual(v.outcome, "replied")
        # `passed` True: downstream pass-gates treat a good reply as success.
        self.assertTrue(v.passed)
        self.assertIn("reply", v.outcome_reason)
        self.assertIn("0.82", v.outcome_reason)
        self.assertNotIn("file", v.outcome_reason)

    def test_a_converse_turn_the_judge_rejects_fails_in_reply_terms(self):
        v = build_verdict(
            task_id="t-conv-fail",
            tier1_result=_tier1_skipped(),
            tier2_result=_dissenting_judge(),
            tokens_spent=100,
            produced_files=[],
            mode="converse",
        )
        self.assertEqual(v.outcome, "failed")
        self.assertFalse(v.passed)
        self.assertIn("reply", v.outcome_reason)
        # The two lines the real failing chat verdicts carried, gone: a chat
        # turn cannot fail for lacking files or for skipping checks it never had.
        self.assertNotIn("file", v.outcome_reason)
        self.assertNotIn("skipped", v.outcome_reason)

    def test_replied_requires_passed_true(self):
        from scprism_engine.writeback import Verdict, VerdictError

        bad = Verdict(task_id="x", tier1={}, tier2={}, tokens_spent=0,
                      passed=False, outcome="replied")
        with self.assertRaises(VerdictError):
            bad.validate()

    def test_a_write_run_is_never_stamped_replied(self):
        # Same tier shape as the replied case, mode left as the default: the
        # new outcome is converse-only.
        t2 = _dissenting_judge(score=0.82)
        t2.passed = True
        v = build_verdict(
            task_id="t-write-pass",
            tier1_result=_tier1_skipped(),
            tier2_result=t2,
            tokens_spent=100,
            produced_files=[],
        )
        self.assertEqual(v.outcome, "passed")

    def test_the_vault_log_says_replied_not_fail(self):
        with tempfile.TemporaryDirectory() as vault:
            t2 = _dissenting_judge(score=0.82)
            t2.passed = True
            v = build_verdict(
                task_id="t-conv-log",
                tier1_result=_tier1_skipped(),
                tier2_result=t2,
                tokens_spent=100,
                produced_files=[],
                mode="converse",
            )
            write_verdict(v, vault)
            with open(os.path.join(vault, "log.md"), encoding="utf-8") as fh:
                log = fh.read()
            self.assertIn("**REPLIED**", log)
            self.assertNotIn("**FAIL**", log)

    def test_contradictions_are_named_in_the_outcome_reason(self):
        t2 = _dissenting_judge(
            contradictions=["judge claimed 'truncat' but 6 file(s) are on disk"]
        )
        v = self._verdict(tier2_result=t2)
        self.assertIn("contradicted measured evidence", v.outcome_reason)
        self.assertIn("unreliable", v.outcome_reason)

    def test_outcome_and_contradictions_persist_into_the_verdict_json(self):
        with tempfile.TemporaryDirectory() as vault:
            t2 = _dissenting_judge(contradictions=["judge claimed 'truncat'"])
            v = self._verdict(tier2_result=t2)
            path = write_verdict(v, vault)
            import json

            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["outcome"], "attention")
            self.assertTrue(data["outcome_reason"])
            self.assertEqual(data["tier2"]["contradictions"], ["judge claimed 'truncat'"])

    def test_the_vault_log_says_attention_not_fail(self):
        with tempfile.TemporaryDirectory() as vault:
            write_verdict(self._verdict(), vault)
            with open(os.path.join(vault, "log.md"), encoding="utf-8") as fh:
                log = fh.read()
            self.assertIn("**ATTENTION**", log)
            self.assertNotIn("**FAIL**", log)


class TestLoopWiresTheEvidence(unittest.TestCase):
    """The project run shape, end to end through `loop.run`."""

    def test_project_run_shows_the_judge_its_files_and_records_attention(self):
        from scprism_engine.loop import run

        with tempfile.TemporaryDirectory() as vault, tempfile.TemporaryDirectory() as proj:
            files = _project_on_disk(proj)

            def _judge(trace):
                return _dissenting_judge(notes="the artifact is truncated")

            verdict = run(
                parse("Build a Node CLI", task_id="t-loop", mode="write"),
                vault=vault,
                tier1_commands=["true"],
                tier1_cwd=proj,
                post_dispatch=lambda completion: {
                    "files_written": files, "rejected": []
                },
                gateway=Gateway(
                    openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2
                ),
                model=_fake_model(
                    "FILE: package.json\n```json\n{}\n```\n" + _big_completion()
                ),
                judge=_judge,
                record_training=False,
            )

            # The verdict tells the truth about BOTH tiers.
            self.assertEqual(verdict.outcome, "attention")
            self.assertFalse(verdict.passed)
            self.assertTrue(verdict.tier1["passed"])
            self.assertFalse(verdict.tier1["skipped"])
            self.assertFalse(verdict.tier2["passed"])
            self.assertEqual(
                verdict.extras["project"]["files_written"], files
            )

    def test_a_real_judge_in_the_loop_receives_the_evidence(self):
        from scprism_engine.loop import run

        with tempfile.TemporaryDirectory() as vault, tempfile.TemporaryDirectory() as proj:
            files = _project_on_disk(proj)
            seen = []

            class _Spy(Gateway):
                def model_call(self, messages, route):
                    seen.append("\n".join(m["content"] for m in messages))
                    return super().model_call(messages, route)

            run(
                parse("Build a Node CLI", task_id="t-loop2", mode="write"),
                vault=vault,
                tier1_commands=["true"],
                tier1_cwd=proj,
                post_dispatch=lambda c: {"files_written": files, "rejected": []},
                gateway=_Spy(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2),
                model=_fake_model("FILE: package.json\n```json\n{}\n```"),
                record_training=False,
            )
            judge_prompts = [s for s in seen if "WHAT THIS RUN ACTUALLY PRODUCED" in s]
            self.assertTrue(judge_prompts, "the judge was never shown the evidence")
            self.assertIn("bin/vault-report.js", judge_prompts[0])
            self.assertIn("RAN AND PASSED", judge_prompts[0])
            self.assertIn("`true`", judge_prompts[0])


class TestOtherRunShapes(unittest.TestCase):
    """(3) The same blindness elsewhere: `run` and `team`."""

    def test_a_plain_run_shows_the_judge_its_real_tier1_outcome(self):
        from scprism_engine.loop import run

        with tempfile.TemporaryDirectory() as vault:
            seen = []

            class _Spy(Gateway):
                def model_call(self, messages, route):
                    seen.append("\n".join(m["content"] for m in messages))
                    return super().model_call(messages, route)

            run(
                parse("summarise the log", task_id="t-run"),
                vault=vault,
                tier1_commands=["true"],
                tier1_cwd=".",
                gateway=_Spy(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2),
                record_training=False,
            )
            judge = [s for s in seen if "WHAT THIS RUN ACTUALLY PRODUCED" in s]
            self.assertTrue(judge)
            # No project files on this shape — said out loud, never left to infer.
            self.assertIn("FILES WRITTEN: none", judge[0])
            self.assertIn("RAN AND PASSED", judge[0])

    def test_a_team_run_tells_the_judge_its_tier1_was_skipped(self):
        ev = evals.build_evidence(
            tier1_result=Tier1Result(
                passed=True, commands=[], tokens=0, skipped=True,
                skip_reason="skipped — a team conversation has no codebase to check.",
            ),
            files_written=[],
        )
        block = evals.format_evidence(ev)
        self.assertIn("SKIPPED", block)
        self.assertIn("A skip is NOT a pass", block)
        self.assertIn("FILES WRITTEN: none", block)


class TestObservabilityOutcomes(unittest.TestCase):
    def test_outcome_stats_separate_attention_from_failure(self):
        from scprism_engine import observability

        spans = [
            {"run_id": "r1", "type": "run", "start": 1.0, "attrs": {"task_id": "a"}},
            {"run_id": "r1", "type": "verdict", "name": "verdict", "start": 1.1,
             "attrs": {"passed": False, "outcome": "attention"}},
            {"run_id": "r2", "type": "run", "start": 2.0, "attrs": {"task_id": "b"}},
            {"run_id": "r2", "type": "verdict", "name": "verdict", "start": 2.1,
             "attrs": {"passed": False, "outcome": "failed"}},
            {"run_id": "r2", "type": "verdict", "name": "tier2", "start": 2.05,
             "attrs": {"passed": False, "contradictions": ["judge claimed 'truncat'"]}},
            {"run_id": "r3", "type": "run", "start": 3.0, "attrs": {"task_id": "c"}},
            {"run_id": "r3", "type": "verdict", "name": "verdict", "start": 3.1,
             "attrs": {"passed": True, "outcome": "passed"}},
        ]
        stats = observability.outcome_stats(spans)
        self.assertEqual(stats["passed"], 1)
        self.assertEqual(stats["attention"], 1)
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(stats["judge_contradicted"], 1)

    def test_replied_is_its_own_bucket_not_unknown(self):
        from scprism_engine import observability

        spans = [
            {"run_id": "r1", "type": "run", "start": 1.0, "attrs": {"task_id": "a"}},
            {"run_id": "r1", "type": "verdict", "name": "verdict", "start": 1.1,
             "attrs": {"passed": True, "outcome": "replied"}},
        ]
        stats = observability.outcome_stats(spans)
        self.assertEqual(stats["replied"], 1)
        self.assertEqual(stats["unknown"], 0)
        self.assertEqual(stats["total"], 1)

    def test_runs_recorded_before_outcome_existed_are_unknown_not_failed(self):
        from scprism_engine import observability

        spans = [
            {"run_id": "r1", "type": "run", "start": 1.0, "attrs": {"task_id": "a"}},
            {"run_id": "r1", "type": "verdict", "name": "verdict", "start": 1.1,
             "attrs": {"passed": False}},
        ]
        stats = observability.outcome_stats(spans)
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(stats["unknown"], 1)


if __name__ == "__main__":
    unittest.main()
