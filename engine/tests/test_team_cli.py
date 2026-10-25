"""CLI 'team' subcommand tests (TG-3) — the governed team-run surface the
client calls. Mirrors test_project_cli.py's `_run_cli` helper. Offline +
deterministic: no provider keys live in the test process env, and `--agents`
never names a CLI-bridge provider (e.g. `claude-cli`), so every agent call
goes straight to the gateway's offline stub — no real network/subprocess call,
exactly like test_project_cli.py's basic-invocation tests.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main

# Keyless cloud providers only (openai/local) — never a `-cli` bridge
# provider, so `_find_cli`/`_invoke_cli` is never reached even if a real
# `claude`/codex/etc. binary happens to be on this machine's PATH.
_AGENTS = "lead:openai,researcher:local,critic:openai"


def _run_cli(argv):
    """Invoke the CLI, capturing (exit_code, parsed_stdout_json)."""
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    parsed = json.loads(text) if text else None
    return code, parsed


class TestTeamCLI(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_tiny_token_budget_exits_1_with_passed_false(self):
        """A near-zero --token-budget forces an early over-budget stop, which
        forces the Tier-2 envelope breach -> passed=False -> exit 1 (mirrors
        _cmd_project's exit-code contract: 0 pass / 1 fail)."""
        code, obj = _run_cli([
            "team", "draft a launch summary for the team",
            "--vault", self.vault,
            "--agents", _AGENTS,
            "--token-budget", "1",
        ])
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertTrue(obj["over_budget"])
        self.assertEqual(obj["token_budget"], 1)
        self.assertEqual(code, 1)

    def test_token_budget_flag_accepted_by_argparse(self):
        """--token-budget is a recognized argparse flag (not an
        'unrecognized arguments' SystemExit(2)) and its value threads through
        to the emitted TeamResult JSON."""
        code, obj = _run_cli([
            "team", "draft a launch summary for the team",
            "--vault", self.vault,
            "--agents", _AGENTS,
            "--token-budget", "5000",
        ])
        self.assertIsNotNone(obj)
        self.assertEqual(obj["token_budget"], 5000)

    def test_token_budget_defaults_to_zero_flag_maps_to_contract_default(self):
        """Omitting --token-budget defaults to 0, which run_team maps to the
        contract's default budget (100_000) — not a hard zero-budget run."""
        code, obj = _run_cli([
            "team", "draft a launch summary for the team",
            "--vault", self.vault,
            "--agents", _AGENTS,
        ])
        self.assertIsNotNone(obj)
        self.assertEqual(obj["token_budget"], 100_000)
        self.assertFalse(obj["over_budget"])
        # The saved Verdict's path rides in the same JSON the client parses.
        self.assertIn("verdict_path", obj)
        expected = os.path.join(self.vault, "verdicts", f"{obj['task_id']}.json")
        self.assertEqual(obj["verdict_path"], expected)
        self.assertTrue(os.path.isfile(obj["verdict_path"]))

    def test_negative_token_budget_clamps_to_default_not_zero_spend(self):
        """A raw CLI caller passing a NEGATIVE --token-budget must get the
        SAME contract-default semantics as omitting the flag (0) — not a
        literal negative cap, which used to force `over_budget=True` at zero
        tokens spent (an invariant hole: the forced-breach envelope doesn't
        actually breach at 0 spent, so pass/fail silently fell to the judge
        alone). `_cmd_team` clamps `max(0, args.token_budget)` before calling
        `run_team`, so this must behave byte-identically to the omitted-flag
        case above."""
        code, obj = _run_cli([
            "team", "draft a launch summary for the team",
            "--vault", self.vault,
            "--agents", _AGENTS,
            "--token-budget", "-5",
        ])
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertEqual(obj["token_budget"], 100_000)
        self.assertFalse(obj["over_budget"])
        self.assertTrue(obj["passed"])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
