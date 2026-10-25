"""Task V2-1: existing-repo mode — branch-per-run git lifecycle.

Real temp git repos via subprocess `git` (mirrors GitCheckpointTest's style
in test_project_runner.py, per CONTEXT §engine). Covers: the low-level git
helpers, `repo_outline`, `run_project(existing_mode=True, ...)`'s full
lifecycle (dirty refusal / clean branch-per-run / resume / no-commits), and
`project_finish`.
"""

import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import project as project_module
from scprism_engine.dispatcher import ModelResult
from scprism_engine.project import (
    git_branch_exists,
    git_checkout,
    git_checkout_new_branch,
    git_current_branch,
    git_has_commits,
    git_is_dirty,
    git_merge_branch,
    next_run_branch,
    project_finish,
    repo_outline,
    run_project,
)


def make_fake_model(text):
    """Same shape as test_project_runner's helper: a `dispatcher.ModelCall`
    that always returns the same fixed completion, regardless of prompt."""

    def _call(prompt: str, route: str) -> ModelResult:
        return ModelResult(text=text, tokens=max(1, len(text) // 4), route=route)

    return _call


def make_never_called_model():
    """A model callable that fails the test the instant it's invoked — used
    to assert engine-side refusals (missing dir, dirty tree, branch-create
    failure) short-circuit BEFORE any model call."""

    def _call(prompt: str, route: str) -> ModelResult:
        raise AssertionError("model must not be called — refusal must happen first")

    return _call


def verdict_reason_text(verdict) -> str:
    return verdict.tier1.get("log", "") or ""


def verdict_project_dict(verdict) -> dict:
    return (verdict.extras or {}).get("project", {})


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


def is_clean(path):
    return run_git(["status", "--porcelain"], path).strip() == ""


class GitHelpersTest(unittest.TestCase):
    def test_current_branch_on_fresh_repo(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        ok, branch = git_current_branch(tmp)
        self.assertTrue(ok)
        self.assertEqual(branch, current_branch(tmp))

    def test_current_branch_not_a_repo(self):
        tmp = tempfile.mkdtemp()
        ok, reason = git_current_branch(tmp)
        self.assertFalse(ok)
        self.assertTrue(reason)

    def test_is_dirty_reports_clean_and_dirty(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        ok, detail = git_is_dirty(tmp)
        self.assertTrue(ok)
        self.assertEqual(detail, "clean")
        with open(os.path.join(tmp, "new.txt"), "w") as f:
            f.write("x")
        ok, detail = git_is_dirty(tmp)
        self.assertTrue(ok)
        self.assertEqual(detail, "dirty")

    def test_is_dirty_never_raises_on_non_repo(self):
        tmp = tempfile.mkdtemp()
        ok, detail = git_is_dirty(tmp)
        self.assertFalse(ok)
        self.assertTrue(detail)

    def test_checkout_new_branch_and_current(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        ok, detail = git_checkout_new_branch(tmp, "scprism/foo-1")
        self.assertTrue(ok, detail)
        self.assertEqual(current_branch(tmp), "scprism/foo-1")

    def test_checkout_switches_branch(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        git_checkout_new_branch(tmp, "scprism/foo-1")
        ok, detail = git_checkout(tmp, base)
        self.assertTrue(ok, detail)
        self.assertEqual(current_branch(tmp), base)

    def test_has_commits_true_and_false(self):
        tmp = tempfile.mkdtemp()
        run_git(["init", "-q"], tmp)
        self.assertFalse(git_has_commits(tmp))
        with open(os.path.join(tmp, "a.txt"), "w") as f:
            f.write("x")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "x"],
            tmp,
        )
        self.assertTrue(git_has_commits(tmp))

    def test_next_run_branch_starts_at_1(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        self.assertEqual(next_run_branch(tmp, "myslug"), "scprism/myslug-1")

    def test_next_run_branch_increments_past_existing(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        git_checkout_new_branch(tmp, "scprism/myslug-1")
        git_checkout(tmp, "master" if "master" in run_git(["branch"], tmp) else current_branch(tmp))
        # Create branches 1 and 3 explicitly (gap), expect next = 4.
        base = current_branch(tmp)
        run_git(["branch", "scprism/myslug-3"], tmp)
        self.assertEqual(next_run_branch(tmp, "myslug"), "scprism/myslug-4")

    def test_next_run_branch_ignores_other_slugs(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        run_git(["branch", "scprism/other-9"], tmp)
        self.assertEqual(next_run_branch(tmp, "myslug"), "scprism/myslug-1")

    def test_branch_exists_true_for_a_real_local_branch(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        git_checkout_new_branch(tmp, "scprism/myproj-1")
        self.assertTrue(git_branch_exists(tmp, "scprism/myproj-1"))

    def test_branch_exists_false_for_a_missing_branch(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        self.assertFalse(git_branch_exists(tmp, "scprism/no-such-branch"))

    def test_branch_exists_never_raises_on_non_repo(self):
        tmp = tempfile.mkdtemp()
        self.assertFalse(git_branch_exists(tmp, "anything"))


class GitMergeTest(unittest.TestCase):
    def test_merge_happy_path(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        git_checkout_new_branch(tmp, "scprism/x-1")
        with open(os.path.join(tmp, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "feature"],
            tmp,
        )
        git_checkout(tmp, base)
        ok, detail = git_merge_branch(tmp, "scprism/x-1")
        self.assertTrue(ok, detail)
        self.assertTrue(os.path.exists(os.path.join(tmp, "feature.txt")))

    def test_merge_missing_branch_reports_git_reason_not_conflict(self):
        """A non-conflict merge failure (branch doesn't exist) must report
        the real git reason, NOT a mislabeled 'conflict: …' — and must leave
        the tree clean either way."""
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        ok, reason = git_merge_branch(tmp, "no-such-branch")
        self.assertFalse(ok)
        self.assertFalse(reason.startswith("conflict:"), reason)
        self.assertIn("not something we can merge", reason)
        self.assertEqual(run_git(["status", "--porcelain"], tmp).strip(), "")

    def test_merge_conflict_aborts_and_leaves_tree_clean(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp, filename="shared.txt", content="base\n")
        base = current_branch(tmp)
        git_checkout_new_branch(tmp, "scprism/x-1")
        with open(os.path.join(tmp, "shared.txt"), "w") as f:
            f.write("from branch\n")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "branch change"],
            tmp,
        )
        git_checkout(tmp, base)
        with open(os.path.join(tmp, "shared.txt"), "w") as f:
            f.write("from base\n")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "base change"],
            tmp,
        )
        ok, reason = git_merge_branch(tmp, "scprism/x-1")
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("conflict:"), reason)
        self.assertEqual(run_git(["status", "--porcelain"], tmp).strip(), "")
        self.assertEqual(current_branch(tmp), base)


class GitMergeIntoGuardTest(unittest.TestCase):
    """FIX 1 (v2 final review): `git_merge_branch(..., into=)` must refuse to
    merge unless the repo is ACTUALLY checked out on `into` — closes the
    self-merge/wrong-branch hole where an interrupted run (repo left on
    scprism/x-1) would silently self-merge (or merge into whatever branch
    happens to be checked out) while reporting ok:true, and the client would
    then clear runBranch believing the work landed on base."""

    def _make_mergeable_branch(self, tmp):
        git_checkout_new_branch(tmp, "scprism/x-1")
        with open(os.path.join(tmp, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "feature"],
            tmp,
        )

    def test_self_merge_on_run_branch_refused(self):
        """Repo interrupted mid-run, still checked out on the run branch
        itself: merging «x-1» "into base" while HEAD is still on x-1 must be
        refused, not silently no-op ok:true."""
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        self._make_mergeable_branch(tmp)
        # HEAD stays on scprism/x-1 (never checked back out to base) —
        # mirrors the interrupted-run scenario from the bug report.
        ok, reason = git_merge_branch(tmp, "scprism/x-1", into=base)
        self.assertFalse(ok)
        self.assertIn("nothing to merge into", reason)
        self.assertEqual(current_branch(tmp), "scprism/x-1")

    def test_checked_out_on_other_branch_refused(self):
        """An external checkout to some THIRD branch (neither base nor the
        run branch) must never let the merge land there."""
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        self._make_mergeable_branch(tmp)
        git_checkout(tmp, base)
        git_checkout_new_branch(tmp, "unrelated")
        ok, reason = git_merge_branch(tmp, "scprism/x-1", into=base)
        self.assertFalse(ok)
        self.assertIn(f"checked out on «unrelated», not «{base}»", reason)
        self.assertIn("check out", reason)
        self.assertEqual(current_branch(tmp), "unrelated")
        self.assertFalse(os.path.exists(os.path.join(tmp, "feature.txt")))

    def test_on_correct_base_merges(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        self._make_mergeable_branch(tmp)
        git_checkout(tmp, base)
        ok, detail = git_merge_branch(tmp, "scprism/x-1", into=base)
        self.assertTrue(ok, detail)
        self.assertTrue(os.path.exists(os.path.join(tmp, "feature.txt")))

    def test_into_empty_default_is_unchanged_v1_behavior(self):
        """Omitting `into` (the default '') never gates on current branch at
        all — byte-identical to the pre-fix signature."""
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        self._make_mergeable_branch(tmp)
        git_checkout(tmp, base)
        ok, detail = git_merge_branch(tmp, "scprism/x-1")
        self.assertTrue(ok, detail)


class GitMergeExceptionArmTest(unittest.TestCase):
    """H1 (V2-2 carried hardening): the exception arm (TimeoutExpired/OSError
    from the merge subprocess call itself) must fold in the SAME best-effort
    `merge --abort` + `git_is_dirty` re-check the rc!=0 arm already has —
    otherwise a merge killed mid-conflict can leave MERGE_HEAD/markers behind
    with nobody the wiser.

    Forcing a REAL subprocess timeout deterministically isn't practical here,
    so per the brief this patches the `subprocess` module as seen from
    project_module (`mock.patch.object(project_module.subprocess, "run",
    ...)`) with a wrapper that raises `TimeoutExpired` ONLY for the merge
    invocation itself (matched on the unique `--no-edit` flag) — the abort
    call and the `git_is_dirty` status call underneath fall through to the
    REAL `subprocess.run` unmodified, so the dirty-tree recheck this test
    verifies is exercising real git, not a mock. (Broader than the usual
    private-helper patching elsewhere in the suite, e.g. test_gateway_retry's
    `gw_module._sleep` — justified here because the timeout lives inside
    `subprocess.run` itself and there is no seam between it and the merge.)
    """

    def test_timeout_during_merge_reports_dirty_tree_honestly(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        git_checkout_new_branch(tmp, "scprism/x-1")
        with open(os.path.join(tmp, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "feature"],
            tmp,
        )
        git_checkout(tmp, base)
        # Dirty the tree BEFORE the (mocked-timeout) merge call, independent
        # of the merge itself, so the except arm's dirty recheck has
        # something honest to find and report — proving the recheck runs at
        # all, not just that it returns "clean" trivially.
        with open(os.path.join(tmp, "unrelated.txt"), "w") as f:
            f.write("dirty leftover, unrelated to the merge")

        real_run = subprocess.run

        def fake_run(args, **kwargs):
            if isinstance(args, list) and "--no-edit" in args:
                raise subprocess.TimeoutExpired(cmd=args, timeout=30)
            return real_run(args, **kwargs)

        with mock.patch.object(project_module.subprocess, "run", side_effect=fake_run):
            ok, reason = git_merge_branch(tmp, "scprism/x-1")

        self.assertFalse(ok)
        self.assertIn("merge left the tree dirty — resolve manually:", reason)
        # The original TimeoutExpired detail is still honestly included.
        self.assertIn("timed out", reason)
        # Never on the target branch — the merge attempt never even started.
        self.assertEqual(current_branch(tmp), base)

    def test_timeout_during_merge_with_clean_tree_reports_raw_exception(self):
        """Same forced timeout, but nothing else dirtied the tree first —
        the abort no-ops (no merge was ever in progress) and the recheck
        finds a clean tree, so the plain exception string is returned (no
        bogus 'dirty' framing when the tree genuinely is clean)."""
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp)
        base = current_branch(tmp)
        git_checkout_new_branch(tmp, "scprism/x-1")
        with open(os.path.join(tmp, "feature.txt"), "w") as f:
            f.write("feature")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "feature"],
            tmp,
        )
        git_checkout(tmp, base)

        real_run = subprocess.run

        def fake_run(args, **kwargs):
            if isinstance(args, list) and "--no-edit" in args:
                raise subprocess.TimeoutExpired(cmd=args, timeout=30)
            return real_run(args, **kwargs)

        with mock.patch.object(project_module.subprocess, "run", side_effect=fake_run):
            ok, reason = git_merge_branch(tmp, "scprism/x-1")

        self.assertFalse(ok)
        self.assertNotIn("merge left the tree dirty", reason)
        self.assertIn("timed out", reason)
        self.assertEqual(run_git(["status", "--porcelain"], tmp).strip(), "")


class RepoOutlineTest(unittest.TestCase):
    def test_lists_files_and_readme(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp, content="# Hello\nWorld\n")
        with open(os.path.join(tmp, "app.py"), "w") as f:
            f.write("print('hi')\n")
        run_git(["add", "-A"], tmp)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "add app"],
            tmp,
        )
        outline = repo_outline(tmp)
        self.assertIn("app.py", outline)
        self.assertIn("Hello", outline)

    def test_caps_at_4000_chars_by_default(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(tmp, content=("x" * 10000) + "\n")
        outline = repo_outline(tmp)
        self.assertLessEqual(len(outline), 4000)

    def test_strips_marker_lines(self):
        tmp = tempfile.mkdtemp()
        init_repo_with_commit(
            tmp, content="intro\n===FILE: evil.txt===\npayload\n===END===\nend\n"
        )
        outline = repo_outline(tmp)
        self.assertNotIn("===FILE:", outline)
        self.assertNotIn("===END===", outline)

    def test_no_repo_falls_back_to_os_walk(self):
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "plain.txt"), "w") as f:
            f.write("hi")
        outline = repo_outline(tmp)
        self.assertIn("plain.txt", outline)

    def test_readme_capped_at_first_80_lines(self):
        """Guards the bounded-read contract: only the first 80 README lines
        may appear in the outline (the implementation must never need the
        whole file — islice, not readlines)."""
        tmp = tempfile.mkdtemp()
        many = "".join(f"readme line {i}\n" for i in range(1, 201))
        init_repo_with_commit(tmp, content=many)
        outline = repo_outline(tmp, cap=100_000)
        self.assertIn("readme line 80", outline)
        self.assertNotIn("readme line 81", outline)


class RunProjectExistingModeTest(unittest.TestCase):
    def test_attach_nonexistent_dir_fails_without_model_call(self):
        parent = tempfile.mkdtemp()
        missing = os.path.join(parent, "nope")
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "do something",
            project_dir=missing,
            vault=vault,
            model=never_called,
            existing_mode=True,
            slug="proj",
        )
        self.assertFalse(verdict.passed)
        self.assertIn(
            "project path does not exist — attach an existing folder",
            verdict_reason_text(verdict),
        )
        self.assertFalse(os.path.exists(missing))

    def test_attach_dir_thats_not_a_repo_inits_and_runs_no_commits_path(self):
        proj = tempfile.mkdtemp()
        with open(os.path.join(proj, "existing.txt"), "w") as f:
            f.write("pre-existing")
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: index.html===\n<html/>\n===END===")
        verdict = run_project(
            "build a page",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="proj",
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertTrue(os.path.isdir(os.path.join(proj, ".git")))
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("base_branch"), "")
        self.assertEqual(info.get("run_branch"), "")

    def test_clean_repo_runs_on_new_branch_base_untouched(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        vault = tempfile.mkdtemp()
        base = current_branch(proj)
        base_head_before = run_git(["rev-parse", "HEAD"], proj).strip()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertEqual(current_branch(proj), "scprism/myproj-1")
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("base_branch"), base)
        self.assertEqual(info.get("run_branch"), "scprism/myproj-1")
        self.assertTrue(os.path.exists(os.path.join(proj, "app.py")))
        # Base branch's HEAD must be untouched by the run-branch commit.
        git_checkout(proj, base)
        self.assertEqual(run_git(["rev-parse", "HEAD"], proj).strip(), base_head_before)
        self.assertFalse(os.path.exists(os.path.join(proj, "app.py")))

    def test_clean_repo_extras_carry_overwrote_for_preexisting_file(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        # Pre-create a file the fake model will overwrite.
        with open(os.path.join(proj, "app.py"), "w") as f:
            f.write("old\n")
        run_git(["add", "-A"], proj)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "seed app.py"],
            proj,
        )
        vault = tempfile.mkdtemp()
        fake = make_fake_model(
            "===FILE: app.py===\nprint(2)\n===END===\n"
            "===FILE: new.py===\nprint(3)\n===END==="
        )
        verdict = run_project(
            "update app.py and add new.py",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        info = verdict_project_dict(verdict)
        self.assertEqual(sorted(info.get("overwrote", [])), ["app.py"])

    def test_dirty_tree_refuses_before_any_model_call(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        with open(os.path.join(proj, "dirty.txt"), "w") as f:
            f.write("uncommitted")
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=never_called,
            existing_mode=True,
            slug="myproj",
        )
        self.assertFalse(verdict.passed)
        self.assertIn(
            "working tree has uncommitted changes — commit or stash first",
            verdict_reason_text(verdict),
        )
        # Refusal happened before any branch was created.
        self.assertNotEqual(current_branch(proj), "scprism/myproj-1")

    def test_branch_create_failure_refuses_before_model_call(self):
        """CRITICAL regression: if `git checkout -b` fails (here: a branch
        literally named `scprism` makes refs/heads/scprism/<slug>-1
        uncreatable), the run must fail closed BEFORE any model call — never
        proceed on the user's base branch with extras reporting a run branch
        that was never created."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        base_head_before = run_git(["rev-parse", "HEAD"], proj).strip()
        run_git(["branch", "scprism"], proj)  # blocks the scprism/* namespace
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=never_called,
            existing_mode=True,
            slug="myproj",
        )
        self.assertFalse(verdict.passed)
        self.assertIn(
            "could not create run branch scprism/myproj-1:",
            verdict_reason_text(verdict),
        )
        # HEAD never moved and base history is untouched.
        self.assertEqual(current_branch(proj), base)
        self.assertEqual(run_git(["rev-parse", "HEAD"], proj).strip(), base_head_before)

    def test_resume_on_matching_branch_wip_commits_leftovers(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        git_checkout_new_branch(proj, "scprism/myproj-1")
        with open(os.path.join(proj, "leftover.txt"), "w") as f:
            f.write("leftover from a crashed step")
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project(
            "continue building",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        # Stayed on the SAME branch — never branched again.
        self.assertEqual(current_branch(proj), "scprism/myproj-1")
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("run_branch"), "scprism/myproj-1")
        # The leftover file was wip-committed (tree clean before the new step
        # wrote app.py) — verify it's present in history, not just on disk.
        log = run_git(["log", "--oneline"], proj)
        self.assertIn("wip (resumed)", log)

    def test_no_commits_repo_runs_without_branching(self):
        proj = tempfile.mkdtemp()
        run_git(["init", "-q"], proj)
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project(
            "bootstrap",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("base_branch"), "")
        self.assertEqual(info.get("run_branch"), "")

    def test_failed_verdict_in_existing_mode_still_reports_branches(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")
        verdict = run_project(
            "add app.py but fail verify",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
            verify_command="false",
        )
        self.assertFalse(verdict.passed)
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("base_branch"), base)
        self.assertEqual(info.get("run_branch"), "scprism/myproj-1")

    def test_detached_head_refuses_before_any_model_call(self):
        """FIX 2 (v2 final review): a repo WITH commits but `git branch
        --show-current` empty (detached HEAD) must fail closed before any
        model call — proceeding would silently branch off a HEAD with no
        name, and `base_branch` would report '' the same way the no-commits
        path does, hiding a real (if headless) checkout from the caller."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        head_sha = run_git(["rev-parse", "HEAD"], proj).strip()
        run_git(["checkout", "-q", "--detach", head_sha], proj)
        self.assertEqual(current_branch(proj), "")  # confirms real detached HEAD
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()
        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=never_called,
            existing_mode=True,
            slug="myproj",
        )
        self.assertFalse(verdict.passed)
        self.assertIn(
            "detached HEAD — check out a branch first",
            verdict_reason_text(verdict),
        )
        # Still genuinely detached — no branch was created off of it.
        self.assertEqual(current_branch(proj), "")

    def test_new_mode_unaffected_no_branch_keys_no_repersist_on_fail(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        verdict = run_project("build a page", project_dir=proj, vault=vault)
        self.assertFalse(verdict.passed)
        # Byte-identical v1 behavior: no 'project' extras key at all on a
        # raw ProjectStepError failure (post_dispatch never returned).
        self.assertNotIn("project", verdict.extras or {})


class RunProjectResumeStoredBranchTest(unittest.TestCase):
    """Task V2-5: `project_finish` returns an existing-mode attach to `base`
    on BOTH 'done' and 'attention' — so resuming an 'attention' project must
    continue the STORED run branch (`run_branch=`) rather than create a new
    numbered branch off base, which would abandon the already-passed steps
    committed on the previous run branch."""

    def test_resume_with_stored_branch_checks_out_existing_branch_and_commits_land_on_it(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        # Simulate a PRIOR run: branch off base, commit a passed step, then
        # (as `project_finish` does at 'attention') return to base — HEAD is
        # back on base, clean, and scprism/myproj-1 still holds the work.
        git_checkout_new_branch(proj, "scprism/myproj-1")
        with open(os.path.join(proj, "step1.py"), "w") as f:
            f.write("print('step 1')\n")
        run_git(["add", "-A"], proj)
        run_git(
            ["-c", "user.name=t", "-c", "user.email=t@t.local",
             "commit", "-q", "-m", "prior run step 1"],
            proj,
        )
        git_checkout(proj, base)
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: step2.py===\nprint('step 2')\n===END===")

        verdict = run_project(
            "continue building",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
            run_branch="scprism/myproj-1",
        )

        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertEqual(current_branch(proj), "scprism/myproj-1")
        info = verdict_project_dict(verdict)
        self.assertEqual(info.get("run_branch"), "scprism/myproj-1")
        self.assertEqual(info.get("base_branch"), base)
        # Never created scprism/myproj-2 — the stored branch was reused, not
        # abandoned for a fresh numbered branch.
        branches = run_git(["branch", "--list", "scprism/myproj-*"], proj)
        self.assertNotIn("scprism/myproj-2", branches)
        # Both the prior run's file AND the new step's file are present.
        self.assertTrue(os.path.exists(os.path.join(proj, "step1.py")))
        self.assertTrue(os.path.exists(os.path.join(proj, "step2.py")))
        # The prior commit is still reachable in history (never rewritten).
        log = run_git(["log", "--oneline"], proj)
        self.assertIn("prior run step 1", log)

    def test_stored_branch_missing_falls_through_to_new_branch_creation(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        vault = tempfile.mkdtemp()
        fake = make_fake_model("===FILE: app.py===\nprint(1)\n===END===")

        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=fake,
            existing_mode=True,
            slug="myproj",
            run_branch="scprism/myproj-7",  # never existed
        )

        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        info = verdict_project_dict(verdict)
        # Fell through to the normal next_run_branch, NOT the missing stored one.
        self.assertEqual(info.get("run_branch"), "scprism/myproj-1")
        self.assertEqual(current_branch(proj), "scprism/myproj-1")

    def test_stored_branch_checkout_failure_refuses_before_model_call(self):
        """A real git-native checkout failure (the stored branch is already
        checked out in ANOTHER worktree) — not a mock — must fail closed
        BEFORE any model call, leaving base untouched (fail-closed, mirrors
        `test_branch_create_failure_refuses_before_model_call`'s style of
        forcing a real git error rather than mocking git)."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        base_head_before = run_git(["rev-parse", "HEAD"], proj).strip()
        git_checkout_new_branch(proj, "scprism/myproj-1")
        git_checkout(proj, base)
        other_wt_parent = tempfile.mkdtemp()
        other_wt = os.path.join(other_wt_parent, "wt")
        run_git(["worktree", "add", other_wt, "scprism/myproj-1"], proj)
        vault = tempfile.mkdtemp()
        never_called = make_never_called_model()

        verdict = run_project(
            "add app.py",
            project_dir=proj,
            vault=vault,
            model=never_called,
            existing_mode=True,
            slug="myproj",
            run_branch="scprism/myproj-1",
        )

        self.assertFalse(verdict.passed)
        self.assertIn(
            "could not resume run branch scprism/myproj-1:",
            verdict_reason_text(verdict),
        )
        self.assertEqual(current_branch(proj), base)
        self.assertEqual(run_git(["rev-parse", "HEAD"], proj).strip(), base_head_before)


class ProjectFinishTest(unittest.TestCase):
    def test_returns_to_base_and_wip_commits_leftovers(self):
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        git_checkout_new_branch(proj, "scprism/myproj-1")
        with open(os.path.join(proj, "mid.txt"), "w") as f:
            f.write("mid-step leftovers")
        ok, detail = project_finish(proj, base)
        self.assertTrue(ok, detail)
        self.assertEqual(current_branch(proj), base)
        self.assertTrue(is_clean(proj))
        git_checkout(proj, "scprism/myproj-1")
        log = run_git(["log", "--oneline"], proj)
        self.assertIn("wip (run ended mid-step)", log)

    def test_never_raises_on_bad_project_dir(self):
        ok, detail = project_finish("/nonexistent/path/xyz", "main")
        self.assertFalse(ok)
        self.assertIsInstance(detail, str)

    def test_called_while_already_on_base_is_a_noop(self):
        """H2 (V2-2 carried hardening): if a client ever calls
        `project_finish` while HEAD is ALREADY on the user's base branch, it
        must never wip-commit the user's own uncommitted changes onto base.
        Guard: current == base -> (True, 'already on base'), no commit, tree
        left exactly as found (still dirty, HEAD unchanged)."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        head_before = run_git(["rev-parse", "HEAD"], proj).strip()
        with open(os.path.join(proj, "users_own_wip.txt"), "w") as f:
            f.write("the user's own in-progress edit, not ours to commit")

        ok, detail = project_finish(proj, base)

        self.assertTrue(ok)
        self.assertEqual(detail, "already on base")
        self.assertEqual(current_branch(proj), base)
        self.assertEqual(run_git(["rev-parse", "HEAD"], proj).strip(), head_before)
        # No commit happened — the tree is still dirty with the user's file.
        self.assertFalse(is_clean(proj))
        self.assertTrue(os.path.exists(os.path.join(proj, "users_own_wip.txt")))

    def test_dirty_third_party_branch_refuses_without_touching_anything(self):
        """H2 review fix: on a branch that is neither `base` nor `scprism/*`,
        a DIRTY tree must be refused outright — `git checkout base` would
        otherwise silently carry compatible uncommitted changes onto base's
        working tree while reporting ok=True. Nothing may change: no commit,
        no checkout, tree still dirty, base untouched."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        base_head = run_git(["rev-parse", base], proj).strip()
        git_checkout_new_branch(proj, "feature/user-owned")
        head_before = run_git(["rev-parse", "HEAD"], proj).strip()
        with open(os.path.join(proj, "users_wip.txt"), "w") as f:
            f.write("the user's uncommitted work on their own branch")

        ok, detail = project_finish(proj, base)

        self.assertFalse(ok)
        self.assertEqual(
            detail,
            "on an unexpected branch with uncommitted changes — resolve manually",
        )
        # Absolutely nothing moved: same branch, same HEAD, tree still dirty,
        # base ref untouched.
        self.assertEqual(current_branch(proj), "feature/user-owned")
        self.assertEqual(run_git(["rev-parse", "HEAD"], proj).strip(), head_before)
        self.assertFalse(is_clean(proj))
        self.assertTrue(os.path.exists(os.path.join(proj, "users_wip.txt")))
        self.assertEqual(run_git(["rev-parse", base], proj).strip(), base_head)

    def test_clean_third_party_branch_still_checks_out_base(self):
        """Companion pin: a CLEAN third-party branch is safe to leave — the
        plain checkout to base proceeds (no wip-commit anywhere)."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        git_checkout_new_branch(proj, "feature/user-owned")
        head_before = run_git(["rev-parse", "HEAD"], proj).strip()

        ok, detail = project_finish(proj, base)

        self.assertTrue(ok, detail)
        self.assertEqual(current_branch(proj), base)
        self.assertTrue(is_clean(proj))
        # No commit was manufactured on the third-party branch.
        self.assertEqual(
            run_git(["rev-parse", "feature/user-owned"], proj).strip(), head_before
        )

    def test_called_on_run_branch_still_wip_commits_leftovers(self):
        """H2b: pins the EXISTING behavior for the case the guard must NOT
        change — called on a scprism/* run branch with dirty leftovers, the
        wip-commit still lands there before returning to base (same
        assertions as test_returns_to_base_and_wip_commits_leftovers, kept
        as an explicit regression alongside the new H2 guard)."""
        proj = tempfile.mkdtemp()
        init_repo_with_commit(proj)
        base = current_branch(proj)
        git_checkout_new_branch(proj, "scprism/myproj-1")
        with open(os.path.join(proj, "mid.txt"), "w") as f:
            f.write("mid-step leftovers")

        ok, detail = project_finish(proj, base)

        self.assertTrue(ok, detail)
        self.assertEqual(current_branch(proj), base)
        self.assertTrue(is_clean(proj))
        git_checkout(proj, "scprism/myproj-1")
        log = run_git(["log", "--oneline"], proj)
        self.assertIn("wip (run ended mid-step)", log)


if __name__ == "__main__":
    unittest.main()
