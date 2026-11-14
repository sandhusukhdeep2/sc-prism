"""The reviewer is told which task-named files a step left UNCHANGED (2026-11-14).

Seen in the installed app: a step asked to "Rewrite hello.md" wrote
``<project>/projects/hello-crew/hello.md`` — a NEW file, in a nested copy of
the project's own path — and left ``hello.md`` untouched. The reviewer was
shown the new file's content, scored the run 1.00, and the project was marked
done. A false done.

The path cause is fixed at the write (``_within_project``). This is the
general half. The reviewer judges a run from what it is shown, and it was
never shown the one fact that mattered: the file the task NAMED is exactly as
it was. So the measured record now carries, for every project step,

  * which of the files it wrote are NEW (did not exist before this step), and
  * which files the task names that existed before the step and were NOT
    written by it,

and the evidence block states both — as fact, read from disk, at zero tokens.
The engine still never edits its reviewer's marks; it stops asking it to judge
blind.
"""
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import evals
from scprism_engine import loop as loop_module
from scprism_engine.dispatcher import ModelResult
from scprism_engine.project import run_project
from scprism_engine.verifier import Tier1Result


def _fake_model(text):
    def _call(prompt: str, route: str) -> ModelResult:
        return ModelResult(text=text, tokens=max(1, len(text) // 4), route=route)

    return _call


def _project_dict(verdict) -> dict:
    return (verdict.extras or {}).get("project", {})


def _folder_with(files):
    root = tempfile.mkdtemp()
    for rel, body in files.items():
        dest = os.path.join(root, rel)
        os.makedirs(os.path.dirname(dest) or root, exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(body)
    return root


def _block(path, body="Hello, crew.\n"):
    return f"===FILE: {path}===\n{body}===END==="


class TestStepLedgerSaysWhatWasCreatedAndWhatWasLeft(unittest.TestCase):
    """`post()` measures both facts before and after the write."""

    def _run(self, intent, files, completion):
        root = _folder_with(files)
        vault = tempfile.mkdtemp()
        verdict = run_project(intent, project_dir=root, vault=vault, model=_fake_model(completion))
        return root, verdict

    def test_a_named_file_left_alone_beside_a_new_file_is_recorded(self):
        root, verdict = self._run(
            "Rewrite hello.md as a warm two-line greeting to the crew",
            {"hello.md": "old greeting\n"},
            _block("notes/hello.md"),
        )
        info = _project_dict(verdict)
        self.assertEqual(info.get("files_written"), ["notes/hello.md"])
        self.assertEqual(info.get("created"), ["notes/hello.md"])
        self.assertEqual(info.get("named_unchanged"), ["hello.md"])
        # And the named file really is as it was.
        with open(os.path.join(root, "hello.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "old greeting\n")

    def test_writing_the_named_file_itself_leaves_nothing_to_report(self):
        _root, verdict = self._run(
            "Rewrite hello.md as a warm two-line greeting to the crew",
            {"hello.md": "old greeting\n"},
            _block("hello.md"),
        )
        info = _project_dict(verdict)
        self.assertEqual(info.get("files_written"), ["hello.md"])
        # Absent, not empty lists: a verdict with nothing to report is
        # byte-identical to one written before this record existed.
        self.assertNotIn("created", info)
        self.assertNotIn("named_unchanged", info)

    def test_a_new_file_the_task_asked_for_is_created_and_nothing_is_left(self):
        _root, verdict = self._run(
            "Add a changelog.md describing the first release",
            {"hello.md": "old greeting\n"},
            _block("changelog.md", "# Changelog\n"),
        )
        info = _project_dict(verdict)
        self.assertEqual(info.get("created"), ["changelog.md"])
        # hello.md exists but the task never named it: not this step's business.
        self.assertNotIn("named_unchanged", info)

    def test_a_named_file_is_only_reported_when_it_existed_before_the_step(self):
        _root, verdict = self._run(
            "Write hello.md, a greeting to the crew",
            {"README.md": "# demo\n"},
            _block("hello.md"),
        )
        info = _project_dict(verdict)
        self.assertEqual(info.get("created"), ["hello.md"])
        self.assertNotIn("named_unchanged", info)


    def test_only_the_step_names_count_not_the_project_goal_above_it(self):
        """The app sends "Project goal: …\\nStep N of M: …". A file the GOAL
        mentions is not one this STEP was asked to change, and reporting it as
        left alone on every step would teach the reviewer to ignore the line."""
        _root, verdict = self._run(
            "Project goal: keep README.md accurate for the crew\n"
            "Step 2 of 3: Rewrite hello.md as a warm two-line greeting",
            {"README.md": "# demo\n", "hello.md": "old greeting\n"},
            _block("hello.md"),
        )
        self.assertNotIn("named_unchanged", _project_dict(verdict))

    def test_a_step_that_names_two_files_and_changes_one_reports_the_other(self):
        _root, verdict = self._run(
            "Project goal: a small site\n"
            "Step 1 of 1: Update hello.md and README.md with the new team name",
            {"README.md": "# demo\n", "hello.md": "old greeting\n"},
            _block("hello.md"),
        )
        self.assertEqual(_project_dict(verdict).get("named_unchanged"), ["README.md"])


class TestTheReviewerIsShownIt(unittest.TestCase):
    """`format_evidence` states both facts; silence when there is nothing."""

    def setUp(self):
        self.root = _folder_with({"hello.md": "old greeting\n", "notes/hello.md": "Hello, crew.\n"})
        self.t1 = Tier1Result(passed=True, commands=[], skipped=True, skip_reason="no verify command")

    def _text(self, **kw):
        ev = evals.build_evidence(
            tier1_result=self.t1, files_written=["notes/hello.md"], root=self.root, **kw
        )
        return evals.format_evidence(ev)

    def test_a_new_file_is_marked_new(self):
        text = self._text(created=["notes/hello.md"])
        self.assertIn("notes/hello.md", text)
        self.assertIn("[NEW FILE — did not exist before this run]", text)

    def test_a_named_file_left_unchanged_is_stated_as_a_fact(self):
        text = self._text(created=["notes/hello.md"], named_unchanged=["hello.md"])
        self.assertIn("FILES THE TASK NAMES THAT THIS RUN DID NOT CHANGE", text)
        self.assertIn("- hello.md", text)
        self.assertIn("exactly as", text)

    def test_a_new_file_wearing_a_named_files_name_is_pointed_out(self):
        """The exact shape of the false done: same file name, different place."""
        text = self._text(created=["notes/hello.md"], named_unchanged=["hello.md"])
        self.assertIn("notes/hello.md has the same file name as hello.md", text)

    def test_two_different_names_are_not_called_a_misplacement(self):
        text = self._text(created=["notes/hello.md"], named_unchanged=["README.md"])
        self.assertIn("- README.md", text)
        self.assertNotIn("has the same file name as", text)

    def test_with_nothing_to_report_the_block_is_what_it_always_was(self):
        before = evals.format_evidence(
            evals.build_evidence(tier1_result=self.t1, files_written=["notes/hello.md"], root=self.root)
        )
        self.assertNotIn("NEW FILE", before)
        self.assertNotIn("DID NOT CHANGE", before)
        self.assertEqual(before, self._text(created=[], named_unchanged=[]))

    def test_the_block_still_fits_its_budget(self):
        many = [f"docs/file-{i}.md" for i in range(400)]
        text = self._text(created=["notes/hello.md"], named_unchanged=many)
        self.assertLessEqual(len(text), evals.JUDGE_EVIDENCE_CHAR_BUDGET)
        # A cut is named as ours, never left to look like fewer files.
        self.assertIn("more", text)


class TestTheLoopHandsItOver(unittest.TestCase):
    """End to end: what `post()` measured is what `build_evidence` is given."""

    def test_the_step_ledger_reaches_the_evidence(self):
        root = _folder_with({"hello.md": "old greeting\n"})
        vault = tempfile.mkdtemp()
        seen = {}
        real = evals.build_evidence

        def spy(**kw):
            seen.update(kw)
            return real(**kw)

        with mock.patch.object(loop_module.evals, "build_evidence", side_effect=spy):
            run_project(
                "Rewrite hello.md as a warm two-line greeting to the crew",
                project_dir=root,
                vault=vault,
                model=_fake_model(_block("notes/hello.md")),
            )
        self.assertEqual(seen.get("created"), ["notes/hello.md"])
        self.assertEqual(seen.get("named_unchanged"), ["hello.md"])


if __name__ == "__main__":
    unittest.main()
