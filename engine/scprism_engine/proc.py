"""Bounded subprocess execution — a timeout that can actually fire.

``subprocess.run(..., capture_output=True, timeout=T)`` is not a bound we can
rely on for the programs this engine shells out to (agentic CLIs, the Tier-1
verify shell). Two independent reasons, both observed in the user's own spans:

1. **It kills only the DIRECT child.** `claude`/`codex`/`gemini` are node
   programs that spawn children, and `sh -c "npm test"` is a shell whose real
   work is a grandchild. On expiry `run()` signals the one process it started;
   every grandchild keeps running, keeps the inherited stdout/stderr pipe open,
   and keeps burning CPU and tokens after we have already given up on it.

2. **Its clock stops when the Mac sleeps.** `Popen.communicate(timeout=…)`
   measures with `time.monotonic()`, which on macOS is `mach_absolute_time()` —
   it does NOT advance while the system is asleep. A wake that starts on a
   maintenance DarkWake and then sleeps sits there for the better part of an
   hour of WALL time without ever reaching a 180s monotonic bound, while the
   app's own cancel (a wall-clock timer) fired long ago. The result is a call
   nobody is waiting for any more.

So this module runs the child in its own session (process group), enforces the
bound on the LONGER of the monotonic and wall clocks, and terminates the WHOLE
group on expiry — SIGTERM, a short grace, then SIGKILL.

WHY THIS CANNOT BLOCK PAST THE BOUND. The calling thread only ever waits on
finite waits: a poll loop with an explicit deadline, `Thread.join(timeout=…)`,
and `Popen.wait(timeout=…)` inside try/except. It never calls
`Popen.communicate()`, never calls `Popen.wait()` without a timeout, and never
uses `Popen` as a context manager (whose `__exit__` calls `wait()` unbounded).
The pipes are drained by DAEMON threads, so a grandchild that somehow escaped
the group and still holds the pipe can leave a reader thread parked forever
without delaying this function or process exit. Worst case return is
``timeout + TERM_GRACE + KILL_GRACE + 2 * READ_GRACE`` (one READ_GRACE per
pipe) — about 7s of slack on top of the bound, and ~0 on the normal path.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Union

# After SIGTERM, how long the group gets to leave on its own before SIGKILL.
TERM_GRACE = 2.0
# After SIGKILL, how long we wait to reap the direct child.
KILL_GRACE = 1.0
# How long we wait for the reader threads to hand over what they read. On the
# normal path the pipes hit EOF the moment the group dies, so this is ~0.
READ_GRACE = 2.0
# Poll granularity of the deadline loop.
POLL = 0.05


@dataclass
class BoundedResult:
    """Outcome of a bounded run. ``timed_out`` is the honest signal: the child
    did not finish inside the bound and its whole process group was killed."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool


def _elapsed(mono0: float, wall0: float) -> float:
    """Seconds gone by the LONGER of the two clocks.

    Wall time catches a system sleep (monotonic freezes on macOS); monotonic
    catches a wall clock stepped backwards by NTP. Whichever says more time has
    passed wins, so neither one can hide an expired bound.
    """
    return max(time.monotonic() - mono0, time.time() - wall0)


def _reader(pipe: Any, sink: List[str]) -> threading.Thread:
    """Daemon thread draining `pipe` line by line into `sink`.

    Line-wise (not `.read()`) so whatever the child printed before it was killed
    is still available; daemon so a pipe that never reaches EOF — a grandchild
    outside our group still holding the write end — can never keep us, or the
    interpreter, alive.
    """

    def _pump() -> None:
        try:
            for line in pipe:
                sink.append(line)
        except Exception:  # pipe closed / decoding died — nothing to salvage
            pass

    t = threading.Thread(target=_pump, daemon=True)
    t.start()
    return t


def _own_pgid() -> Optional[int]:
    try:
        return os.getpgid(0)
    except Exception:
        return None


def _signal_group(proc: "subprocess.Popen[str]", pgid: Optional[int], sig: int) -> None:
    """Signal the child's whole process group, falling back to the child alone.

    SAFETY: we never signal our OWN group. If `start_new_session` did not take
    effect the child shares our group, and `killpg` would take down the engine
    (and, in tests, the test runner) with it.
    """
    if pgid is not None and pgid != _own_pgid():
        try:
            os.killpg(pgid, sig)
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.send_signal(sig)
    except Exception:  # already reaped
        pass


def _wait_bounded(proc: "subprocess.Popen[str]", seconds: float) -> bool:
    """Wait up to `seconds` for the direct child; True if it exited."""
    try:
        proc.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return proc.poll() is not None


def _kill_group(proc: "subprocess.Popen[str]") -> None:
    """Escalate to the whole group: SIGTERM → grace → SIGKILL → grace."""
    try:
        pgid: Optional[int] = os.getpgid(proc.pid)
    except Exception:
        pgid = None
    _signal_group(proc, pgid, signal.SIGTERM)
    if _wait_bounded(proc, TERM_GRACE):
        # The leader is gone; sweep the group anyway so a child that outlived
        # its own parent (the node grandchild case) goes with it.
        _signal_group(proc, pgid, signal.SIGKILL)
        return
    _signal_group(proc, pgid, signal.SIGKILL)
    _wait_bounded(proc, KILL_GRACE)


def run_bounded(
    cmd: Union[str, Sequence[str]],
    *,
    timeout: float,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    shell: bool = False,
    stdin_devnull: bool = True,
) -> BoundedResult:
    """Run `cmd`, capturing output, with a bound that is actually enforceable.

    Returns a BoundedResult; raises only what `Popen` itself raises (OSError for
    a missing program / unenterable cwd), exactly like `subprocess.run`.

    `stdin_devnull` (default) closes the door on the other silent hang: a CLI
    that decides to prompt gets EOF instead of waiting for a human forever.
    """
    kwargs: Dict[str, Any] = dict(
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL if stdin_devnull else None,
        cwd=cwd,
        env=env,
        shell=shell,
        text=True,
        errors="replace",
    )
    if hasattr(os, "setsid"):
        # Own session → own process group → we can kill the whole tree, and the
        # child gets no controlling terminal to prompt on.
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **kwargs)  # type: ignore[call-overload]
    out: List[str] = []
    err: List[str] = []
    readers = [_reader(proc.stdout, out), _reader(proc.stderr, err)]

    mono0, wall0 = time.monotonic(), time.time()
    timed_out = False
    while True:
        if proc.poll() is not None:
            break
        if _elapsed(mono0, wall0) >= timeout:
            timed_out = True
            _kill_group(proc)
            break
        time.sleep(POLL)

    for reader, pipe in zip(readers, (proc.stdout, proc.stderr)):
        reader.join(READ_GRACE)
        if not reader.is_alive() and pipe is not None:
            try:
                pipe.close()
            except Exception:
                pass

    rc = proc.poll()
    if rc is None:
        # Killed but not reapable inside the bound (a stopped/uninterruptible
        # child). Report the kill honestly rather than waiting on it.
        rc = -signal.SIGKILL
    return BoundedResult(
        returncode=rc,
        stdout="".join(out),
        stderr="".join(err),
        timed_out=timed_out,
    )
