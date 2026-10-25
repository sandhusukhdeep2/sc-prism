"""Project mode — real file writes OUTSIDE the vault, inside ONE project dir.

The model emits structured blocks:
    ===FILE: relative/path.ext===
    <full file content>
    ===END===
Everything else is narration. Paths are validated deny-by-default: relative,
resolving strictly inside the project dir (symlinks resolved), never under
.git/, never matching a never-touch glob. v1 is write/overwrite only — git
history is the undo (checkpoints in runner.py's git_checkpoint).
"""

from __future__ import annotations

import fnmatch
import itertools
import os
import re
import subprocess
import threading
from typing import Any, Dict, List, Optional, Sequence, TYPE_CHECKING, Tuple

from . import capabilities

if TYPE_CHECKING:  # avoid a cycle: loop -> (lazily) project for ProjectStepError
    from .dispatcher import ModelCall
    from .writeback import Verdict
    from .context import CatalogEntry
    from .team import AgentSpec
    from .memory import MemoryStore
    from .telemetry import Telemetry

FileOp = Tuple[str, str]

# The fixed FILE-block format the model (single doer OR the role board's lead)
# must emit so `post` can write the files it names. ONE source of truth: the
# single-doer prompt appends it below, and `run_project` hands the SAME string
# to `team_model_adapter` as the board's `file_block_instructions` — so a format
# change can never drift between the two doer paths.
#
# CARE WHEN EDITING THE WORDING: this string is appended to the step prompt, and
# the gateway routes on that whole prompt. ``REASONING_KEYWORDS`` is still
# matched by containment, so a stray "plan" / "design" / "refactor" in our own
# scaffolding silently re-routes EVERY project step — a draft of the paragraph
# below said "a plan" and moved a three-provider role board onto one local
# model. Keep these words free of routing keywords.
FILE_BLOCK_INSTRUCTIONS = (
    "OUTPUT FORMAT — REQUIRED. This is how work is delivered here; it is not a "
    "style preference.\n"
    "Output the complete content of every file you create or change as blocks:\n"
    "===FILE: relative/path.ext===\n"
    "<full file content>\n"
    "===END===\n"
    "Emit at least one block. Do not use markdown code fences around blocks.\n"
    "Write each file's FULL content, not a diff, a patch or an excerpt.\n"
    "A reply that contains only analysis, findings or intentions and NO file "
    "block is REJECTED: nothing is written to disk and the step FAILS. "
    "Analysis is not the deliverable — the file blocks are. Do the thinking, "
    "then put the result in the blocks."
)

# The correction sent when a completion carried NO file blocks (see
# ``FileBlockContract``). Short and unambiguous on purpose: the model already
# has the task, the code and the failing output from the first call — what it
# missed is the format, so this says only that.
NO_FILE_BLOCK_CORRECTION = (
    "STOP. Your previous reply contained no ===FILE:=== blocks, so NOTHING was "
    "written to disk and the task is not done. Your analysis was received; do "
    "not repeat it and do not explain yourself.\n"
    "Reply now with the full content of each file you are changing, and "
    "nothing else, in exactly this form:\n"
    "===FILE: relative/path.ext===\n"
    "<full file content>\n"
    "===END==="
)

# Completion prefixes that are DIAGNOSTICS, not answers (the same markers
# loop.run filters on). A stub or a provider refusal has no format to correct,
# so it never earns the retry — asking a keyless offline gateway a second time
# would only produce the same stub at twice the cost.
_NOT_A_COMPLETION = ("[offline:", "[stub:", "[rejected:")

_BLOCK = re.compile(
    r"^===FILE:\s*(?P<path>[^=\n]+?)\s*===\s*\n(?P<body>.*?)\n?===END===",
    re.MULTILINE | re.DOTALL,
)


def parse_file_blocks(text: str) -> List[FileOp]:
    """Every well-formed FILE block, in order. Unclosed blocks are ignored.

    CRLF completions are normalized to LF first so block bodies never carry
    stray carriage returns.
    """
    text = text.replace("\r\n", "\n")
    return [(m.group("path").strip(), m.group("body")) for m in _BLOCK.finditer(text)]


