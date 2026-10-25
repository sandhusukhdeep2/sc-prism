import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import project as project_module
from scprism_engine.dispatcher import ModelResult
from scprism_engine.project import git_checkpoint, run_project


def make_fake_model(text):
    """Build a `dispatcher.ModelCall`-shaped callable: `(prompt, route) ->
    ModelResult`, always returning the same fixed completion text regardless
    of the prompt/route it is called with (dispatch calls it once per plan
    step; the FILE-block text must survive unchanged into post_dispatch)."""

    def _call(prompt: str, route: str) -> ModelResult:
        return ModelResult(text=text, tokens=max(1, len(text) // 4), route=route)

    return _call


def verdict_reason_text(verdict) -> str:
    """Every human-readable reason recorded on a (possibly failed) Verdict.

    A project-step failure is recorded as a synthetic Tier-1 command whose
    stderr carries the ProjectStepError reason — `Tier1Result.log` formats
    that into `verdict.tier1["log"]` (see writeback._tier1_summary), exactly
    mirroring how a real failed Tier-1 command's output would show up.
    """
    return verdict.tier1.get("log", "") or ""


def verdict_project_dict(verdict) -> dict:
    """The project-mode payload loop.run's post_dispatch seam attaches to
    the Verdict, at `verdict.extras["project"]`."""
    return (verdict.extras or {}).get("project", {})


def make_never_called_model():
    """A model callable that fails the test the instant it's invoked — used
    to assert engine-side refusals short-circuit BEFORE any model call."""

    def _call(prompt: str, route: str) -> ModelResult:
        raise AssertionError("model must not be called — refusal must happen first")

    return _call


def run_git(args, cwd):
    res = subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=30
    )
    assert res.returncode == 0, f"git {args} failed: {res.stderr or res.stdout}"
    return res.stdout


def init_repo_with_commit(path, filename="README.md", content="# repo\n"):
    run_git(["init", "-q"], path)
    with open(os.path.join(path, filename), "w") as f:
        f.write(content)
    run_git(["add", "-A"], path)
    run_git(
        ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "init"],
        path,
    )


class GitCheckpointTest(unittest.TestCase):
    def test_init_and_commit_then_skip_when_clean(self):
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "a.txt"), "w") as f:
            f.write("x")
        out = git_checkpoint(tmp, "scprism: first")
        self.assertTrue(out.startswith("committed: "), out)
        # nothing changed → commit fails → skipped, never raises
        out2 = git_checkpoint(tmp, "scprism: empty")
        self.assertTrue(out2.startswith("skipped: "), out2)


