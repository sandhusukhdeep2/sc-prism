"""Two-tier Verifier.

Tier-1 (deterministic, ZERO tokens): run given shell commands — tests, lint,
build — via subprocess. Pass/fail + captured logs. This is the truth gate.

Tier-2 (LLM-eval, STUB): only runs if Tier-1 passed. Scores the trace on a
0..1 scale. Here it is a deterministic stub standing in for a DeepEval /
LLM-judge call. If Tier-1 fails we SHORT-CIRCUIT — Tier-2 never runs.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import proc as proc_util
from . import toolpath

# Shell words that are NOT a program on PATH, so a pre-flight `which` on them
# would be a false alarm.
_SHELL_BUILTINS = frozenset(
    {
        "cd", "echo", "export", "set", "unset", "source", ".", "exec", "eval",
        "exit", "test", "[", "true", "false", "read", "shift", "trap", "wait",
        "if", "for", "while", "until", "case", "then", "do", "done", "fi",
    }
)

# Exit code /bin/sh uses for "command not found".
_EXIT_NOT_FOUND = 127

# npm's exit code when it cannot read a package.json — "there is no project
# here", which is a WORKING-DIRECTORY problem, not a failing test.
_EXIT_NO_PROJECT = 254

# What a build tool prints when it looked for a project in the cwd and found
# none. Matched case-insensitively, and only alongside `_EXIT_NO_PROJECT`, so a
# test that merely mentions ENOENT in its output can never be laundered into
# "the gate could not run".
_NO_PROJECT_MARKERS = ("enoent", "could not read package.json")

# Programs whose "<x>: command not found" line we trust as the SHELL speaking.
# Anything else printing those words is a program's own output, not the shell's.
_SHELL_NAMES = frozenset({"sh", "bash", "zsh", "dash", "ksh", "ash"})

# "zsh: command not found: npm"
_ZSH_NOT_FOUND = re.compile(r"^([^:]+):\s*command not found:\s*(\S+)$")
# "sh: npm: command not found" · "bash: line 1: npm: command not found"
# "/bin/sh: 1: npm: not found"
_SH_NOT_FOUND = re.compile(
    r"^([^:]+):\s*(?:line\s+)?(?:\d+:\s*)?([^:]+):\s*(?:command )?not found$"
)


def _shell_missing_binary(stderr: str) -> Optional[str]:
    """The program name the SHELL itself said it could not find, or None.

    Exit 127 alone is not proof: a test runner is free to exit 127 and to print
    the words "not found" for its own reasons. Only the shell's own
    ``<shell>: <name>: command not found`` line names a missing program, and the
    name it prints is the INNER one — ``cd app && npm test`` reports ``npm``,
    never the head word ``cd``.
    """
    for raw in (stderr or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        for pattern in (_ZSH_NOT_FOUND, _SH_NOT_FOUND):
            m = pattern.match(line)
            if m and os.path.basename(m.group(1).strip()) in _SHELL_NAMES:
                name = m.group(2).strip()
                if name:
                    return name
    return None


def _no_project_here(returncode: int, text: str) -> bool:
    """True when the verify command's OWN tooling found no project in the cwd.

    npm exits 254 with ``npm error code ENOENT`` / ``Could not read
    package.json`` when it walks up from the working directory and never finds a
    manifest. That is the packaged app's failure mode (Tier-1 inheriting the app
    bundle's directory) and it is emphatically NOT a failing test.
    """
    if returncode != _EXIT_NO_PROJECT:
        return False
    low = (text or "").lower()
    return any(marker in low for marker in _NO_PROJECT_MARKERS)


def _head_binary(command: str) -> Optional[str]:
    """The program a command line starts with, when that is decidable.

    ``npm test`` -> ``npm``. Returns None for anything we should not pre-check:
    a shell builtin, an env-assignment prefix, an absolute/relative path, or a
    line that starts with shell syntax (``(``, ``VAR=x``, a pipeline …).
    """
    head = command.strip().split()
    if not head:
        return None
    word = head[0]
    if "=" in word or word.startswith(("(", "{", "$", "`", "!", "#")):
        return None
    if word in _SHELL_BUILTINS:
        return None
    if os.sep in word:  # an explicit path — the shell's own error is accurate
        return None
    if not all(c.isalnum() or c in "-_.+" for c in word):
        return None
    return word


def not_found_message(binary: str) -> str:
    """The HONEST failure text for a verify command that does not exist.

    A missing command is a CONFIGURATION problem, not a failing test, and the
    page that reads this log must not be able to confuse the two.
    """
    return (
        f"verify command not found: {binary} — the deterministic gate could not "
        f"run it, so nothing was actually verified. This is not a test failure. "
        f"Install {binary}, or fix the verify command in Settings → interview."
    )


def no_project_message(command: str, cwd: Optional[str]) -> str:
    """HONEST failure text for "the verify command found no project here"."""
    where = cwd or "the directory the app itself runs in"
    return (
        f"the verify command could not find a project in {where} — `{command}` "
        f"reported ENOENT (no package.json / project manifest there), so nothing "
        f"was actually verified. This is not a test failure. Point the run at the "
        f"right folder, or fix the verify command in Settings → interview."
    )


# What the gate says when it HAS a verify command but was never told which
# directory to run it in. It must never guess: running a project's tests in
# whatever directory the app happens to live in produces a failure that reads
# exactly like a real one (that is precisely how the packaged app manufactured
# 53 "saves" out of 53 runs that never verified anything).
#
# Nor may it FAIL. Tier-1 is a PROJECT gate: a chat message, a manager report
# and a heartbeat wake have no codebase, so `npm test` over them is not a check
# that can mean anything, and failing the run for not running it is a false
# negative that poisons every pass rate, agent stat and desk card downstream.
# "Nothing to verify" is therefore an honest SKIP with the reason recorded — not
# a pass that implies tests ran, and not a failure that implies they broke.
NOTHING_TO_VERIFY_MESSAGE = (
    "skipped — no project bound, nothing to verify. A verify command is "
    "configured, but this run has no project directory (a chat message, a "
    "manager report, a heartbeat wake), so there is no codebase to run it "
    "against. Nothing was checked: this is neither a pass nor a test failure. "
    "Attach a project (Projects → attach a folder) for its verify command to "
    "run on that project's work."
)

# What the gate says when it was handed no commands at all — this run simply
# has nothing to check. Still a skip, still said out loud: an empty gate must
# never read as "your checks passed".
NO_COMMANDS_MESSAGE = (
    "skipped — no verify command configured for this run, so there was nothing "
    "to check. Nothing was verified: this is not a pass."
)


def workspace_not_ready_message(commands: List[str], cwd: Optional[str]) -> str:
    """HONEST skip text for a bound workspace that has no project manifest YET.

    A NEW project's workspace legitimately lacks package.json until the plan
    step that writes it — step 1 writes PROJECT.md; the manifest arrives later.
    Failing the tier here blocks every early step on a check that CANNOT pass
    yet (what step 4 will create is not step 1's failure), so the gate takes
    the same honest skip an unbound run gets: not a pass, not a failure, the
    reason recorded.
    """
    named = ", ".join(f"`{c}`" for c in commands)
    where = cwd or "the working directory"
    return (
        f"skipped — the workspace has no project to verify yet. {named} ran in "
        f"{where} and found no package.json / project manifest (ENOENT) — "
        f"expected while early steps run before the step that creates it. "
        f"Nothing was checked: this is neither a pass nor a test failure. The "
        f"gate runs for real once the manifest exists."
    )


def cannot_enter_message(cwd: Optional[str], detail: str) -> str:
    """HONEST failure text for a working directory that cannot be entered."""
    return (
        f"the verify command could not run in {cwd!r}: {detail}. Nothing was "
        f"verified. This is not a test failure — the configured project folder is "
        f"missing or unreadable."
    )


@dataclass
class CommandResult:
    command: str
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False
    # True when the gate could not actually RUN this command — its program does
    # not exist, no working directory was configured, the directory cannot be
    # entered, or the command's own tooling found no project there. Kept
    # distinct from a genuine non-zero exit so the UI can say "nothing was
    # verified" instead of "your tests failed".
    not_found: bool = False
    # True for exactly the `_no_project_here` shape: the command RAN and its
    # own tooling reported no project manifest in the cwd. Kept distinct from
    # the other `not_found` causes (missing binary, unenterable directory)
    # because only this one self-heals as a build progresses — tier1 converts
    # an all-no-project run into an honest skip instead of a fail.
    no_project: bool = False
    # Absolute path the head binary resolved to, when it was resolvable. Logged
    # so a version mismatch is VISIBLE: the same `npm test` means something
    # different under ~/.local/bin/npm (node 22) than under an nvm shim (node
    # 20), and "it works in my terminal" is otherwise unfalsifiable.
    resolved: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


@dataclass
class Tier1Result:
    passed: bool
    commands: List[CommandResult] = field(default_factory=list)
    tokens: int = 0  # ALWAYS zero — Tier-1 is deterministic.
    # True when the gate did not run: no commands were supplied, or commands
    # were supplied with no project directory to run them in. `passed` is True
    # alongside it (there is nothing to disprove) — so every consumer MUST read
    # `skipped` before rendering a tick, or a gate that never ran reads as a
    # gate that passed. `skip_reason` is why, in the user's words.
    skipped: bool = False
    skip_reason: str = ""
    # The configured commands that were NOT run because of the skip. Empty when
    # there were none to begin with; `["npm test"]` when the user has a verify
    # command and this run simply had no codebase to point it at. Keeps
    # "you configured nothing" distinguishable from "nothing to verify here".
    skipped_commands: List[str] = field(default_factory=list)

    @property
    def failed_commands(self) -> List[str]:
        """Commands that did not exit 0 — what the gate actually caught."""
        return [c.command for c in self.commands if not c.ok]

    @property
    def missing_commands(self) -> List[str]:
        """Commands the gate could not RUN (a config gap, not a failure)."""
        return [c.command for c in self.commands if c.not_found]

    @property
    def resolved_binaries(self) -> Dict[str, str]:
        """command -> absolute path its head binary resolved to (when known)."""
        return {c.command: c.resolved for c in self.commands if c.resolved}

    @property
    def log(self) -> str:
        # A skipped gate ran nothing, so there is no command output — but an
        # EMPTY log reads as "no problems found". Say what happened instead.
        if self.skipped:
            unrun = "".join(f"\n$ {c}  # not run" for c in self.skipped_commands)
            return f"{self.skip_reason}{unrun}".strip()
        parts = []
        for c in self.commands:
            # The RESOLVED binary rides the log so "npm test passed for me" can
            # be checked against which npm actually ran.
            resolved = f"# resolved: {c.resolved}\n" if c.resolved else ""
            parts.append(
                f"$ {c.command}\n"
                f"{resolved}"
                f"[exit {c.returncode}"
                f"{' TIMEOUT' if c.timed_out else ''}]\n"
                f"{c.stdout}{c.stderr}".rstrip()
            )
        return "\n\n".join(parts)


@dataclass
class Tier2Result:
    """Outcome of the Tier-2 eval (LLM-judge + envelope gate).

    ``score`` and ``eval_score`` are kept in sync (``score`` is the historical
    field name; ``eval_score`` the specced one). ``passed`` already folds in
    BOTH the score gate and the envelope gate, so an envelope breach yields
    ``passed=False`` even when ``eval_score`` clears the threshold.
    """

    ran: bool
    score: float = 0.0
    threshold: float = 0.6
    passed: bool = False
    tokens: int = 0
    rationale: str = ""
    # E2 additions (specs/06). Defaults keep older call-sites valid.
    eval_score: float = 0.0
    metrics: Dict[str, float] = field(default_factory=dict)
    envelope_ok: bool = True
    breaches: List[str] = field(default_factory=list)
    envelope: Dict[str, Any] = field(default_factory=dict)
    observed: Dict[str, Any] = field(default_factory=dict)
    judge_notes: str = ""
    is_real: bool = False
    # Judge claims the DETERMINISTIC layer measured to be false — e.g. "the
    # artifact is truncated and provides no implementation" said of a run with
    # six files on disk and a green `npm test`. Non-empty means the judge erred
    # about a fact, not merely dissented on quality, and that is surfaced rather
    # than silently priced into a failing score (`evals.detect_contradictions`).
    contradictions: List[str] = field(default_factory=list)


def tier1(
    commands: List[str],
    *,
    cwd: Optional[str] = None,
    timeout: int = 120,
) -> Tier1Result:
    """Run deterministic checks. Zero tokens.

    All commands run; the tier passes only if every command exits 0. When there
    is NOTHING TO CHECK — no commands, or commands with no project directory to
    run them in — the tier is ``skipped`` with a recorded ``skip_reason`` and
    counts as passed (nothing to disprove). Skipped is not the same claim as
    passed, and every consumer must read the flag before drawing a tick.

    The shell runs with an ENRICHED PATH (``toolpath``): a GUI-launched app
    hands its children ``/usr/bin:/bin:...``, which cannot see Homebrew / npm /
    nvm installs — that alone failed this gate 51 runs in a row. When a verify
    command still cannot be found we fail HONESTLY (``not_found``) instead of
    passing a raw ``/bin/sh: npm: command not found`` off as a test failure.

    ``cwd`` carries a THREE-VALUE contract, because "which directory" is half
    of the same bug:

    * ``None``  — not supplied. The commands run in this process's own working
      directory, which is what a shell/CLI caller means (they chose it by
      standing there). Byte-identical to omitting the argument.
    * ``""``    — supplied and EMPTY: the caller has a verify command but knows
      no project directory. Nothing is run and the tier is SKIPPED with
      ``NOTHING_TO_VERIFY_MESSAGE`` — Tier-1 is a project gate, and a run with
      no codebase (chat, a manager report, a heartbeat wake) has nothing for it
      to check. It is emphatically NOT run in whatever directory the caller
      happens to occupy: inside the packaged app that is the bundle's engine
      folder, where `npm test` dies with ENOENT and reads exactly like a failing
      test. Nor is it a failure — failing a run for having no code to test is a
      false negative that poisons every pass rate downstream.
    * a path    — the commands run there. When every command's OWN tooling
      then reports there is no project manifest in that path (npm's ENOENT /
      exit 254), the tier is likewise SKIPPED with
      ``workspace_not_ready_message`` — a fresh build's workspace has no
      package.json until the step that writes it, and failing step 1 for
      lacking what step 4 will create blocks the build on an impossible check.
    """
    if not commands:
        return Tier1Result(
            passed=True,
            commands=[],
            tokens=0,
            skipped=True,
            skip_reason=NO_COMMANDS_MESSAGE,
        )

    if cwd is not None and cwd.strip() == "":
        # A verify command with no codebase to run it against. Skip, out loud.
        return Tier1Result(
            passed=True,
            commands=[],
            tokens=0,
            skipped=True,
            skip_reason=NOTHING_TO_VERIFY_MESSAGE,
            skipped_commands=list(commands),
        )

    env = toolpath.env_with_path()
    results: List[CommandResult] = []
    all_ok = True
    for cmd in commands:
        binary = _head_binary(cmd)
        resolved = toolpath.which(binary) if binary is not None else None
        if binary is not None and resolved is None:
            # Pre-flight: never let a missing program read like a failing test.
            # This lookup is EXACT (we resolved this exact name and missed), so
            # it is the only place allowed to name the head word as missing.
            results.append(
                CommandResult(
                    command=cmd,
                    returncode=_EXIT_NOT_FOUND,
                    stdout="",
                    stderr=not_found_message(binary),
                    not_found=True,
                )
            )
            all_ok = False
            continue
        try:
            # NOT `subprocess.run(timeout=…)`: the direct child here is the
            # SHELL, so its bound would kill `sh` and leave the real work (the
            # `npm`/`pytest` grandchild, a dev server it started) running with
            # our pipes in hand — and its clock stops while the Mac sleeps.
            # `run_bounded` kills the whole process group on the longer of the
            # wall and monotonic clocks. See proc.py.
            proc = proc_util.run_bounded(
                cmd,
                shell=True,
                cwd=cwd,
                timeout=float(timeout),
                env=env,
            )
            if proc.timed_out:
                results.append(
                    CommandResult(
                        command=cmd,
                        returncode=124,
                        stdout=proc.stdout,
                        stderr=proc.stderr,
                        timed_out=True,
                        resolved=resolved,
                    )
                )
                all_ok = False
                continue
            stderr = proc.stderr
            missing = False
            no_project = False
            shell_missing = (
                _shell_missing_binary(stderr)
                if proc.returncode == _EXIT_NOT_FOUND
                else None
            )
            if shell_missing is not None:
                # The SHELL said which program it could not find — e.g. the
                # inner `npm` of `cd app && npm test`. We report that name, not
                # the head word, and only when the shell actually said it: a
                # real test that exits 127 while printing "not found" for its
                # own reasons stays a test failure.
                missing = True
                stderr = f"{not_found_message(shell_missing)}\n{stderr}"
            elif _no_project_here(proc.returncode, f"{proc.stdout}{stderr}"):
                # The command RAN but its own tooling found no project in `cwd`
                # — the packaged app's failure mode. Nothing was verified.
                missing = True
                no_project = True
                stderr = f"{no_project_message(cmd, cwd)}\n{stderr}"
            cr = CommandResult(
                command=cmd,
                returncode=proc.returncode,
                stdout=proc.stdout,
                stderr=stderr,
                not_found=missing,
                no_project=no_project,
                resolved=resolved,
            )
        except OSError as exc:
            # A configured project folder that no longer exists / cannot be
            # entered. subprocess raises before the command ever runs.
            cr = CommandResult(
                command=cmd,
                returncode=_EXIT_NOT_FOUND,
                stdout="",
                stderr=cannot_enter_message(cwd, str(exc)),
                not_found=True,
                resolved=resolved,
            )
        results.append(cr)
        if not cr.ok:
            all_ok = False

    if results and all(c.no_project for c in results):
        # EVERY command hit the no-project wall: the bound workspace simply
        # does not contain a project manifest yet (a fresh build's early steps
        # run before the step that writes package.json). Same honest skip as
        # an unbound run — the conversion is all-or-nothing, so a run where
        # any command produced a real result keeps its failure contract above.
        return Tier1Result(
            passed=True,
            commands=[],
            tokens=0,
            skipped=True,
            skip_reason=workspace_not_ready_message(commands, cwd),
            skipped_commands=list(commands),
        )

    return Tier1Result(passed=all_ok, commands=results, tokens=0)


def tier2(trace, contract=None, *, threshold: float = 0.6) -> Tier2Result:
    """Deterministic Tier-2 STUB judge (no gateway, no tokens beyond a stub).

    This is the lightweight, gateway-free scorer kept for convenience and as a
    test double. The REAL, gateway-routed judge lives in ``evals.evaluate`` and
    is what the loop uses by default (specs/06 §1). The score is a stable
    function of the trace so tests are reproducible.

    `trace` may be any object exposing `step_results` (a DispatchResult) or a
    plain string; we degrade gracefully. `contract` is accepted (and ignored
    here) so this shares the real judge's ``(trace, contract)`` signature.
    """
    steps = getattr(trace, "step_results", None)
    if steps is None:
        # Treat as opaque text.
        text = str(trace)
        produced = len(text)
        n_steps = 1
    else:
        produced = sum(len(getattr(s, "output", "")) for s in steps)
        n_steps = max(1, len(steps))

    # Deterministic heuristic: reward having produced non-trivial output
    # across steps. Bounded to [0, 1].
    score = min(1.0, 0.5 + (produced / (n_steps * 200.0)))
    score = round(score, 4)

    passed = score >= threshold
    # Token cost of the (stubbed) judge — deterministic, non-zero.
    tokens = 50 + n_steps * 10
    rationale = (
        f"stub-judge: {n_steps} step(s), {produced} chars of output, "
        f"score={score} vs threshold={threshold} -> "
        f"{'PASS' if passed else 'FAIL'}"
    )
    # Mirror the score across the four named metrics so the Verdict shape is
    # coherent even on the stub path.
    metrics = {
        "trajectory_sensibility": score,
        "tool_use_accuracy": score,
        "acceptance_criteria_satisfaction": score,
        "task_completion": score,
    }
    return Tier2Result(
        ran=True,
        score=score,
        eval_score=score,
        metrics=metrics,
        threshold=threshold,
        passed=passed,
        envelope_ok=True,
        tokens=tokens,
        rationale=rationale,
        judge_notes=rationale,
    )
