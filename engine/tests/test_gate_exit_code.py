"""A gate that cannot fail is not a gate.

`scprism gate` returned exit 0 whether it blocked or not, so any CI step
wired to it was decorative: the JSON said `blocked: true` and the shell saw
success. Found in a pre-release audit, 2026-08-31.

Exit codes are the whole contract for a CI gate — nothing downstream reads the
JSON. 0 = safe to proceed, non-zero = stop. An internal error must also be
non-zero: "the gate crashed" is not "the gate passed", and defaulting a crash
to success is exactly how a broken gate goes unnoticed for months.
"""
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import _bootstrap  # noqa: F401
from scprism_engine.__main__ import _cmd_gate


class _Args:
    threshold = 0.7


class _Result:
    def __init__(self, passed, blocked):
        self.passed = passed
        self.blocked = blocked

    def to_dict(self):
        return {"passed": self.passed, "blocked": self.blocked, "blockers": []}


def _run(result=None, exc=None):
    """Run _cmd_gate with run_gate stubbed; return (exit_code, stdout)."""
    buf = io.StringIO()
    with patch("scprism_engine.ci_gate.run_gate") as rg:
        if exc is not None:
            rg.side_effect = exc
        else:
            rg.return_value = result
        with redirect_stdout(buf):
            code = _cmd_gate(_Args())
    return code, buf.getvalue()


class TestGateExitCode(unittest.TestCase):
    def test_a_passing_gate_exits_zero(self):
        code, out = _run(_Result(passed=True, blocked=False))
        self.assertEqual(code, 0)
        self.assertIn('"passed": true', out.lower())

    def test_a_BLOCKED_gate_exits_non_zero(self):
        """The bug. Everything about the JSON was already correct; only the
        exit code lied, and the exit code is the only thing CI reads."""
        code, _ = _run(_Result(passed=False, blocked=True))
        self.assertNotEqual(code, 0)

    def test_a_failing_but_unblocked_gate_exits_non_zero(self):
        code, _ = _run(_Result(passed=False, blocked=False))
        self.assertNotEqual(code, 0)

    def test_a_crash_exits_non_zero_and_still_reports(self):
        code, out = _run(exc=RuntimeError("boom"))
        self.assertNotEqual(code, 0)
        # The honest JSON must survive — a crash is reported, not swallowed.
        self.assertIn("gate error", out)
        self.assertIn("boom", out)


if __name__ == "__main__":
    unittest.main()
