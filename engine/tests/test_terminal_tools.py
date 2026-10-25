"""TerminalToolProvider — agents run real shell commands, governed.

Sukhdeep, 2026-08-31: "this software is going to do all kinds of jobs — 3D,
CAD, game development — with the terminal it can do the task." The provider
is the same MCPClient shape as web/vault/computer; its tools classify ACTING
(not in toolrisk's read-only allowlist), so every command rides the approval
gate; every execution is one span whose attrs carry the command, cwd and
exit code — what ran is what is recorded.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.terminal_tools import TerminalToolProvider


class TestTerminalRun(unittest.TestCase):
    def setUp(self):
        self.p = TerminalToolProvider()

    def test_runs_a_command_and_captures_stdout_and_exit(self):
        r = self.p.call_tool("terminal_run", {"command": "echo hello-prism"})
        self.assertFalse(r["isError"])
        self.assertIn("hello-prism", r["content"][0]["text"])
        self.assertEqual(r["exit_code"], 0)

    def test_nonzero_exit_is_reported_not_raised(self):
        r = self.p.call_tool("terminal_run", {"command": "exit 3"})
        self.assertTrue(r["isError"])
        self.assertEqual(r["exit_code"], 3)

    def test_stderr_is_captured(self):
        r = self.p.call_tool("terminal_run", {"command": "echo oops 1>&2; exit 1"})
        self.assertIn("oops", r["content"][0]["text"])

    def test_relative_cwd_refused(self):
        r = self.p.call_tool("terminal_run", {"command": "pwd", "cwd": "relative/dir"})
        self.assertTrue(r["isError"])
        self.assertIn("absolute", r["content"][0]["text"])

    def test_output_is_capped_honestly(self):
        r = self.p.call_tool("terminal_run", {"command": "yes x | head -c 200000"})
        self.assertLess(len(r["content"][0]["text"]), 90000)
        self.assertIn("truncated", r["content"][0]["text"])

    def test_timeout_kills_and_says_so(self):
        r = self.p.call_tool("terminal_run", {"command": "sleep 30", "timeout_s": 1})
        self.assertTrue(r["isError"])
        self.assertIn("timed out", r["content"][0]["text"])

    def test_unknown_tool_refused(self):
        r = self.p.call_tool("terminal_format_disk", {})
        self.assertTrue(r["isError"])


if __name__ == "__main__":
    unittest.main()
