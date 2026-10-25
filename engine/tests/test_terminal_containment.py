"""The terminal tool's timeout must kill the whole process group.

`terminal_tools._call` used `subprocess.run(..., timeout=...)` with the inline
comment "a killed timeout takes its children". It does not. Python's timeout
handling calls `Popen.kill()`, which signals the DIRECT CHILD only — the shell
— while every grandchild it spawned keeps running, detached, forever. The
`start_new_session=True` on that call makes the situation worse rather than
better: it puts the children in their own group precisely so a group kill
COULD reach them, and then never sends one.

`proc.run_bounded` exists in the same package and was written for exactly this
failure. Its module docstring says so.

The test below spawns a real grandchild and asserts it is dead afterwards. It
is deliberately not mocked: this is a claim about operating-system behaviour,
and a mock would have happily agreed with the broken version.
"""
import os
import signal
import shutil
import tempfile
import time
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.terminal_tools import TerminalToolProvider


def _alive(pid: int) -> bool:
    """Whether `pid` still exists. Signal 0 probes without delivering."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class TestTimeoutKillsTheWholeGroup(unittest.TestCase):
    def setUp(self):
        self.provider = TerminalToolProvider()
        self.tmp = tempfile.mkdtemp(prefix="scprism-orphan-")
        self.pidfile = os.path.join(self.tmp, "child.pid")
        self.pid = None

    def tearDown(self):
        # Never leak a process out of the suite, whichever way the test went.
        if self.pid and _alive(self.pid):
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_grandchild_does_not_outlive_the_timeout(self):
        # The shell backgrounds a long sleep, records its PID, then waits. The
        # DIRECT child is the shell; the `sleep` is the grandchild that
        # subprocess.run's timeout leaves running forever.
        #
        # Note for anyone tempted to identify the grandchild by a marker string
        # in the command: a shell comment is part of the SCRIPT, not the
        # child's argv, so `ps` never shows it and such a test passes against
        # the broken implementation. Ask the kernel about a real PID instead.
        command = f"sleep 45 & echo $! > {self.pidfile}; wait"
        result = self.provider._call(
            "terminal_run", {"command": command, "timeout_s": 2}
        )

        self.assertIn("timed out", str(result).lower())

        with open(self.pidfile, "r", encoding="utf-8") as fh:
            self.pid = int(fh.read().strip())

        deadline = time.time() + 5
        while time.time() < deadline and _alive(self.pid):
            time.sleep(0.2)
        self.assertFalse(
            _alive(self.pid),
            f"grandchild {self.pid} outlived the timeout — the process group "
            f"was not killed",
        )


class TestOrdinaryExecutionIsUnchanged(unittest.TestCase):
    """Containment must not cost the tool its actual job."""

    def setUp(self):
        self.provider = TerminalToolProvider()

    def _text(self, result):
        content = result.get("content")
        if isinstance(content, list) and content:
            return str(content[0].get("text", ""))
        return str(content)

    def test_stdout_is_returned(self):
        r = self.provider._call("terminal_run", {"command": "echo hello-from-shell"})
        self.assertIn("hello-from-shell", self._text(r))
        self.assertFalse(r.get("isError"))

    def test_stderr_is_returned_and_labelled(self):
        r = self.provider._call("terminal_run", {"command": "echo oops 1>&2"})
        self.assertIn("oops", self._text(r))

    def test_a_non_zero_exit_is_reported_not_swallowed(self):
        r = self.provider._call("terminal_run", {"command": "exit 3"})
        self.assertIn("3", self._text(r) + str(r))

    def test_partial_output_before_a_timeout_is_not_lost(self):
        """run_bounded captures what the command managed to print. Reporting a
        timeout with the work discarded is strictly less useful."""
        r = self.provider._call(
            "terminal_run",
            {"command": "echo early-output; sleep 30", "timeout_s": 2},
        )
        blob = self._text(r) + str(r)
        self.assertIn("timed out", blob.lower())
        self.assertIn("early-output", blob)


if __name__ == "__main__":
    unittest.main()