class RunProjectTest(unittest.TestCase):
    def test_offline_stub_fails_with_no_file_blocks(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        verdict = run_project("build a page", project_dir=proj, vault=vault)
        self.assertFalse(verdict.passed)
        self.assertIn("never answered", verdict_reason_text(verdict))

    def test_fake_model_writes_files_checkpoints_and_passes(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        fake = make_fake_model("===FILE: index.html===\n<html/>\n===END===\nDone.")
        verdict = run_project(
            "build a page", project_dir=proj, vault=vault, model=fake
        )
        self.assertTrue(verdict.passed)
        self.assertTrue(os.path.exists(os.path.join(proj, "index.html")))
        info = verdict_project_dict(verdict)
        self.assertEqual(info["files_written"], ["index.html"])
        self.assertTrue(info["git_checkpoint"].startswith("committed: "))
        log = subprocess.run(
            ["git", "log", "--oneline"], cwd=proj, capture_output=True, text=True
        )
        self.assertIn("scprism: build a page", log.stdout)

    def test_verify_command_runs_in_project_dir(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        fake = make_fake_model("===FILE: ok.txt===\nok\n===END===")
        verdict = run_project(
            "write ok.txt", project_dir=proj, vault=vault, model=fake,
            verify_command="test -f ok.txt",
        )
        self.assertTrue(verdict.passed)

    def test_git_checkpoint_persisted_to_disk_on_pass(self):
        """Regression test for FIX 1: git_checkpoint must be written to the
        durable verdict JSON on disk, not just the in-memory verdict.
        After a passing run_project, read the verdict JSON from disk and
        assert that git_checkpoint is present and starts with 'committed: '."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        fake = make_fake_model("===FILE: test.txt===\ntest\n===END===")
        verdict = run_project(
            "write test file", project_dir=proj, vault=vault, model=fake
        )
        self.assertTrue(verdict.passed)

        # Read the verdict JSON from disk
        verdict_path = os.path.join(vault, "verdicts", f"{verdict.task_id}.json")
        self.assertTrue(os.path.exists(verdict_path), f"Verdict file not found: {verdict_path}")

        with open(verdict_path, "r") as f:
            disk_verdict = json.load(f)

        # Assert git_checkpoint is present in the durable verdict
        self.assertIn("extras", disk_verdict)
        self.assertIn("project", disk_verdict["extras"])
        self.assertIn("git_checkpoint", disk_verdict["extras"]["project"])
        self.assertTrue(
            disk_verdict["extras"]["project"]["git_checkpoint"].startswith("committed: "),
            f"git_checkpoint not persisted correctly: {disk_verdict['extras']['project']['git_checkpoint']}"
        )

    def test_real_repo_with_commits_refuses_before_model_call(self):
        """FIX 3 (v2 final review): NEW-mode owns FRESH directories only. If
        `project_dir` already exists AND is a real git work tree AND has
        commit history, this is someone's actual repo — proceeding as
        new-mode would `os.makedirs` into it (harmlessly, since it already
        exists) and then have the model write/overwrite files with no
        branch-per-run safety net at all. Fail closed before any model call;
        point the caller at Attach existing instead."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "add app.py", project_dir=proj, vault=vault, model=never_called
        )
        self.assertFalse(verdict.passed)
        self.assertIn(
            "this folder is already a git repository with history — use Attach existing instead",
            verdict_reason_text(verdict),
        )

    def test_two_successive_new_mode_runs_on_same_dir_step2_passes(self):
        """FIX A (v2 final review re-verdict): THE MISSING REGRESSION. A
        multi-step NEW-mode project runs run_project once per plan step on
        the SAME dir: step 1 passes -> git_checkpoint inits + commits the
        dir (as engine@scprism.local) -> step 2's call finds "a git repo
        with history". The guard must recognize scprism's OWN checkpoint
        history (root commit author identity) and proceed — refusing here
        bricks every multi-step new project after its first passing step."""
        parent = tempfile.mkdtemp()
        proj = os.path.join(parent, "proj")
        vault = tempfile.mkdtemp()
        fake1 = make_fake_model("===FILE: step1.txt===\none\n===END===")
        v1 = run_project("step 1", project_dir=proj, vault=vault, model=fake1)
        self.assertTrue(v1.passed, verdict_reason_text(v1))
        self.assertTrue(
            verdict_project_dict(v1)["git_checkpoint"].startswith("committed: ")
        )
        fake2 = make_fake_model("===FILE: step2.txt===\ntwo\n===END===")
        v2 = run_project("step 2", project_dir=proj, vault=vault, model=fake2)
        self.assertTrue(v2.passed, verdict_reason_text(v2))
        self.assertTrue(os.path.exists(os.path.join(proj, "step2.txt")))

    def test_foreign_root_author_still_refused(self):
        """FIX A companion: the discriminator is the ROOT commit author —
        a repo whose first commit was authored by anyone other than
        engine@scprism.local stays refused, even if later history varies."""
        proj = tempfile.mkdtemp()
        run_git(["init", "-q"], proj)
        with open(os.path.join(proj, "README.md"), "w") as f:
            f.write("# theirs\n")
        run_git(["add", "-A"], proj)
        run_git(
            ["-c", "user.name=someone", "-c", "user.email=someone@else",
             "commit", "-q", "-m", "their init"],
            proj,
        )
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "add app.py", project_dir=proj, vault=vault, model=never_called
        )
        self.assertFalse(verdict.passed)
        self.assertIn("use Attach existing instead", verdict_reason_text(verdict))

    def test_git_error_during_ownership_check_fails_closed_to_refusal(self):
        """FIX A: if the root-commit-author probe itself errors, the dir is
        foreign until proven ours — refuse (with the git reason appended),
        never silently proceed. Forces the error by raising TimeoutExpired
        for exactly the `git log --max-parents=0` invocation (same targeted
        subprocess-patch pattern as GitMergeExceptionArmTest in
        test_project_existing.py); everything else runs real git."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()

        real_run = subprocess.run

        def fake_run(args, **kwargs):
            if isinstance(args, list) and "--max-parents=0" in args:
                raise subprocess.TimeoutExpired(cmd=args, timeout=30)
            return real_run(args, **kwargs)

        with mock.patch.object(project_module.subprocess, "run", side_effect=fake_run):
            verdict = run_project(
                "add app.py", project_dir=proj, vault=vault, model=never_called
            )

        self.assertFalse(verdict.passed)
        reason = verdict_reason_text(verdict)
        self.assertIn("use Attach existing instead", reason)
        self.assertIn("timed out", reason)

    def test_fresh_dir_unaffected_still_passes(self):
        """A brand-new (non-existent-yet) directory is exactly what v1's
        acceptance flows target — unaffected by the FIX 3 guard."""
        parent = tempfile.mkdtemp()
        proj = os.path.join(parent, "brand-new")
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project("add app.py", project_dir=proj, vault=vault, model=fake)
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertTrue(os.path.exists(os.path.join(proj, "app.py")))

    def test_existing_dir_with_no_commits_unaffected(self):
        """A git-inited-but-never-committed dir (or a plain non-git dir) has
        no history to protect — the FIX 3 guard must not fire."""
        proj = tempfile.mkdtemp()
        run_git(["init", "-q"], proj)
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project("add app.py", project_dir=proj, vault=vault, model=fake)
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))

    def test_single_log_line_per_passing_step(self):
        """Regression test for E2: run_project's git-checkpoint re-persist
        must NOT append a second log.md line for the same task_id. loop.run
        already writes one line via write_verdict; the re-persist (to attach
        git_checkpoint) must update the verdict JSON only."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        fake = make_fake_model("===FILE: index.html===\n<html/>\n===END===")
        verdict = run_project(
            "write a page", project_dir=proj, vault=vault, model=fake
        )
        self.assertTrue(verdict.passed)

        log_path = os.path.join(vault, "log.md")
        self.assertTrue(os.path.exists(log_path))
        with open(log_path, "r") as f:
            lines = f.readlines()
        matching = [ln for ln in lines if f"`{verdict.task_id}`" in ln]
        self.assertEqual(
            len(matching), 1,
            f"expected exactly one log.md line for {verdict.task_id!r}, got {len(matching)}: {matching}",
        )

    def test_fresh_project_dir_is_created_before_writes(self):
        """Regression test for E1: a brand-new project dir (not yet on disk)
        must be created BEFORE the write/verify loop runs, or
        validate_project_path rejects every write with 'path resolves
        outside the project' (the parent-walk finds an existing ancestor
        above the nonexistent project_dir and treats it as outside)."""
        parent = tempfile.mkdtemp()
        proj = os.path.join(parent, "brand-new-project")
        vault = tempfile.mkdtemp()
        self.assertFalse(os.path.exists(proj))
        fake = make_fake_model("===FILE: index.html===\n<html/>\n===END===")
        verdict = run_project(
            "build a page", project_dir=proj, vault=vault, model=fake
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertTrue(os.path.isdir(proj))
        self.assertTrue(os.path.exists(os.path.join(proj, "index.html")))

    def test_instruction_echo_blocks_are_ignored(self):
        """Regression test for FIX 2: a parroting model returning ONLY the
        instruction-example block should fail with 'instruction echo' error.
        The instruction example is:
            ===FILE: relative/path.ext===
            <full file content>
            ===END===
        A model that echoes only this should be rejected as no real file blocks."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        # The exact instruction example from the prompt
        instruction_example = (
            "===FILE: relative/path.ext===\n"
            "<full file content>\n"
            "===END==="
        )
        fake = make_fake_model(instruction_example)
        verdict = run_project(
            "write a file", project_dir=proj, vault=vault, model=fake
        )
        # Should fail because the instruction example is not a real file block
        self.assertFalse(verdict.passed)
        reason = verdict_reason_text(verdict)
        self.assertIn("instruction echo", reason,
                     f"Expected 'instruction echo' in reason, got: {reason}")


if __name__ == "__main__":
    unittest.main()
