"""Task V2-2: CLI plumbing for existing-mode `project` runs + the
`project-merge` / `project-finish` subcommands.

Mirrors test_project_cli.py's `_run_cli` helper (main() through stdout/stderr
capture) and test_project_existing.py's real-temp-git-repo helpers (CONTEXT
§engine — no mocked git, real subprocess `git` calls).
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main


def _run_cli(argv):
    """Invoke the CLI, capturing (exit_code, parsed_stdout_json)."""
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    parsed = json.loads(text) if text else None
    return code, parsed


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


def current_branch(path):
    return run_git(["branch", "--show-current"], path).strip()


class TestProjectExistingCLI(unittest.TestCase):
    """`project --existing`/`--slug` plumbing through to run_project()."""

    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self._tmp_vault = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name
        self.vault = self._tmp_vault.name

    def tearDown(self):
        self._tmp_proj.cleanup()
        self._tmp_vault.cleanup()

    def test_existing_on_no_commits_dir_offline_stub_fails_with_branch_extras(self):
        """A REAL no-commits temp dir (plain, not even git-inited yet) run
        through `--existing` with the offline stub model: the pre-flight
        `git init`s it, finds zero commits, and runs like new-mode (no
        branching) — but because existing_mode=True, the FAILING verdict
        still re-persists extras with base_branch/run_branch reported ''."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--existing",
            "--slug", "myproj",
        ])
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)
        info = (obj.get("extras") or {}).get("project") or {}
        self.assertIn("base_branch", info)
        self.assertEqual(info.get("base_branch"), "")
        self.assertEqual(info.get("run_branch"), "")

    def test_run_branch_flag_accepted_in_no_commits_run(self):
        """V2-5: `--run-branch` is plumbed through to `run_project` without
        crashing. On a no-commits dir the pre-flight's branch logic never
        runs at all (byte-identical to the no-`--run-branch` case), so
        base_branch/run_branch still report '' regardless of the requested
        value — this test only pins that the flag is accepted end to end."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--existing",
            "--slug", "myproj",
            "--run-branch", "scprism/myproj-1",
        ])
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)
        info = (obj.get("extras") or {}).get("project") or {}
        self.assertEqual(info.get("run_branch"), "")

    def test_existing_defaults_to_false_when_omitted(self):
        """Without --existing, v1 new-project behavior is untouched: no
        'project' extras key at all on a raw offline-stub failure (mirrors
        test_project_existing.py's byte-identical-v1 regression)."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
        ])
        self.assertIsNotNone(obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)
        self.assertNotIn("project", obj.get("extras") or {})


