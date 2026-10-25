import os
import sys
import tempfile
import time
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.verifier import tier1, tier2


class TestTier1(unittest.TestCase):
    def test_passing_command(self):
        r = tier1(["exit 0", "true"])
        self.assertTrue(r.passed)
        self.assertEqual(r.tokens, 0, "Tier-1 must spend zero tokens")

    def test_failing_command_reports_failure(self):
        r = tier1(["exit 0", "exit 7"])
        self.assertFalse(r.passed)
        self.assertEqual(r.tokens, 0)
        self.assertIn("exit 7", r.log)

    def test_empty_commands_is_skipped_pass(self):
        r = tier1([])
        self.assertTrue(r.passed)
        self.assertTrue(r.skipped)

    def test_timeout_kills_the_whole_shell_tree(self):
        """The Tier-1 twin of the CLI-bridge bug. `subprocess.run`'s timeout
        killed the SHELL only, so the real work (an `npm`/`pytest` grandchild,
        a dev server it started) kept running with our pipes in hand — and the
        gate reported a timeout while the process was still burning the machine.
        The whole process group must go, inside the bound."""
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = os.path.join(tmp, "kid.pid")
            child = (
                f"{sys.executable} -c "
                f"\"import os,time; open({pidfile!r},'w').write(str(os.getpid())); "
                f"time.sleep(600)\""
            )
            started = time.monotonic()
            r = tier1([f"echo starting; {child}"], timeout=2)
            elapsed = time.monotonic() - started
            with open(pidfile, encoding="utf-8") as f:
                kid = int(f.read().strip())

        self.assertFalse(r.passed)
        self.assertTrue(r.commands[0].timed_out)
        self.assertEqual(r.commands[0].returncode, 124)
        # Output printed before the kill is still reported.
        self.assertIn("starting", r.commands[0].stdout)
        # It RETURNED, bounded (2s bound + the documented kill/read grace).
        self.assertLess(elapsed, 15.0)

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                os.kill(kid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        with self.assertRaises(ProcessLookupError):
            os.kill(kid, 0)


class TestTier2(unittest.TestCase):
    def test_stub_is_deterministic(self):
        a = tier2("some trace text that is reasonably long here")
        b = tier2("some trace text that is reasonably long here")
        self.assertEqual(a.score, b.score)
        self.assertTrue(a.ran)

    def test_score_bounded(self):
        r = tier2("x" * 5000)
        self.assertLessEqual(r.score, 1.0)
        self.assertGreaterEqual(r.score, 0.0)


if __name__ == "__main__":
    unittest.main()
