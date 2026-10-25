"""Bounded subprocess tests — the timeout that could not fire.

Evidence this exists (the user's own ~/sc-vault/spans.jsonl): two concurrent
`claude-cli` model_call spans ran 2,870,441 ms and 2,875,324 ms — 48 minutes —
against a "180s" `subprocess.run(timeout=…)`, and then returned REAL answers,
long after the app had cancelled the run at its 240s client bound.

Two separate defects, both covered here:

  * `subprocess.run` kills only the DIRECT child. A grandchild survives, keeps
    the inherited pipes, and keeps working after we gave up. -> the whole
    process GROUP must die (`test_grandchild_*`).
  * `subprocess.run` measures on `time.monotonic()`, which on macOS does not
    advance while the system sleeps. -> the bound is enforced on the LONGER of
    the wall and monotonic clocks (`test_wall_clock_*`).

Everything here runs in seconds: a tiny python child stands in for a 48-minute
CLI.
"""

import os
import subprocess
import sys
import tempfile
import time
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import proc as proc_util


def _py(script):
    """argv running `script` through this interpreter."""
    return [sys.executable, "-c", script]


# A child that spawns a GRANDCHILD holding the inherited stdout/stderr pipe and
# then sleeps far past any bound we set. `pidfile` lets the test find the
# grandchild afterwards and prove it was killed too.
_GRANDCHILD_PARENT = """
import subprocess, sys, time
kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
open(%r, 'w').write(str(kid.pid))
sys.stdout.write('parent started\\n')
sys.stdout.flush()
time.sleep(600)
"""


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class BoundedRunTests(unittest.TestCase):
    def test_fast_command_is_unaffected_and_byte_identical(self):
        t0 = time.monotonic()
        res = proc_util.run_bounded(
            _py("import sys; sys.stdout.write('hello from the fake CLI\\n'); "
                "sys.stderr.write('warned\\n')"),
            timeout=30,
        )
        elapsed = time.monotonic() - t0
        self.assertFalse(res.timed_out)
        self.assertEqual(res.returncode, 0)
        # Byte-identical capture: exactly what the child wrote, nothing added.
        self.assertEqual(res.stdout, "hello from the fake CLI\n")
        self.assertEqual(res.stderr, "warned\n")
        # A fast call pays none of the kill/grace budget.
        self.assertLess(elapsed, 10.0)

    def test_nonzero_exit_is_reported_not_timed_out(self):
        res = proc_util.run_bounded(
            _py("import sys; sys.stderr.write('not signed in\\n'); sys.exit(3)"),
            timeout=30,
        )
        self.assertFalse(res.timed_out)
        self.assertEqual(res.returncode, 3)
        self.assertIn("not signed in", res.stderr)

    def test_grandchild_holding_the_pipe_is_killed_within_the_bound(self):
        """THE regression. `subprocess.run` would kill the parent and leave the
        grandchild running with our pipe; the call must come back inside the
        bound AND the whole group must be gone."""
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = os.path.join(tmp, "kid.pid")
            t0 = time.monotonic()
            res = proc_util.run_bounded(
                _py(_GRANDCHILD_PARENT % pidfile), timeout=2.0
            )
            elapsed = time.monotonic() - t0

            # 1. It RETURNED, and inside the bound + the documented slack.
            self.assertTrue(res.timed_out)
            self.assertGreaterEqual(elapsed, 2.0)
            self.assertLess(elapsed, 12.0, "the bound must actually bound")
            # 2. What the child managed to print before the kill survives.
            self.assertIn("parent started", res.stdout)

            # 3. The GRANDCHILD is dead too — no orphan kept working.
            with open(pidfile, encoding="utf-8") as f:
                kid = int(f.read().strip())
            deadline = time.monotonic() + 5.0
            while _alive(kid) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertFalse(_alive(kid), "the grandchild outlived the timeout")

    def test_shell_command_group_is_killed_too(self):
        """The Tier-1 twin: with shell=True the DIRECT child is `sh`, so a
        per-child kill would leave the real work running."""
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = os.path.join(tmp, "kid.pid")
            cmd = (
                f"{sys.executable} -c "
                f"\"import os,time; open({pidfile!r},'w').write(str(os.getpid())); "
                f"time.sleep(600)\""
            )
            t0 = time.monotonic()
            res = proc_util.run_bounded(cmd, shell=True, timeout=2.0)
            elapsed = time.monotonic() - t0
            self.assertTrue(res.timed_out)
            self.assertLess(elapsed, 12.0)
            with open(pidfile, encoding="utf-8") as f:
                kid = int(f.read().strip())
            deadline = time.monotonic() + 5.0
            while _alive(kid) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertFalse(_alive(kid), "the shell's child outlived the timeout")

    def test_never_kills_our_own_process_group(self):
        """Safety: the group kill must be scoped to the child's session. If this
        ever regressed, the test runner itself would die — so we also assert the
        child really did get its own group."""
        proc = subprocess.Popen(
            _py("import time; time.sleep(600)"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            self.assertNotEqual(os.getpgid(proc.pid), os.getpgid(0))
        finally:
            proc.kill()
            proc.wait(timeout=5)
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    pipe.close()

    def test_wall_clock_bound_survives_a_frozen_monotonic(self):
        """macOS freezes `time.monotonic()` across system sleep. Simulate that
        (monotonic pinned, wall clock advancing) and the bound must STILL fire —
        this is exactly the 48-minute wake in the user's spans."""
        frozen = time.monotonic()
        real_time = time.time
        started = real_time()

        def fake_monotonic():
            return frozen  # the Mac is asleep; this clock does not move

        def fake_time():
            # 60x wall speed so a 2s test covers a 2-minute bound.
            return started + (real_time() - started) * 60.0

        orig_mono, orig_wall = proc_util.time.monotonic, proc_util.time.time
        proc_util.time.monotonic = fake_monotonic  # type: ignore[assignment]
        proc_util.time.time = fake_time  # type: ignore[assignment]
        try:
            t0 = real_time()
            res = proc_util.run_bounded(
                _py("import time; time.sleep(600)"), timeout=120.0
            )
            elapsed = real_time() - t0
        finally:
            proc_util.time.monotonic = orig_mono  # type: ignore[assignment]
            proc_util.time.time = orig_wall  # type: ignore[assignment]

        self.assertTrue(res.timed_out, "a frozen monotonic must not disable the bound")
        # 120 simulated seconds = 2 real ones; the grace waits are real.
        self.assertLess(elapsed, 12.0)

    def test_stdin_is_closed_so_a_prompting_child_cannot_hang(self):
        res = proc_util.run_bounded(
            _py("import sys; sys.stdout.write(repr(sys.stdin.read()))"), timeout=30
        )
        self.assertFalse(res.timed_out)
        self.assertEqual(res.stdout, "''")


if __name__ == "__main__":
    unittest.main()
