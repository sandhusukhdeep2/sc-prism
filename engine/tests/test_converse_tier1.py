"""A conversation is not put through the project's checks (2026-11-15).

Seen in the installed app: "hello — one line please: are you there?", typed in
a project's room, was answered — and recorded as a FAILED run:

    tier-1 failed; tier-2 did not run (short-circuited); 1 governance block(s)

A chat turn in a project's room is launched with the user's verify command and
that project's folder (so a real change made there can be checked). The loop
ran the command for the chat turn too: `npm test`, in a folder with no
package.json, over a greeting. The reply was fine; the verdict said the run
failed its tests, the stop ratchet said "task not done", and the run went into
every pass rate as a failure.

A conversation writes nothing. The folder is exactly as it was before the
turn, so the gate has nothing of this run's to check — and on a real project
it would spend the whole test suite on every question asked in the room.
Tier-1 is skipped for a converse turn, out loud, with the commands it did not
run; a task in the same folder is still checked.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main

#: A verify command that fails wherever it runs — and leaves a mark if it ran.
FAILING = 'sh -c "touch ran-the-checks; exit 3"'


def _run_cli(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=False):
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
    text = out.getvalue().strip()
    return code, (json.loads(text) if text else None)


class AConversationIsNotGatedTest(unittest.TestCase):
    def setUp(self):
        self.proj = tempfile.mkdtemp()
        self.vault = tempfile.mkdtemp()
        with open(os.path.join(self.proj, "hello.md"), "w", encoding="utf-8") as fh:
            fh.write("Hello, crew.\n")

    def _run(self, intent, *mode):
        _code, verdict = _run_cli([
            "run", intent, "--vault", self.vault, *mode,
            "--project-dir", self.proj,
            "--tier1", FAILING, "--tier1-cwd", self.proj,
            "--no-skills", "--no-memory", "--no-vault-tools",
        ])
        return verdict

    def test_a_chat_turn_does_not_run_the_projects_checks(self):
        verdict = self._run("hello — are you there?", "--mode", "converse")
        self.assertFalse(
            os.path.exists(os.path.join(self.proj, "ran-the-checks")),
            "the verify command was run over a conversation",
        )
        t1 = verdict["tier1"]
        self.assertTrue(t1["skipped"], t1)
        self.assertTrue(t1["passed"], t1)
        self.assertEqual(t1["commands"], [])

    def test_the_skip_says_why_and_what_it_did_not_run(self):
        t1 = self._run("hello — are you there?", "--mode", "converse")["tier1"]
        self.assertIn("a conversation changes no files", t1["skip_reason"])
        self.assertEqual(t1["skipped_commands"], [FAILING])

    def test_a_chat_turn_is_not_failed_by_checks_that_would_have_failed(self):
        """(No model answers in this test, so the run still ends "the model
        never answered" — what matters is that the checks are not the reason,
        and the review was not short-circuited by them.)"""
        verdict = self._run("hello — are you there?", "--mode", "converse")
        self.assertNotIn("tier-1 failed", verdict.get("outcome_reason") or "")
        self.assertNotIn("short-circuited", verdict.get("outcome_reason") or "")
        # `blocks` is the list of governance blocks: the stop ratchet's "task
        # not done" over a failed gate was one of them.
        self.assertEqual(verdict.get("blocks") or [], [])

    def test_a_task_in_the_same_folder_is_still_checked(self):
        """The gate is skipped for what a conversation is, not for the folder."""
        verdict = self._run("Summarise hello.md in one line")
        self.assertTrue(os.path.exists(os.path.join(self.proj, "ran-the-checks")))
        self.assertFalse(verdict["tier1"]["passed"])
        self.assertFalse(verdict["tier1"]["skipped"])


if __name__ == "__main__":
    unittest.main()