class FileBlockContract:
    """Enforce the ===FILE:=== output contract, once, and report honestly.

    THE BUG THIS EXISTS FOR. A refine turn returned 17,777 characters of real
    analysis — "Let me analyze the failing tests and the current code to
    understand what's broken…" — and not one ``===FILE:===`` block. Writeback
    therefore landed nothing, the project files stayed byte-identical, and the
    step failed as if the model had tried and failed. It had not tried to WRITE
    at all; it had missed the OUTPUT CONTRACT. It happened on both refine
    attempts of a real run, which is why that loop never converged.

    Two halves:

      * ``wrap(doer)`` returns a doer that checks every completion for file
        blocks. A completion with NONE — and which is a real completion, not an
        offline stub — buys exactly ONE more call carrying
        ``NO_FILE_BLOCK_CORRECTION``.

        THE BOUND is structural, not a counter: ``_call`` invokes ``inner`` at
        most twice and the correction is sent to ``inner`` DIRECTLY, never back
        through ``_call``, so a reply that misses the contract twice ends the
        matter. There is no path on which a correction is itself corrected.

        The bound is per COMPLETION rather than per run on purpose. Dispatch
        runs read steps CONCURRENTLY, so a single run-wide "one retry" flag
        would be claimed by whichever thread happened to finish first — quite
        possibly not the step whose completion the writer actually consumes
        (``loop.run`` feeds ``post_dispatch`` the FIRST step's real output).
        That would leave the fix working by luck. Per completion, the step that
        matters always gets its correction, and the worst case is still bounded:
        one extra call per plan step, and the merged token counts below keep the
        run's own budget honest about what that cost.

      * ``no_blocks_reason()`` names what actually happened, so the Verdict can
        tell "it could not fix it" apart from "it never tried to write".

    A completion that already carries blocks is returned untouched and costs
    nothing extra — the ordinary path is byte-identical to before this landed.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Corrections sent, and corrections that still came back blockless.
        self.corrections = 0
        self.prose_only = False
        # The provider's OWN failure text, when the completion was really a
        # gateway stand-in (quota exhausted, auth expired, provider down). The
        # user must be told THAT, not "no file blocks" — a rate-limited
        # account looked like a broken app (2026-08-31, found live: "You've
        # reached your Fable 5 limit" surfaced only as a tier-1 failure).
        self.provider_error = ""

    def wrap(self, inner: "ModelCall") -> "ModelCall":
        from dataclasses import replace

        def _call(prompt: str, route: str):
            result = inner(prompt, route)
            text = result.text or ""
            # A gateway stand-in names its own cause behind the `[offline:`
            # prefix — keep that sentence so the step can report it verbatim.
            if text.lstrip().startswith("[offline:"):
                with self._lock:
                    self.provider_error = text.strip()[:400]
            if parse_file_blocks(text):
                return result
            stripped = text.strip()
            if not stripped or stripped.startswith(_NOT_A_COMPLETION):
                return result  # a diagnostic, not a contract miss
            with self._lock:
                self.corrections += 1
            # The ONE correction for this completion, sent to `inner` — never
            # to `_call` — so it can never be corrected in turn.
            retry = inner(prompt + "\n\n" + NO_FILE_BLOCK_CORRECTION, route)
            merged = dict(
                tokens=(result.tokens or 0) + (retry.tokens or 0),
                tokens_in=(result.tokens_in or 0) + (retry.tokens_in or 0),
                tokens_out=(result.tokens_out or 0) + (retry.tokens_out or 0),
            )
            if parse_file_blocks(retry.text or ""):
                # The correction worked: the retry's blocks are the answer.
                return replace(retry, **merged)
            # It did not. Keep the FIRST reply's text — it is the model's real
            # analysis and the user should still see it — and let
            # `no_blocks_reason` say plainly that no file blocks ever came.
            with self._lock:
                self.prose_only = True
            return replace(result, **merged)

        return _call

    def no_blocks_reason(self, parsed_any: bool) -> str:
        """Why nothing was written, in the words a user can act on.

        ``parsed_any``: blocks WERE parsed but every one was the instruction
        example echoed back (a different failure — the model used the format
        but wrote nothing real).
        """
        # The provider never answered at all — say so first. "No file blocks"
        # is true but useless when the real cause is a quota or an expired
        # login, and it sends the user hunting a bug in their own prompt.
        if self.provider_error:
            return f"the AI never answered — {self.provider_error}"
        if parsed_any:
            return "no file blocks in completion (instruction echo only)"
        if self.prose_only:
            return (
                "the model replied with analysis but no file blocks — nothing "
                "was written. It was asked once more for ===FILE:=== blocks "
                "and answered with analysis again."
            )
        return "no file blocks in completion"


def validate_project_path(
    rel: str, project_dir: str, never_touch: Sequence[str] = ()
) -> Tuple[bool, str]:
    """(ok, reason). Deny-by-default with a human-readable reason."""
    if not rel or not rel.strip():
        return False, f"not a file path: {rel!r}"
    if os.path.isabs(rel):
        return False, f"absolute path not allowed: {rel}"
    norm = os.path.normpath(rel)
    if norm == ".":
        return False, f"not a file path: {rel!r}"
    # Segment semantics: reject a real '..' escape, but allow filenames that
    # merely start with '..' (e.g. '..bak').
    if norm == ".." or norm.startswith(".." + os.sep):
        return False, f"path escapes outside the project: {rel}"
    # Case-fold blocklists: macOS APFS (and Windows) are case-insensitive, so
    # '.GIT/...' or 'SECRETS/...' would hit the real paths on disk.
    low = norm.lower()
    if low == ".git" or low.startswith(".git" + os.sep):
        return False, f"writes under .git are not allowed: {rel}"
    for pattern in never_touch:
        if fnmatch.fnmatch(low, pattern.lower()):
            return False, f"never-touch path: {rel} (matches {pattern})"
    root = os.path.realpath(project_dir)
    # Resolve the deepest EXISTING ancestor so a symlinked directory cannot
    # smuggle the write outside the project.
    parent = os.path.dirname(os.path.join(root, norm))
    probe = parent
    while probe and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    real_parent = os.path.realpath(probe or root)
    if real_parent != root and not real_parent.startswith(root + os.sep):
        return False, f"path resolves outside the project: {rel}"
    return True, ""


def apply_file_ops(
    ops: Sequence[FileOp],
    project_dir: str,
    never_touch: Sequence[str] = (),
    grants: Any = None,
    agent: str = "",
) -> Dict[str, Any]:
    """Write accepted ops (creating parents), report rejections with reasons.

    Never raises: any per-op OSError becomes a rejection so one bad op cannot
    lose the rest of the batch.

    ``grants`` (an ``AgentGrants``) is the ``writes`` CAPABILITY GATE and this
    is where it is enforced — an agent without ``writes`` has every op rejected
    with the honest reason and NOTHING reaches the filesystem. ``None`` (the
    default) means no per-agent grant was declared for this run, which leaves
    every existing caller byte-identical.
    """
    written: List[str] = []
    rejected: List[Dict[str, str]] = []
    if grants is not None and not grants.allows(agent, capabilities.WRITES):
        reason = grants.refusal(agent, capabilities.WRITES)
        return {
            "written": [],
            "rejected": [{"path": rel, "reason": reason} for rel, _c in ops],
        }
    root = os.path.realpath(project_dir)
    for rel, content in ops:
        ok, reason = validate_project_path(rel, project_dir, never_touch)
        if not ok:
            rejected.append({"path": rel, "reason": reason})
            continue
        norm = os.path.normpath(rel)
        dest = os.path.join(root, norm)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # TOCTOU recheck: the parent now exists for real — re-resolve it so
            # a symlink created between validation and write cannot escape.
            real_parent = os.path.realpath(os.path.dirname(dest))
            if real_parent != root and not real_parent.startswith(root + os.sep):
                rejected.append(
                    {
                        "path": rel,
                        "reason": f"path resolves outside the project (post-makedirs): {rel}",
                    }
                )
                continue
            # Leaf check: parent resolution alone misses a symlink AT the
            # destination (evil.txt -> /outside/victim.txt) — open() would
            # follow it and clobber the outside file.
            real_dest = os.path.realpath(dest)
            if os.path.islink(dest) or (
                os.path.exists(dest)
                and real_dest != root
                and not real_dest.startswith(root + os.sep)
            ):
                rejected.append(
                    {
                        "path": rel,
                        "reason": f"destination is a symlink escaping the project: {rel}",
                    }
                )
                continue
            with open(dest, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            rejected.append({"path": rel, "reason": f"write failed: {e}"})
            continue
        written.append(norm)
    return {"written": written, "rejected": rejected}


class ProjectStepError(Exception):
    """Raised by a `post_dispatch` callback (this module's own `post` closure,
    wired into `loop.run` by `run_project`) when a project step cannot be
    accepted — no file blocks were emitted, or every emitted file write was
    rejected by the path boundary. `loop.run` catches this and fails the run
    Tier-1-style: the reason is recorded in place of a failed Tier-1 command
    and Tier-2 is short-circuited exactly as it is for a real Tier-1 failure.
    """


def git_checkpoint(project_dir: str, message: str) -> str:
    """Best-effort git checkpoint after a passing project step. NEVER raises.

    `git init`s a fresh project dir, stages everything, and commits under a
    fixed scprism identity (independent of the user's global git config) so
    history stays legible and reproducible in CI. Any failure along the way —
    no git binary, a clean tree with nothing to commit, a timeout — is
    reported as ``'skipped: <reason>'`` rather than raised: git history is a
    nice-to-have checkpoint, never a reason to fail an otherwise-passing task.
    """
    try:
        chk = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if chk.returncode != 0:
            init = subprocess.run(
                ["git", "init", "-q"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if init.returncode != 0:
                reason = (init.stderr or init.stdout or "git init failed").strip()
                return f"skipped: {reason}"

        add = subprocess.run(
            ["git", "add", "-A"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if add.returncode != 0:
            reason = (add.stderr or add.stdout or "git add failed").strip()
            return f"skipped: {reason}"

        commit = subprocess.run(
            [
                "git",
                "-c",
                "user.name=scprism",
                "-c",
                "user.email=engine@scprism.local",
                "commit",
                "-q",
                "-m",
                message,
            ],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if commit.returncode != 0:
            reason = (commit.stderr or commit.stdout or "nothing to commit").strip()
            return f"skipped: {reason}"

        rev = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if rev.returncode != 0:
            reason = (rev.stderr or rev.stdout or "git rev-parse failed").strip()
            return f"skipped: {reason}"
        return f"committed: {rev.stdout.strip()}"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return f"skipped: {exc}"


def git_current_branch(project_dir: str) -> Tuple[bool, str]:
    """(ok, branch|reason). NEVER raises. `ok=False` when `project_dir` is
    not (yet) a git repo, or on any git/subprocess error — `git branch
    --show-current` also succeeds on an unborn HEAD (a freshly `git init`ed
    repo with zero commits), returning the default branch name, which is
    exactly what the no-commits caller needs to check next."""
    try:
        res = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git branch --show-current failed").strip()
            return False, reason
        return True, res.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def git_is_dirty(project_dir: str) -> Tuple[bool, str]:
    """(ok, detail). `ok=False` on git errors (detail carries the reason);
    on success `detail` is exactly 'dirty' or 'clean'. NEVER raises."""
    try:
        res = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git status failed").strip()
            return False, reason
        return True, "dirty" if res.stdout.strip() else "clean"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def git_checkout_new_branch(project_dir: str, name: str) -> Tuple[bool, str]:
    """`git checkout -b <name>`. NEVER raises."""
    try:
        res = subprocess.run(
            ["git", "checkout", "-q", "-b", name],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git checkout -b failed").strip()
            return False, reason
        return True, name
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def git_checkout(project_dir: str, name: str) -> Tuple[bool, str]:
    """`git checkout <name>`. NEVER raises. NEVER `checkout -- .` (Global
    Constraints) — this only ever switches branches, never restores paths."""
    try:
        res = subprocess.run(
            ["git", "checkout", "-q", name],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git checkout failed").strip()
            return False, reason
        return True, name
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def git_branch_exists(project_dir: str, name: str) -> bool:
    """True iff `name` is an existing LOCAL branch ref (`git show-ref
    --verify --quiet refs/heads/<name>`). NEVER raises — any git error (not a
    repo, bad name, timeout) reports False, same as "does not exist"."""
    try:
        res = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{name}"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return res.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def git_merge_branch(project_dir: str, branch: str, into: str = "") -> Tuple[bool, str]:
    """Merge `branch` into the CURRENT branch. NEVER `push`, `force`, or
    `rebase` (Global Constraints) — a plain, local, no-ff-forcing merge. On
    ANY failure, best-effort `git merge --abort` then an HONEST reason:
    `'conflict: <detail>'` only when git's own output says conflict; the raw
    git reason otherwise (missing branch, unrelated histories, ...); and if
    the tree is somehow STILL dirty after the abort, that is reported as
    `'merge left the tree dirty — resolve manually: <detail>'` so the caller
    never has to guess whether cleanup is needed. This same abort + dirty
    recheck also runs when the merge subprocess call itself blows up
    (`TimeoutExpired`/`FileNotFoundError`/`OSError`) — a merge killed
    mid-conflict (e.g. a timeout) can leave `MERGE_HEAD`/conflict markers
    behind just as silently as an rc!=0 failure would. NEVER raises.

    FIX 1 (v2 final review — merge target guard): `project-merge` used to
    merge into WHATEVER branch happened to be checked out. After an
    interrupted run (repo left on `scprism/x-1`), merging x-1 "into base"
    while HEAD was STILL on x-1 was a silent self-merge no-op reporting
    `ok:true`; an external checkout to some other branch would merge into
    the wrong user branch just as silently. When `into` is non-empty, the
    merge only proceeds if the repo is ACTUALLY checked out on `into`:
      - current branch == `branch` itself -> `(False, 'nothing to merge
        into — repo is still on the run branch')` (the self-merge case).
      - current branch is anything else != `into` -> `(False, 'repo is
        checked out on «<current>», not «<into>» — check out «<into>»
        first')`.
      - current branch == `into` -> proceeds exactly as before.
    `into=''` (the default) is byte-identical to the pre-fix signature — no
    current-branch gate at all."""
    if into:
        cur_ok, current = git_current_branch(project_dir)
        if not cur_ok:
            return False, current
        if current == branch:
            return False, "nothing to merge into — repo is still on the run branch"
        if current != into:
            return (
                False,
                f"repo is checked out on «{current}», not «{into}» — "
                f"check out «{into}» first",
            )
    try:
        res = subprocess.run(
            [
                "git",
                "-c",
                "user.name=scprism",
                "-c",
                "user.email=engine@scprism.local",
                "merge",
                "-q",
                "--no-edit",
                branch,
            ],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git merge failed").strip()
            # Only a merge whose own output says so is a CONFLICT (git prints
            # 'CONFLICT (content): ...' / 'fix conflicts' on stdout even with
            # -q, verified empirically); a missing branch, unrelated
            # histories, etc. get the raw git reason instead of a mislabel.
            is_conflict = "conflict" in f"{res.stdout}\n{res.stderr}".lower()
            # Best-effort abort so a failed/conflicted merge never leaves the
            # tree mid-merge; harmless (rc=128, tree untouched) when the
            # failure never started a merge (e.g. missing branch).
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=30,
            )
            # Honesty re-check: the abort SHOULD have restored a clean tree.
            # If it didn't (or git can't even tell us), say so explicitly
            # rather than implying the standard clean-conflict outcome.
            clean_ok, detail = git_is_dirty(project_dir)
            if not (clean_ok and detail == "clean"):
                return False, f"merge left the tree dirty — resolve manually: {reason}"
            if is_conflict:
                return False, f"conflict: {reason}"
            return False, reason
        rev = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if rev.returncode != 0:
            # The merge itself succeeded; only the sha report failed — not a
            # conflict, so return the raw reason.
            reason = (rev.stderr or rev.stdout or "git rev-parse failed").strip()
            return False, reason
        return True, f"merged: {rev.stdout.strip()}"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        # H1: mirror the rc!=0 arm's cleanup exactly — a merge subprocess
        # call that itself raised (e.g. timed out mid-conflict) can leave
        # MERGE_HEAD/markers behind just as silently. Best-effort abort
        # (wrapped so a further hiccup here can't mask the original exc),
        # then the same honest dirty recheck.
        try:
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
        clean_ok, detail = git_is_dirty(project_dir)
        if not (clean_ok and detail == "clean"):
            return False, f"merge left the tree dirty — resolve manually: {exc}"
        return False, str(exc)


# The fixed identity every scprism checkpoint/wip commit is authored under
# (see git_checkpoint / _wip_commit / git_merge_branch) — doubles as the
# ownership discriminator for the new-mode real-repo guard: a repo whose ROOT
# commit was authored by this identity is one of OUR project dirs.
_SCPRISM_EMAIL = "engine@scprism.local"


def git_root_commit_author_email(project_dir: str) -> Tuple[bool, str]:
    """(ok, email|reason). The ROOT commit's author email (`git log
    --max-parents=0 --format=%ae HEAD`; first line when multiple roots —
    e.g. merged unrelated histories). `ok=False` on any git/subprocess
    error, with the reason. NEVER raises."""
    try:
        res = subprocess.run(
            ["git", "log", "--max-parents=0", "--format=%ae", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            reason = (res.stderr or res.stdout or "git log failed").strip()
            return False, reason
        lines = [ln.strip() for ln in res.stdout.splitlines() if ln.strip()]
        if not lines:
            return False, "no root commit found"
        return True, lines[0]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def git_has_commits(project_dir: str) -> bool:
    """True iff HEAD resolves to a real commit (a freshly `git init`ed repo
    with nothing committed yet, or any git error, is False). NEVER raises."""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--verify", "-q", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return res.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def next_run_branch(project_dir: str, slug: str) -> str:
    """`scprism/<slug>-<n>`, n = 1 + the highest existing n for that slug
    (parses `git branch --list 'scprism/<slug>-*'`). Falls back to `-1` on
    any git error — NEVER raises."""
    try:
        res = subprocess.run(
            ["git", "branch", "--list", f"scprism/{slug}-*"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode != 0:
            return f"scprism/{slug}-1"
        pattern = re.compile(rf"^scprism/{re.escape(slug)}-(\d+)$")
        highest = 0
        for line in res.stdout.splitlines():
            name = line.strip().lstrip("*").strip()
            m = pattern.match(name)
            if m:
                highest = max(highest, int(m.group(1)))
        return f"scprism/{slug}-{highest + 1}"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return f"scprism/{slug}-1"


def repo_outline(project_dir: str, cap: int = 4000) -> str:
    """A bounded, read-only outline of the attached repo for the step
    prompt: top-level file list (`git ls-files`, falling back to `os.walk`
    when the dir isn't a repo — never raises either way) capped at 100
    entries, plus the first 80 lines of README.md if present. Any line
    containing the FILE-block markers is stripped so a malicious/quoted
    README can never smuggle a fake block into the prompt. Hard-capped at
    `cap` characters total."""
    entries: List[str] = []
    try:
        res = subprocess.run(
            ["git", "ls-files"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if res.returncode == 0:
            entries = [ln for ln in res.stdout.splitlines() if ln.strip()][:100]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        entries = []

    if not entries:
        try:
            for root, dirs, files in os.walk(project_dir):
                dirs[:] = sorted(d for d in dirs if d != ".git")
                rel_root = os.path.relpath(root, project_dir)
                for fname in sorted(files):
                    rel = fname if rel_root == "." else os.path.join(rel_root, fname)
                    entries.append(rel)
                    if len(entries) >= 100:
                        break
                if len(entries) >= 100:
                    break
        except OSError:
            entries = []

    lines: List[str] = ["Files:"]
    lines.extend(f"- {e}" for e in entries)

    readme_path = os.path.join(project_dir, "README.md")
    if os.path.isfile(readme_path):
        try:
            with open(readme_path, "r", encoding="utf-8", errors="replace") as f:
                # islice, not readlines()[:80]: a huge README must never be
                # loaded fully just to keep its first 80 lines.
                readme_lines = list(itertools.islice(f, 80))
            lines.append("")
            lines.append("README.md (first 80 lines):")
            lines.extend(ln.rstrip("\n") for ln in readme_lines)
        except OSError:
            pass

    outline = "\n".join(
        ln for ln in "\n".join(lines).splitlines()
        if "===FILE:" not in ln and "===END===" not in ln
    )
    return outline[:cap]


# --------------------------------------------------------------------------
# What a refine turn is allowed to SEE (bounded, labelled, read from disk).
# --------------------------------------------------------------------------
#
# A refine turn used to be handed the failing test output and nothing else — not
# the source it was being asked to fix, and not a byte of the data that source
# was written to parse. A model in that position cannot repair a parser; it can
# only guess at a shape and re-emit a different guess, which is exactly what two
# real runs did. These budgets follow dc4124e's precedent for the judge prompt:
# bounded up front, read BACK from disk (reading the file is what proves the
# claim), and every cut named as a cut BY US so an excerpt can never read as the
# whole artifact.

# Current source of the files being fixed.
REFINE_SOURCE_BUDGET = 12_000      # chars across all files
REFINE_SOURCE_PER_FILE = 4_000     # chars from any one file
REFINE_SOURCE_MAX_FILES = 12       # files quoted at all

# A sample of the REAL data a task parses (caller-supplied paths).
DATA_SAMPLE_BUDGET = 6_000         # chars across all samples
DATA_SAMPLE_PER_FILE = 3_000       # chars from any one sample

# Text the model could plausibly have to fix. A refine turn quoting a .png back
# at the model spends budget on nothing.
_SOURCE_EXTS = (
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
    ".rs", ".go", ".rb", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh",
    ".yml", ".yaml", ".toml", ".css", ".html", ".sql",
)
_SKIP_DIR_NAMES = {".git", "node_modules", "dist", "build", "__pycache__", ".venv"}


def _sanitize_block(text: str) -> str:
    """Strip any line carrying a FILE-block marker.

    Quoted content flows into the prompt that the FILE-block parser later reads
    the model's ANSWER out of. A file (or a data sample) containing
    `===FILE: x===` could otherwise smuggle a write the model never asked for —
    the same defence `repo_outline` already applies to a README.
    """
    return "\n".join(
        ln for ln in text.splitlines()
        if "===FILE:" not in ln and "===END===" not in ln
    )


def _intent_task_id(intent: str) -> str:
    """`<intent-slug>-<uuid8>` — the same shape `contract.parse` derives, but
    slugged from the USER'S intent instead of the fully decorated prompt."""
    import uuid

    from .contract import _slugify

    return f"{_slugify(intent)}-{uuid.uuid4().hex[:8]}"


def _verdict_task_id(verdict_path: str) -> str:
    """The `task_id` recorded in a persisted Verdict, or "" if unreadable.

    Read from the file rather than parsed out of its NAME: a filename is a
    convention, the field is the record.
    """
    if not verdict_path:
        return ""
    try:
        import json

        with open(verdict_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return ""
    task_id = data.get("task_id") if isinstance(data, dict) else ""
    return str(task_id) if isinstance(task_id, str) else ""


def previous_files_written(verdict_path: str) -> List[str]:
    """The file list from a previous attempt's persisted Verdict.

    Best-effort: a missing/corrupt/foreign verdict returns `[]` rather than
    raising — this only decides how much context a prompt gets, and it must
    never be able to fail a run.
    """
    if not verdict_path:
        return []
    try:
        import json

        with open(verdict_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    files = ((data.get("extras") or {}).get("project") or {}).get("files_written")
    if not isinstance(files, list):
        return []
    return [str(p) for p in files if isinstance(p, str) and p.strip()]


def _verdict_project_files(verdict_path: str) -> Tuple[List[str], set]:
    """(files_written, overwrote) from a persisted verdict, path-normalized.

    Best-effort like `previous_files_written`: anything missing, corrupt or
    foreign reads as empty — these lists only shape a prompt, and a reader of
    old vault bytes must never be able to fail a run.
    """
    if not verdict_path:
        return [], set()
    try:
        import json

        with open(verdict_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return [], set()
    proj = ((data.get("extras") or {}).get("project") or {}) if isinstance(data, dict) else {}
    if not isinstance(proj, dict):
        return [], set()

    def _norm(val: Any) -> List[str]:
        if not isinstance(val, list):
            return []
        return [os.path.normpath(str(p)) for p in val if isinstance(p, str) and p.strip()]

    return _norm(proj.get("files_written")), set(_norm(proj.get("overwrote")))


def failed_step_files(vault: str, attempt_group: str) -> List[str]:
    """Files CREATED by failed attempts of one logical step, blessed by nothing.

    Observed live (2026-08-29, proj-site-launch): an attempt that dies
    mid-write leaves partial files on disk, and every later retry quoted them
    back into its prompt — compounding context attempt over attempt until the
    doer echoed the instructions instead of producing FILE blocks. This is the
    deterministic taint list for that retry context: a path is returned iff
    some FAILED attempt in `attempt_group`'s ledger wrote it, no PASSING
    attempt ever wrote it, and the EARLIEST attempt that wrote it did not
    overwrite an existing file — i.e. the step itself created it. A
    pre-existing file a failed attempt clobbered is still real source and
    stays quotable. Best-effort like every vault reader here: an unknown
    group or an unreadable ledger/verdict taints nothing.
    """
    if not attempt_group:
        return []
    from .writeback import read_attempts

    rows = [
        r
        for r in read_attempts(vault, attempt_group).get("attempts", [])
        if isinstance(r, dict)
    ]
    if not rows:
        return []
    rows.sort(key=lambda r: int(r.get("attempt", 0) or 0))
    blessed: set = set()
    failed: set = set()
    created_by_step: Dict[str, bool] = {}
    for row in rows:
        rel = row.get("verdict")
        path = os.path.join(vault, rel) if isinstance(rel, str) and rel else ""
        files, overwrote = _verdict_project_files(path)
        for norm in files:
            if norm not in created_by_step:
                created_by_step[norm] = norm not in overwrote
        (blessed if row.get("passed") else failed).update(files)
    return sorted(p for p in failed if p not in blessed and created_by_step.get(p, False))


def recent_source_files(project_dir: str, limit: int = REFINE_SOURCE_MAX_FILES) -> List[str]:
    """The most recently modified source files in `project_dir`, newest first.

    The fallback for when no previous verdict was supplied (a bare CLI refine).
    Newest-first is not a guess about authorship — it is a stated ordering, and
    the prompt labels the section as "files on disk", never as "what you wrote".
    """
    found: List[Tuple[float, str]] = []
    try:
        for root, dirs, files in os.walk(project_dir):
            dirs[:] = [d for d in dirs if d not in _SKIP_DIR_NAMES and not d.startswith(".")]
            for name in files:
                if not name.endswith(_SOURCE_EXTS):
                    continue
                abs_path = os.path.join(root, name)
                try:
                    found.append((os.path.getmtime(abs_path), os.path.relpath(abs_path, project_dir)))
                except OSError:
                    continue
    except OSError:
        return []
    found.sort(key=lambda pair: pair[0], reverse=True)
    return [rel for _mtime, rel in found[:limit]]


def current_source_excerpt(
    project_dir: str,
    paths: Sequence[str],
    *,
    budget: int = REFINE_SOURCE_BUDGET,
    per_file: int = REFINE_SOURCE_PER_FILE,
    max_files: int = REFINE_SOURCE_MAX_FILES,
    unblessed: Sequence[str] = (),
) -> str:
    """The CURRENT contents of `paths`, read back from disk, bounded + labelled.

    Returns "" when there is nothing readable to show, so the caller appends
    nothing rather than an empty heading. Guarantees: at most `max_files` files,
    at most `per_file` chars from any one of them, at most `budget` chars of file
    content in total, and every omission stated — a file dropped for budget is
    still NAMED with its size, because "we did not show you this file" and "this
    file does not exist" must never look the same to the model.

    `unblessed` names paths a FAILED attempt of this same step created (see
    `failed_step_files`): they are NAMED on one line each, never quoted, and
    never spend a `max_files` slot — their content is junk to regenerate, not
    source to repair, and quoting it back is what compounded every retry's
    context in the 2026-08-29 incident.
    """
    unblessed_set = {os.path.normpath(str(p)) for p in unblessed}
    quotable: List[str] = []
    tainted: List[str] = []
    for rel in paths:
        norm = os.path.normpath(str(rel))
        if norm in unblessed_set:
            if norm not in tainted:
                tainted.append(norm)
            continue
        quotable.append(rel)
    shown: List[str] = []
    elided: List[str] = []
    spent = 0
    seen = set()
    for rel in list(quotable)[: max(0, max_files)]:
        norm = os.path.normpath(str(rel))
        if norm in seen:
            continue
        seen.add(norm)
        abs_path = os.path.join(project_dir, norm)
        try:
            size = os.path.getsize(abs_path)
        except OSError:
            elided.append(f"  - {norm} — NOT ON DISK (the previous attempt did not leave this file)")
            continue
        room = min(per_file, max(0, budget - spent))
        if room <= 0:
            elided.append(f"  - {norm} — {size} bytes, not shown (context budget spent)")
            continue
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                chunk = fh.read(room + 1)
        except OSError as exc:
            elided.append(f"  - {norm} — unreadable ({exc.__class__.__name__})")
            continue
        cut = len(chunk) > room
        if cut:
            chunk = chunk[:room]
        read_chars = len(chunk)
        chunk = _sanitize_block(chunk)
        spent += len(chunk)
        note = (
            f" [FIRST {read_chars} CHARS OF {size} BYTES — EXCERPT, the file continues]"
            if cut
            else f" [complete, {size} bytes]"
        )
        shown.append(f"--- {norm}{note} ---\n{chunk}")
    for norm in tainted:
        try:
            size = f"{os.path.getsize(os.path.join(project_dir, norm))} bytes"
        except OSError:
            size = "not on disk"
        elided.append(
            f"  - {norm} — {size}, left by a FAILED attempt of this step and "
            "blessed by no passing verdict — content withheld on purpose: "
            "regenerate this file in full, do not repair it"
        )
    dropped = [str(p) for p in list(quotable)[max(0, max_files):]]
    if dropped:
        elided.append(
            f"  - {len(dropped)} further file(s) not shown (limit {max_files}): "
            + ", ".join(dropped[:10])
            + ("…" if len(dropped) > 10 else "")
        )
    if not shown and not elided:
        return ""
    out = [
        "\n\nTHE CODE AS IT IS ON DISK RIGHT NOW (read back from the files "
        "themselves — this is what you are fixing, not what you previously said "
        "you wrote):",
    ]
    out.extend(shown)
    if elided:
        out.append("NOT SHOWN HERE:")
        out.extend(elided)
    return "\n".join(out)


def data_sample_excerpt(
    paths: Sequence[str],
    *,
    budget: int = DATA_SAMPLE_BUDGET,
    per_file: int = DATA_SAMPLE_PER_FILE,
) -> str:
    """A bounded, labelled sample of REAL input data the task has to handle.

    When the job is to parse an artifact this machine already holds (a vault's
    `log.md`, a report, an export), guessing its shape is not a model's job —
    the shape is a fact on disk. This quotes the head of each supplied path,
    labelled unmistakably as a SAMPLE and as an EXCERPT, so the model treats it
    as a fixture to satisfy and never as the complete input.

    Absolute paths, caller-supplied only: nothing here goes looking for data on
    its own, so no run can widen its own read surface.
    """
    blocks: List[str] = []
    spent = 0
    for raw in paths:
        path = str(raw or "").strip()
        if not path:
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            blocks.append(f"--- {path} — NOT AVAILABLE (no such readable file) ---")
            continue
        room = min(per_file, max(0, budget - spent))
        if room <= 0:
            blocks.append(f"--- {path} — {size} bytes, not shown (sample budget spent) ---")
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                chunk = fh.read(room + 1)
        except OSError as exc:
            blocks.append(f"--- {path} — unreadable ({exc.__class__.__name__}) ---")
            continue
        cut = len(chunk) > room
        if cut:
            chunk = chunk[:room]
        read_chars = len(chunk)
        chunk = _sanitize_block(chunk)
        spent += len(chunk)
        note = (
            f"[FIRST {read_chars} CHARS OF {size} BYTES — EXCERPT, the file continues]"
            if cut
            else f"[complete, {size} bytes]"
        )
        blocks.append(f"--- SAMPLE: {path} {note} ---\n{chunk}")
    if not blocks:
        return ""
    return (
        "\n\nSAMPLE OF THE REAL DATA THIS MUST HANDLE (read from disk, not "
        "invented, and not model output). Match what is actually here — the "
        "excerpts below are the head of each file, so treat them as the shape "
        "to parse, never as the full input:\n" + "\n".join(blocks)
    )


def _wip_commit(project_dir: str, message: str) -> Tuple[bool, str]:
    """Stage everything and commit under the fixed scprism identity — the
    exact `git_checkpoint` subprocess pattern, factored out so the resume
    path and `project_finish` share one implementation. Best-effort: a clean
    tree (nothing to commit) or any git error is reported as `'skipped:
    <reason>'`, NEVER raised."""
    try:
        add = subprocess.run(
            ["git", "add", "-A"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if add.returncode != 0:
            reason = (add.stderr or add.stdout or "git add failed").strip()
            return False, f"skipped: {reason}"
        commit = subprocess.run(
            [
                "git",
                "-c",
                "user.name=scprism",
                "-c",
                "user.email=engine@scprism.local",
                "commit",
                "-q",
                "-m",
                message,
            ],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if commit.returncode != 0:
            reason = (commit.stderr or commit.stdout or "nothing to commit").strip()
            return False, f"skipped: {reason}"
        return True, "committed"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, f"skipped: {exc}"


def project_finish(project_dir: str, base: str) -> Tuple[bool, str]:
    """Called by the CLIENT's driver at run end (NOT by `run_project` itself)
    to return an existing-mode attach to a clean state. `(ok, detail)`;
    NEVER raises.

    Contract (H2 hardening): this must NEVER wip-commit the user's OWN
    uncommitted changes on their behalf, and never let them ride a checkout.
      - Current branch == `base`: no-op — `(True, 'already on base')`; no
        wip-commit, no checkout, the tree is left exactly as found (even if
        dirty).
      - Current branch is one of OUR `scprism/*` run branches: wip-commit
        dirty leftovers (`scprism: wip (run ended mid-step)`) — the only
        case where "dirty" can mean "a step got interrupted mid-write" —
        then checkout `base`.
      - Any OTHER branch, CLEAN tree: plain checkout to `base` (safe —
        there is nothing to carry along).
      - Any OTHER branch, DIRTY tree (or `git status` itself failing, which
        is treated the same — fail closed): refuse and touch NOTHING —
        `(False, 'on an unexpected branch with uncommitted changes —
        resolve manually')`. A `git checkout base` here would silently
        carry compatible uncommitted changes onto base's working tree while
        reporting ok=True; committing them is equally off-limits (not our
        changes). Manual resolution is the only honest option.
      - `git_current_branch` failing (not a repo, or any git error) trips
        none of the above, so the checkout is attempted directly and its
        own error reported — honest failure, no guessing.
    """
    try:
        cur_ok, current = git_current_branch(project_dir)
        if cur_ok and current == base:
            return True, "already on base"
        if cur_ok and current.startswith("scprism/"):
            dirty_ok, detail = git_is_dirty(project_dir)
            if dirty_ok and detail == "dirty":
                _wip_commit(project_dir, "scprism: wip (run ended mid-step)")
        elif cur_ok:
            dirty_ok, detail = git_is_dirty(project_dir)
            if (not dirty_ok) or detail == "dirty":
                return (
                    False,
                    "on an unexpected branch with uncommitted changes — "
                    "resolve manually",
                )
        return git_checkout(project_dir, base)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return False, str(exc)


def _refusal_verdict(contract: Any, vault: str, reason: str) -> "Verdict":
    """Fail a project step BEFORE any model call: mirrors the shape
    `loop.run` builds for a `project_error` (see loop.py's `if project_error
    is not None:` block) — a synthetic failed `Tier1Result` carrying the
    reason, `tier2_result=None` so Tier-2 is short-circuited exactly like a
    real Tier-1 failure. `build_verdict` needs no loop-internal objects (just
    the contract's task_id + a Tier1Result), so it is called directly here —
    no gateway, no dispatch, no `loop.run` invocation at all."""
    from .writeback import build_verdict, write_verdict
    from .verifier import Tier1Result, CommandResult

    t1 = Tier1Result(
        passed=False,
        commands=[
            CommandResult(
                command="project:existing_mode",
                returncode=1,
                stdout="",
                stderr=reason,
            )
        ],
        tokens=0,
    )
    verdict = build_verdict(
        task_id=contract.task_id,
        tier1_result=t1,
        tier2_result=None,
        tokens_spent=0,
    )
    write_verdict(verdict, vault)
    return verdict


def run_project(
    intent: str,
    *,
    token_budget: int = 0,
    project_dir: str,
    vault: str,
    verify_command: str = "",
    context: str = "",
    refine_feedback: str = "",
    attempt: int = 0,
    attempt_group: str = "",
    previous_verdict: str = "",
    data_samples: Sequence[str] = (),
    never_touch: Sequence[str] = (),
    existing_mode: bool = False,
    slug: str = "",
    run_branch: str = "",
    model: Optional["ModelCall"] = None,
    roster: Optional[List["AgentSpec"]] = None,
    skill_catalog: Optional[List["CatalogEntry"]] = None,
    memory: Optional["MemoryStore"] = None,
    # Governed tool source for the step's dispatch — duck-typed like
    # `loop.run`'s own `mcp_client` (WebToolProvider / VaultToolProvider /
    # CompositeToolClient / a gate wrapping one). None -> byte-identical.
    mcp_client: Optional[Any] = None,
    # The Telemetry the CALLER built its tool providers with, handed through
    # to `loop.run` so the providers' tool_exec spans and the run's own spans
    # share ONE run_id (the F3 phantom-run lesson). None -> loop.run builds
    # its own, exactly as before.
    telemetry: Optional["Telemetry"] = None,
    grants: Optional["capabilities.AgentGrants"] = None,
    writer_agent: str = "",
    # The PHASE this step is, in the user's own plan words. Written onto the
    # step's model_call spans as `round`, which is what the crew board groups
    # its columns by — so a four-step plan draws four columns instead of one
    # anonymous "Working". Empty writes no attr (byte-identical).
    stage: str = "",
) -> "Verdict":
    """Run one project step end to end through the SAME verified loop.

    Builds the step prompt (intent + optional project brief + optional
    refine feedback + the fixed FILE-block format instructions), dispatches
    it through `loop.run`, and wires a `post_dispatch` closure that validates
    and writes any FILE blocks the completion contains BEFORE Tier-1 runs —
    so a `verify_command` observes the files just written. A passing verdict
    is checkpointed into git; the checkpoint result and the write/reject
    ledger are recorded on `verdict.extras["project"]`.

    The FILE-block instructions are the LAST thing in the prompt on every turn
    (recency: they are the last words before the model answers), and a
    completion carrying no blocks is not accepted in silence — `FileBlockContract`
    asks once more, explicitly, and if the second reply is also analysis the
    Verdict says exactly that instead of a generic failure. This applies to a
    FIRST build as much as to a refine: both go through this same prompt builder
    and this same parser, so both can miss the contract the same way.

    A REFINE turn (`refine_feedback` non-empty) is additionally shown the CODE
    AS IT IS ON DISK — the previous attempt's files (`previous_verdict`'s
    `files_written`, or the project's most recently modified source files when
    no verdict is supplied), read back from disk and bounded by
    `REFINE_SOURCE_*`. `data_samples` (caller-supplied paths, quoted on EVERY
    turn) sample the head of real input data the task must handle, bounded by
    `DATA_SAMPLE_*`. Both sections label every cut they make and are stripped of
    FILE-block markers, so quoted content can never smuggle a write.

    `attempt` + `attempt_group` record this run as attempt N of ONE logical step:
    the pair lands on `verdict.extras["attempt"]` BEFORE the verdict is written
    (so the log.md line names it too) and appends to that group's ledger,
    `<vault>/verdicts/attempts/<group>.json`. Every attempt keeps its own verdict
    file either way; the ledger is what makes attempt 1 and attempt 2 readable as
    one run. The engine never INFERS the grouping — without both values, extras
    and disk layout are byte-identical to before.

    `roster` (P1-2): when given AND no explicit `model` was passed, the per-step
    doer is the role board (`team_model_adapter`) instead of a single model —
    each agent on its own provider, the lead synthesizing one completion in the
    SAME FILE-block format. Still ONE governed Verdict from `loop.run`'s finalize
    (never `run_team`); the Verdict's `models_used` lists the board's models. The
    board persists into THIS run's vault (SCPRISM_VAULT). `roster=None` (the
    default) or an explicit `model` leaves the single-doer path byte-identical.

    `mcp_client` (2026-08-28): an optional GOVERNED tool source (web / vault /
    composite, possibly gate-wrapped), threaded straight into `loop.run`
    exactly as `run`'s CLI threads its own — the single-doer step dispatch
    runs the same bounded, gated tool-use loop, so a plan step that says
    "research X first" no longer runs blind. `telemetry` rides along so the
    caller-built providers' tool_exec spans share this run's run_id. NOTE
    (seam left open on purpose, like `team_model_adapter`'s skill_catalog): a
    roster board is an INJECTED doer and `loop.run` builds its tool loop only
    for the gateway doer, so tools do not reach board agents yet. Both default
    None -> byte-identical.

    `existing_mode=True` (an attached, pre-existing folder rather than a
    fresh one `run_project` owns) additionally runs a branch-per-run git
    lifecycle BEFORE any model call:
      - `project_dir` must already exist, or the step fails closed with
        "project path does not exist — attach an existing folder".
      - Not yet a git repo -> `git init`; then the no-commits rule applies.
      - Zero commits -> runs exactly like new-mode (no branching); extras
        report `base_branch`/`run_branch` as `""`.
      - Current branch already matches `scprism/<slug>-*` -> RESUME on it
        (wip-commit any leftovers from a crashed prior step first); never
        branch off of a run branch. The engine cannot know the ORIGINAL base
        branch when resuming (that's the client's durable record, not
        recoverable from git state) — `base_branch` is reported `""` here
        and the caller should keep its own stored value.
      - Otherwise: a dirty tree fails closed BEFORE any model call (Global
        Constraints) with "working tree has uncommitted changes — commit or
        stash first". A clean tree records the current branch as `base`, then:
          - `run_branch=` (the caller's STORED branch from a PRIOR run that
            already returned to base via `project_finish`, e.g. after an
            'attention' verdict) names an EXISTING local branch -> resume it
            via `git_checkout` instead of creating a new numbered branch, so
            steps already committed on that branch are never abandoned.
            Checkout failure fails closed BEFORE any model call — refusal
            "could not resume run branch <name>: <reason>", base untouched.
          - Otherwise (no `run_branch=`, or it names a branch that no longer
            exists) -> creates `scprism/<slug>-<n>` via `next_run_branch` and
            checks it out, exactly as before.
        The base branch is never committed to either way.
      - The step prompt is prefixed with a read-only `repo_outline()` of the
        attached repo.
      - `verdict.extras["project"]["overwrote"]` lists which written paths
        already existed before this step (existing_mode only).
      - `base_branch`/`run_branch` are folded into extras["project"] and
        re-persisted (`append_log=False`) on BOTH pass and fail — unlike
        new-mode, where nothing is re-persisted on a failing verdict. This is
        the only extras/re-persist difference from new-mode.
    `existing_mode=False` (the default) is byte-identical to v1.
    """
    from .contract import parse
    from .loop import run
    from .writeback import attempts_index_path, record_attempt, write_verdict

    base_branch = ""
    # The caller's STORED run branch to try to resume (V2-5) — captured
    # BEFORE `run_branch` is repurposed below as "the branch this step
    # actually ran on" (what extras["project"]["run_branch"] reports).
    requested_run_branch = run_branch
    run_branch = ""

    if existing_mode:
        # Pre-flight, BEFORE makedirs/prompt: existing mode attaches to a
        # folder the caller says already exists — never silently create one
        # (that's new-mode's job), so a bad path fails closed immediately.
        if not os.path.isdir(project_dir):
            contract = parse(intent, mode="write")
            return _refusal_verdict(
                contract,
                vault,
                "project path does not exist — attach an existing folder",
            )

        repo_ok, _branch_or_reason = git_current_branch(project_dir)
        if not repo_ok:
            # Not (yet) a git repo -> git init, best-effort exactly like
            # git_checkpoint's own init step. If init itself fails, the dir
            # still has no commits either way, so the no-commits/new-mode
            # path below covers it honestly regardless.
            try:
                subprocess.run(
                    ["git", "init", "-q"],
                    cwd=project_dir,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
                pass

        if git_has_commits(project_dir):
            cur_ok, current = git_current_branch(project_dir)
            # FIX 2 (v2 final review): a repo WITH commits but an empty
            # current branch is a DETACHED HEAD (`git branch --show-current`
            # succeeds with '' there, same as the no-commits/unborn-HEAD
            # case) — fail closed BEFORE any model call rather than silently
            # branching off a headless checkout or reporting base_branch=''
            # the same way the harmless no-commits path does.
            if cur_ok and current == "":
                contract = parse(intent, mode="write")
                return _refusal_verdict(
                    contract,
                    vault,
                    "detached HEAD — check out a branch first",
                )
            resume_pattern = re.compile(rf"^scprism/{re.escape(slug)}-\d+$")
            if cur_ok and resume_pattern.match(current):
                # Resume rule checked BEFORE the dirty check: a resumed
                # branch's leftovers get wip-committed, never a refusal —
                # and we never branch off of a run branch.
                dirty_ok, detail = git_is_dirty(project_dir)
                if dirty_ok and detail == "dirty":
                    _wip_commit(project_dir, "scprism: wip (resumed)")
                run_branch = current
                base_branch = ""  # unrecoverable from git state on resume
            else:
                dirty_ok, detail = git_is_dirty(project_dir)
                # Fail CLOSED here (unlike the best-effort wip-commit above):
                # this gates whether we're about to branch off the user's
                # base branch at all, so a `git status` error is treated the
                # same as "dirty" rather than silently proceeding.
                if (not dirty_ok) or detail == "dirty":
                    contract = parse(intent, mode="write")
                    return _refusal_verdict(
                        contract,
                        vault,
                        "working tree has uncommitted changes — commit or stash first",
                    )
                base_branch = current if cur_ok else ""
                # V2-5: a caller-supplied STORED run branch (from a prior run
                # that already returned to base via `project_finish`, e.g.
                # after an 'attention' verdict) is resumed in place of
                # creating a new numbered branch — so steps already committed
                # on it are never abandoned. Only when it still names a REAL
                # local branch; a missing/stale value falls through to the
                # normal next_run_branch creation below exactly as before.
                if requested_run_branch and git_branch_exists(
                    project_dir, requested_run_branch
                ):
                    resumed_ok, resume_reason = git_checkout(
                        project_dir, requested_run_branch
                    )
                    if not resumed_ok:
                        # Fail CLOSED before any model call, same discipline
                        # as the create-failure branch below: HEAD is still
                        # on the USER'S BASE branch — never proceed with
                        # extras reporting a run branch we never actually
                        # checked out.
                        contract = parse(intent, mode="write")
                        return _refusal_verdict(
                            contract,
                            vault,
                            f"could not resume run branch {requested_run_branch}: "
                            f"{resume_reason}",
                        )
                    run_branch = requested_run_branch
                else:
                    run_branch = next_run_branch(project_dir, slug)
                    created_ok, create_reason = git_checkout_new_branch(
                        project_dir, run_branch
                    )
                    if not created_ok:
                        # Fail CLOSED before any model call: if `checkout -b`
                        # failed (invalid refname from an unsanitized slug, a
                        # branch literally named `scprism` blocking the
                        # namespace, an index lock), HEAD is still on the USER'S
                        # BASE branch — proceeding would commit a passing step
                        # onto base while extras report a run branch that was
                        # never created.
                        contract = parse(intent, mode="write")
                        return _refusal_verdict(
                            contract,
                            vault,
                            f"could not create run branch {run_branch}: {create_reason}",
                        )
        # else: zero commits -> run as new-mode; base_branch/run_branch stay "".
    elif os.path.isdir(project_dir):
        # FIX 3 (v2 final review): new-mode owns FRESH directories only —
        # v1's acceptance flows target a project_dir that doesn't exist yet
        # or is empty. If it already exists AND is a real git work tree AND
        # has commit history, this is someone's actual repo; proceeding
        # would write/overwrite files into it with none of existing-mode's
        # branch-per-run safety net. Fail closed before any model call, and
        # point the caller at the right entry point. Fresh dirs (not a repo
        # at all) and no-commit dirs (`git init`ed but never committed) are
        # unaffected — git_current_branch/git_has_commits report False.
        #
        # FIX A (re-verdict): FOREIGN repos only. A multi-step new-mode
        # project legitimately re-enters here from step 2 on: step 1's
        # git_checkpoint init+committed the dir under the fixed scprism
        # identity, so "has commits" alone would brick every multi-step new
        # project after its first passing step. Discriminator: the ROOT
        # commit's author email — scprism's checkpoints always commit as
        # engine@scprism.local, and the root commit of a dir WE initialized
        # is always ours. Ours -> proceed exactly as before the guard
        # existed; anyone else's -> the refusal; the probe itself erroring
        # -> fail CLOSED to the refusal (foreign until proven ours), with
        # the git reason appended.
        repo_ok, _branch_or_reason = git_current_branch(project_dir)
        if repo_ok and git_has_commits(project_dir):
            author_ok, email_or_reason = git_root_commit_author_email(project_dir)
            if not (author_ok and email_or_reason == _SCPRISM_EMAIL):
                reason = (
                    "this folder is already a git repository with history — "
                    "use Attach existing instead"
                )
                if not author_ok:
                    reason += f" (ownership check failed: {email_or_reason})"
                contract = parse(intent, mode="write")
                return _refusal_verdict(contract, vault, reason)

    # A fresh (new-mode) project has no directory on disk yet. Create it
    # FIRST — before the prompt/loop even builds — so validate_project_path's
    # ancestor-walk resolves inside a REAL project_dir instead of finding some
    # existing ancestor above it and rejecting every write as "outside the
    # project". A no-op for existing_mode (the pre-flight above already
    # required the dir to exist).
    os.makedirs(project_dir, exist_ok=True)

    prompt = intent
    if existing_mode:
        prompt = (
            f"Repository context (read-only outline):\n{repo_outline(project_dir)}\n\n"
            + prompt
        )
    if context:
        prompt += f"\n\nProject brief:\n{context}"
    if refine_feedback:
        prompt += (
            "\n\nThe previous attempt FAILED verification with this output "
            f"— fix it:\n{refine_feedback}"
        )
        # A refine turn is shown the code it is fixing. Without this the model
        # is asked to repair source it cannot see, which is not a repair — it is
        # a second independent guess, and two runs of this loop produced exactly
        # that (two different wrong parsers for the same failing tests). Prefer
        # the previous attempt's OWN file list (exact, from its verdict); fall
        # back to the project's most recently modified source files when no
        # verdict was supplied, so a bare CLI refine is helped too.
        source_paths = previous_files_written(previous_verdict) or recent_source_files(
            project_dir
        )
        # Leftovers of THIS step's own failed attempts are named, never quoted
        # (see failed_step_files): quoting them back compounded every retry's
        # context in the 2026-08-29 incident until the doer echoed the
        # instructions instead of producing FILE blocks. Untracked runs (no
        # attempt_group) have no ledger and are byte-identical to before.
        prompt += current_source_excerpt(
            project_dir,
            source_paths,
            unblessed=failed_step_files(vault, attempt_group),
        )
    # Real input data, on EVERY turn (attempt 1 needs the shape as much as a
    # refine does) — caller-supplied paths only, bounded and labelled.
    if data_samples:
        prompt += data_sample_excerpt(data_samples)
    prompt += "\n\n" + FILE_BLOCK_INSTRUCTIONS

    # The task_id is slugged from the RAW INTENT, never from the decorated
    # prompt. `parse` would otherwise slug whatever the prompt happens to start
    # with, so an existing-mode step is filed under
    # `repository-context-read-only-outline-fil-<uuid>` and a refine attempt is
    # unfindable next to the attempt it is fixing — the run is on disk, but under
    # a name describing our own prompt scaffolding rather than the user's task.
    # Everything else about the contract is unchanged; the uuid suffix still
    # makes every attempt its own file, so nothing is ever overwritten.
    # The step's own envelope, when the caller set one — omit-means-default,
    # the same discipline the CLI flag documents. 0/negative never narrows.
    _budget_kw = {"token_budget": token_budget} if token_budget > 0 else {}
    contract = parse(prompt, mode="write", task_id=_intent_task_id(intent), **_budget_kw)

    # Roster path (P1-2): a roster + NO explicit model makes the per-step doer
    # the role board — each agent on its own provider, the lead synthesizing ONE
    # completion carrying the SAME FILE blocks the single doer would. `loop.run`
    # still produces the single governed Verdict below (no `run_team`, so no
    # doubled spans/tokens/verdict). An explicit `model` always wins: the board
    # only builds a doer when none was passed, so `roster=None` is byte-identical
    # to the single-doer path.
    #
    # Skill disclosure (P3-1): on the roster path skills disclose PER-AGENT
    # THROUGH THE BOARD (a `roles: developer` skill reaches only the developer,
    # a global skill reaches every agent) — so the catalog goes to the adapter
    # and `loop.run` gets None (`loop_skill_catalog`). Were `loop.run` ALSO given
    # the catalog it would disclose it GLOBALLY (`disclose(intent, catalog)`,
    # role="") into the shared prompt reaching every board agent, both double-
    # injecting global skills and leaking role-tagged skills to all agents (the
    # role scoping would be a no-op). Attribution is preserved: the board's
    # per-agent disclosed union rides out on its ModelResult -> dispatch ->
    # `Verdict.disclosed`. The single-doer path (no roster) is unchanged —
    # `loop.run` still discloses globally, role tags ignored, byte-identical.
    loop_skill_catalog = skill_catalog
    # A REFINE turn runs on the LEAD alone, never the whole board (2026-08-29).
    # Measured live on the first real build: a four-seat board step takes
    # 15-20 minutes end to end, and a failed step re-ran the ENTIRE board to
    # apply one piece of feedback — the single biggest time-eater of the day.
    # A refine is the lead's kind of work by definition: it holds the previous
    # attempt's files and the judge's feedback, and its job is a corrected
    # synthesis, not a new debate. Dropping the roster here takes the
    # single-doer path on the primary — the seat the lead sits on. First
    # attempts keep the full board, byte-identical.
    if roster and refine_feedback:
        roster = None
    if roster and model is None:
        from .team import team_model_adapter

        # CRITICAL (P1-1 flagged a leaked temp dir otherwise): point the board's
        # persistence at THIS run's vault. Start from the process env so each
        # agent's provider config routes exactly as a normal run would, then
        # force SCPRISM_VAULT to the run vault.
        board_env = dict(os.environ)
        board_env["SCPRISM_VAULT"] = vault
        model = team_model_adapter(
            roster,
            env=board_env,
            # The same per-step budget the loop enforces on this contract — the
            # board caps itself at the same ceiling (a positive value caps;
            # 0/absent would leave the loop's own budget machinery authoritative).
            token_budget=contract.token_budget,
            # ONE format source: the exact string the single-doer prompt appended.
            file_block_instructions=FILE_BLOCK_INSTRUCTIONS,
            # Per-agent role disclosure happens INSIDE the board (see above).
            skill_catalog=skill_catalog,
            # The plan step this board is working, so its per-agent spans carry
            # the phase and the crew board can draw one column per step. Without
            # it every step's spans say "round 1" and a four-step plan collapses
            # into one column.
            stage=stage,
        )
        # ...and NOT again globally in loop.run (would leak role-tagged skills to
        # every agent + double-inject globals).
        loop_skill_catalog = None

    # The output contract, enforced for EVERY project turn — a first build can
    # answer with analysis-and-no-blocks exactly as a refine turn can (same
    # prompt builder, same parser), so both get the same one-shot correction and
    # the same honest reason.
    file_block_contract = FileBlockContract()

    def post(completion: str) -> Dict[str, Any]:
        ops = parse_file_blocks(completion)
        # FIX 2: Filter out instruction-echo blocks (the exact instruction
        # example that a parroting model might return).
        filtered_ops = []
        for path, content in ops:
            # Skip if path is exactly the instruction example path
            if path == "relative/path.ext":
                continue
            # Skip if content is exactly the instruction example content (strip
            # for comparison)
            if content.strip() == "<full file content>":
                continue
            filtered_ops.append((path, content))

        if not filtered_ops:
            raise ProjectStepError(file_block_contract.no_blocks_reason(bool(ops)))

        # existing_mode only: snapshot which of the would-be destinations
        # already exist BEFORE apply_file_ops writes anything. A plain
        # os.path.exists of the would-be dest is enough here (no need to
        # redo validate_project_path's boundary check) — any op that
        # apply_file_ops later rejects simply never lands in "written",
        # so it's naturally excluded from "overwrote" below.
        pre_existing: Dict[str, bool] = {}
        if existing_mode:
            root = os.path.realpath(project_dir)
            for path, _content in filtered_ops:
                norm = os.path.normpath(path)
                dest = os.path.join(root, norm)
                if os.path.exists(dest):
                    pre_existing[norm] = True

        result = apply_file_ops(
            filtered_ops, project_dir, never_touch, grants=grants, agent=writer_agent
        )
        if not result["written"]:
            first_reason = (
                result["rejected"][0]["reason"]
                if result["rejected"]
                else "no ops accepted"
            )
            raise ProjectStepError("all file writes rejected: " + first_reason)
        # Renamed to the Verdict-facing project-dict schema (files_written /
        # rejected / git_checkpoint) so callers never see the internal
        # apply_file_ops key names.
        project_dict = {"files_written": result["written"], "rejected": result["rejected"]}
        if existing_mode:
            project_dict["overwrote"] = [
                p for p in result["written"] if p in pre_existing
            ]
        return project_dict

    # Attempt lineage (F1). Recorded on the Verdict BEFORE it is written, so the
    # attempt number is in the first bytes on disk and in the log.md line — not
    # patched on afterwards, where a reader of either could still be told the
    # wrong story. `attempt`/`attempt_group` are caller-supplied: the engine
    # never GUESSES that two runs belong to the same logical step (only the
    # driver knows that), so an untracked run's extras stay byte-identical.
    attempt_extras: Optional[Dict[str, Any]] = None
    if attempt_group and int(attempt or 0) > 0:
        attempt_extras = {
            "attempt": {
                "number": int(attempt),
                "group": attempt_group,
                "previous_task_id": _verdict_task_id(previous_verdict),
                "is_refine": bool(refine_feedback),
                # Deterministic from (vault, group) — known before the run, so
                # the pointer is in the verdict's FIRST write rather than added
                # by a later re-persist that a failing run never performs.
                "index": os.path.relpath(
                    attempts_index_path(vault, attempt_group), vault
                ),
            }
        }

    verdict = run(
        contract,
        vault=vault,
        tier1_commands=[verify_command] if verify_command else [],
        tier1_cwd=project_dir,
        post_dispatch=post,
        model=model,
        # The governed tool source + the caller's Telemetry (see the signature
        # comments): the single-doer dispatch runs the same bounded, gated
        # tool-use loop `run` does. Both None -> byte-identical.
        mcp_client=mcp_client,
        telemetry=telemetry,
        skill_catalog=loop_skill_catalog,
        # LF-1: surface the vault's profile + L3 notes as memory candidates. On
        # the roster path the prefix reaches the board via the injected-model
        # wrapper. Default None (direct callers/tests) -> byte-identical.
        memory=memory,
        verdict_extras=attempt_extras,
        # Bounded one-shot enforcement of the FILE-block contract (see
        # FileBlockContract). Wraps whichever doer the loop built — gateway,
        # injected model, or the role board.
        dispatch_wrapper=file_block_contract.wrap,
        stage=stage,
    )

    # Link this attempt to its siblings. The ledger holds no fact of its own —
    # every field is copied from the verdict already persisted above — so it can
    # be deleted and rebuilt without loss, and a reader that ignores it sees
    # exactly what it saw before.
    if attempt_extras is not None:
        att = attempt_extras["attempt"]
        record_attempt(
            verdict,
            vault,
            group=att["group"],
            number=att["number"],
            previous_task_id=att["previous_task_id"],
        )

    if verdict.passed:
        checkpoint = git_checkpoint(project_dir, f"scprism: {intent[:72]}")
        info = verdict.extras.get("project")
        if info is None:
            info = {"files_written": [], "rejected": []}
            verdict.extras["project"] = info
        info["git_checkpoint"] = checkpoint
        if existing_mode:
            info["base_branch"] = base_branch
            info["run_branch"] = run_branch
        # FIX 1: Re-persist the verdict to disk after adding git_checkpoint
        # (+ base_branch/run_branch in existing mode — folded into this SAME
        # re-persist, not a second one), using the same atomic writer that
        # loop.run uses. append_log=False: loop.run already appended ONE
        # log.md line for this task_id; this re-persist only needs to update
        # the verdict JSON, not log the same step a second time (E2).
        write_verdict(verdict, vault, append_log=False)
    elif existing_mode:
        # Unlike new-mode (nothing re-persisted on a failing verdict, extras
        # unchanged — byte-identical to v1), existing mode must still report
        # which branches this step ran on even when it failed, since the
        # client's driver needs base_branch/run_branch either way.
        info = verdict.extras.get("project")
        if info is None:
            info = {"files_written": [], "rejected": []}
            verdict.extras["project"] = info
        info["base_branch"] = base_branch
        info["run_branch"] = run_branch
        write_verdict(verdict, vault, append_log=False)

    return verdict
