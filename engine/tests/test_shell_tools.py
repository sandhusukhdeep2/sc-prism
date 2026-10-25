"""ShellToolProvider — agents run terminal commands, governed (2026-08-31).

Sukhdeep's directive: "this software is going to do all kinds of jobs — 3D
modeling, CAD work, game development — with the terminal it can do the task."
Same discipline as every capability: its own gate word, acting-class risk (the
approval gate holds every call), one span per execution, output truncated at a
stated cap, exit codes reported honestly.
"""
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.shell_tools import ShellToolProvider


class TestShellToolProvider(unittest.TestCase):
    def _provider(self, **kw):
        return ShellToolProvider(**kw)

    def test_lists_one_tool_with_command_schema(self):
        tools = self._provider().list_tools()
        names = [t.name for t in tools]
        self.assertEqual(names, ["run_command"])
        self.assertIn("command", tools[0].input_schema["properties"])

    def test_runs_a_real_command_and_reports_exit_and_output(self):
        r = self._provider().call_tool("run_command", {"command": "echo hello-prism"})
        self.assertFalse(r["isError"])
        self.assertIn("hello-prism", r["content"][0]["text"])
        self.assertEqual(r["exit_code"], 0)

    def test_nonzero_exit_is_reported_not_hidden(self):
        r = self._provider().call_tool("run_command", {"command": "exit 3"})
        self.assertTrue(r["isError"])
        self.assertEqual(r["exit_code"], 3)

    def test_cwd_is_respected_and_reported(self):
        d = tempfile.mkdtemp()
        r = self._provider().call_tool("run_command", {"command": "pwd", "cwd": d})
        self.assertIn(os.path.realpath(d), os.path.realpath(r["content"][0]["text"].strip()))

    def test_output_is_truncated_at_the_stated_cap(self):
        r = self._provider(output_cap=200).call_tool(
            "run_command", {"command": "yes x | head -c 5000"}
        )
        text = r["content"][0]["text"]
        self.assertLessEqual(len(text), 400)
        self.assertIn("truncated", text)

    def test_timeout_kills_and_says_so(self):
        r = self._provider(timeout_s=1).call_tool("run_command", {"command": "sleep 5"})
        self.assertTrue(r["isError"])
        self.assertIn("timed out", r["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