class TestProjectMergeCLI(unittest.TestCase):
    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name

    def tearDown(self):
        self._tmp_proj.cleanup()

    def test_merge_happy_path_exits_0_ok_true(self):
        init_repo_with_commit(self.project_dir)
        base = current_branch(self.project_dir)
        run_git(["checkout", "-q", "-b", "scprism/x-1"], self.project_dir)
        with open(os.path.join(self.project_dir, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], self.project_dir)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local",
             "commit", "-q", "-m", "feature"],
            self.project_dir,
        )
        run_git(["checkout", "-q", base], self.project_dir)

        code, obj = _run_cli([
            "project-merge",
            "--project-dir", self.project_dir,
            "--branch", "scprism/x-1",
        ])
        self.assertEqual(code, 0)
        self.assertIsNotNone(obj)
        self.assertEqual(set(obj.keys()), {"ok", "detail"})
        self.assertTrue(obj["ok"], obj["detail"])
        self.assertTrue(os.path.exists(os.path.join(self.project_dir, "feature.txt")))

    def test_merge_missing_branch_exits_1_with_raw_git_reason(self):
        init_repo_with_commit(self.project_dir)
        code, obj = _run_cli([
            "project-merge",
            "--project-dir", self.project_dir,
            "--branch", "no-such-branch",
        ])
        self.assertEqual(code, 1)
        self.assertIsNotNone(obj)
        self.assertFalse(obj["ok"])
        # Honest git reason, not a mislabeled "conflict: ..." (V2-1 round 1 fix).
        self.assertFalse(obj["detail"].startswith("conflict:"), obj["detail"])
        self.assertIn("not something we can merge", obj["detail"])

    def test_merge_missing_branch_flag_is_argparse_error(self):
        init_repo_with_commit(self.project_dir)
        with self.assertRaises(SystemExit) as ctx:
            main(["project-merge", "--project-dir", self.project_dir])
        self.assertEqual(ctx.exception.code, 2)

    # FIX 1 (v2 final review — merge target guard): --into plumbed through to
    # git_merge_branch's new guard.
    def test_merge_into_wrong_current_branch_refused(self):
        init_repo_with_commit(self.project_dir)
        base = current_branch(self.project_dir)
        run_git(["checkout", "-q", "-b", "scprism/x-1"], self.project_dir)
        with open(os.path.join(self.project_dir, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], self.project_dir)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local",
             "commit", "-q", "-m", "feature"],
            self.project_dir,
        )
        # HEAD stays on scprism/x-1 — never checked back out to base.
        code, obj = _run_cli([
            "project-merge",
            "--project-dir", self.project_dir,
            "--branch", "scprism/x-1",
            "--into", base,
        ])
        self.assertEqual(code, 1)
        self.assertIsNotNone(obj)
        self.assertFalse(obj["ok"])
        self.assertIn("nothing to merge into", obj["detail"])
        self.assertEqual(current_branch(self.project_dir), "scprism/x-1")

    def test_merge_into_correct_base_exits_0_ok_true(self):
        init_repo_with_commit(self.project_dir)
        base = current_branch(self.project_dir)
        run_git(["checkout", "-q", "-b", "scprism/x-1"], self.project_dir)
        with open(os.path.join(self.project_dir, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], self.project_dir)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local",
             "commit", "-q", "-m", "feature"],
            self.project_dir,
        )
        run_git(["checkout", "-q", base], self.project_dir)

        code, obj = _run_cli([
            "project-merge",
            "--project-dir", self.project_dir,
            "--branch", "scprism/x-1",
            "--into", base,
        ])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"], obj["detail"])
        self.assertTrue(os.path.exists(os.path.join(self.project_dir, "feature.txt")))

    def test_merge_omitting_into_flag_is_unchanged_v1_behavior(self):
        """Default '' (flag omitted) never gates on current branch."""
        init_repo_with_commit(self.project_dir)
        base = current_branch(self.project_dir)
        run_git(["checkout", "-q", "-b", "scprism/x-1"], self.project_dir)
        with open(os.path.join(self.project_dir, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], self.project_dir)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local",
             "commit", "-q", "-m", "feature"],
            self.project_dir,
        )
        run_git(["checkout", "-q", base], self.project_dir)

        code, obj = _run_cli([
            "project-merge",
            "--project-dir", self.project_dir,
            "--branch", "scprism/x-1",
        ])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"], obj["detail"])


class TestProjectFinishCLI(unittest.TestCase):
    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name

    def tearDown(self):
        self._tmp_proj.cleanup()

    def test_finish_returns_to_base_exits_0(self):
        init_repo_with_commit(self.project_dir)
        base = current_branch(self.project_dir)
        run_git(["checkout", "-q", "-b", "scprism/myproj-1"], self.project_dir)
        with open(os.path.join(self.project_dir, "mid.txt"), "w") as f:
            f.write("mid-step leftovers")

        code, obj = _run_cli([
            "project-finish",
            "--project-dir", self.project_dir,
            "--base", base,
        ])
        self.assertEqual(code, 0)
        self.assertIsNotNone(obj)
        self.assertEqual(set(obj.keys()), {"ok", "detail"})
        self.assertTrue(obj["ok"], obj["detail"])
        self.assertEqual(current_branch(self.project_dir), base)


if __name__ == "__main__":
    unittest.main()
