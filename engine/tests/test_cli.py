"""CLI subcommand tests (specs/12, E6) — the surface the client calls.

Each subcommand must return VALID JSON on both a seeded vault and an
empty/missing vault (no crash). The JSON shapes are a client contract.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main
from scprism_engine.contract import parse
from scprism_engine.loop import run


def _run_cli(argv):
    """Invoke the CLI, capturing (exit_code, parsed_stdout_json)."""
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    # `run` prints Verdict.to_json(); others print one JSON object.
    parsed = json.loads(text) if text else None
    return code, parsed


class TestCLISeeded(unittest.TestCase):
    """Subcommands over a vault seeded by a real run."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        # Seed: one real passing run -> spans, evidence, verdict, training record.
        run(parse("seed a task", task_id="seed-1"), vault=self.vault,
            tier1_commands=["true"])

    def tearDown(self):
        self._tmp.cleanup()

    def test_run_subcommand_prints_verdict_json(self):
        code, obj = _run_cli(["run", "do a thing", "--vault", self.vault,
                              "--tier1", "true"])
        self.assertEqual(code, 0)
        self.assertIn("task_id", obj)
        self.assertTrue(obj["passed"])

    def test_run_subcommand_tier1_cwd_runs_command_in_given_directory(self):
        """P2-2: --tier1-cwd makes the deterministic Tier-1 gate run inside a
        project directory (the test-loop seam) — proven by a marker file that
        only exists there."""
        with tempfile.TemporaryDirectory() as project_dir:
            with open(os.path.join(project_dir, "marker.txt"), "w") as fh:
                fh.write("present")
            code, obj = _run_cli([
                "run", "verify the project", "--vault", self.vault,
                "--tier1", "test -f marker.txt",
                "--tier1-cwd", project_dir,
            ])
        self.assertEqual(code, 0)
        self.assertTrue(obj["passed"])
        self.assertTrue(obj["tier1"]["passed"])

    def test_run_subcommand_tier1_cwd_absent_is_unchanged(self):
        """Absent --tier1-cwd, the tier1 command must NOT run inside some
        hidden directory picked by this flag — proven by a marker file that
        exists only in a throwaway directory the CLI was never told about."""
        with tempfile.TemporaryDirectory() as other_dir:
            with open(os.path.join(other_dir, "marker.txt"), "w") as fh:
                fh.write("present")
            code, obj = _run_cli([
                "run", "verify without cwd", "--vault", self.vault,
                "--tier1", "test -f marker.txt",
            ])
        self.assertEqual(code, 1)
        self.assertFalse(obj["passed"])

    def test_dashboard_json(self):
        code, obj = _run_cli(["dashboard", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertGreaterEqual(obj["runs"], 1)
        for key in ("cost_by_model", "hooks", "cache", "drift", "eval_trend"):
            self.assertIn(key, obj)

    def test_export_json(self):
        code, obj = _run_cli(["export", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertEqual(obj["artifact"], "sc-prism-compliance-export")
        self.assertGreaterEqual(obj["count"], 1)
        self.assertIn("seed-1", obj["task_ids"])

    def test_export_json_with_range(self):
        code, obj = _run_cli(["export", "--vault", self.vault,
                              "--from", "1970-01-01", "--to", "2999-01-01"])
        self.assertEqual(code, 0)
        self.assertGreaterEqual(obj["count"], 1)

    def test_verify_chain_json(self):
        code, obj = _run_cli(["verify-chain", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"])
        self.assertIsNone(obj["tampered_at"])
        self.assertGreaterEqual(obj["length"], 1)

    def test_gate_json(self):
        code, obj = _run_cli(["gate", "--vault", self.vault])
        self.assertEqual(code, 0)
        for key in ("passed", "blocked", "threshold", "scores", "blockers", "reason"):
            self.assertIn(key, obj)

    def test_gate_json_with_threshold(self):
        code, obj = _run_cli(["gate", "--vault", self.vault, "--threshold", "0.5"])
        self.assertEqual(code, 0)
        self.assertEqual(obj["threshold"], 0.5)

    def test_reconstruct_json_found(self):
        code, obj = _run_cli(["reconstruct", "--vault", self.vault, "--task", "seed-1"])
        self.assertEqual(code, 0)
        self.assertTrue(obj["found"])
        self.assertEqual(obj["task_id"], "seed-1")
        self.assertIn("verdict", obj)
        self.assertIn("trajectory", obj)

    def test_reconstruct_unknown_task_is_valid_json(self):
        code, obj = _run_cli(["reconstruct", "--vault", self.vault, "--task", "nope"])
        self.assertEqual(code, 0)
        self.assertFalse(obj["found"])


class TestCLIEmptyVault(unittest.TestCase):
    """Every read subcommand returns valid JSON on a cold/missing vault."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        # Point at a subdir that does NOT exist yet.
        self.vault = os.path.join(self._tmp.name, "does-not-exist")

    def tearDown(self):
        self._tmp.cleanup()

    def test_dashboard_empty(self):
        code, obj = _run_cli(["dashboard", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertEqual(obj["runs"], 0)

    def test_export_empty(self):
        code, obj = _run_cli(["export", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertEqual(obj["count"], 0)
        self.assertEqual(obj["records"], [])

    def test_verify_chain_empty(self):
        code, obj = _run_cli(["verify-chain", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertTrue(obj["ok"])
        self.assertIsNone(obj["tampered_at"])
        self.assertEqual(obj["length"], 0)

    def test_reconstruct_empty(self):
        code, obj = _run_cli(["reconstruct", "--vault", self.vault, "--task", "x"])
        self.assertEqual(code, 0)
        self.assertFalse(obj["found"])

    def test_gate_empty_vault_is_valid_json(self):
        code, obj = _run_cli(["gate", "--vault", self.vault])
        self.assertEqual(code, 0)
        self.assertIn("passed", obj)
        self.assertIn("blocked", obj)


class TestCLIRunMemoryInjection(unittest.TestCase):
    """LF-fix C — LF-1 memory injection is REAL through the PRODUCTION `run` CLI
    path (`_cmd_run` now constructs a vault-backed MemoryStore). Before the fix
    no caller built one, so `memory_injected` was always empty in a real run —
    debt #10 was only half-killed. This pins that the store is wired: a vault
    note that overlaps the intent is injected via the CLI, and --no-memory opts
    out. `_cmd_run` calling `run(...)` without `memory=` again must fail this."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        note = os.path.join(self.vault, "notes", "retry-policy.md")
        os.makedirs(os.path.dirname(note), exist_ok=True)
        with open(note, "w", encoding="utf-8") as fh:
            fh.write("---\ntitle: Retry Policy\n---\n\nalways retry with backoff\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_cli_run_injects_a_matching_vault_note(self):
        code, obj = _run_cli(
            ["run", "review the retry policy", "--vault", self.vault, "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        self.assertTrue(
            obj["memory_injected"],
            "the production CLI path injected the matching vault note",
        )
        sources = " ".join(m.get("source", "") for m in obj["memory_injected"])
        self.assertIn("retry-policy.md", sources)

    def test_no_memory_flag_opts_out_byte_identical(self):
        code, obj = _run_cli(
            [
                "run", "review the retry policy",
                "--vault", self.vault, "--tier1", "true", "--no-memory",
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(obj["memory_injected"], [])


class TestCLIRunTokenBudget(unittest.TestCase):
    """`run --token-budget` (heartbeat wake's real work bound) — mirrors
    test_team_cli.py's budget tests. The flag threads into the TaskContract,
    so the Tier-2 operating envelope (built FROM the contract) proves it
    reached the loop: `tier2.envelope.token_budget` in the Verdict JSON is the
    enforced cap, and breaching it fails the run. Offline + deterministic:
    the gateway's stub answers, no network."""

    _INTENT = "draft a launch summary for the team"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_token_budget_flag_reaches_the_loop_contract(self):
        """--token-budget is a recognized argparse flag (not an 'unrecognized
        arguments' SystemExit(2)) and its value lands on the run's contract —
        visible as the Tier-2 envelope's enforced cap."""
        code, obj = _run_cli([
            "run", self._INTENT,
            "--vault", self.vault, "--tier1", "true",
            "--token-budget", "20000",
        ])
        self.assertEqual(code, 0)
        self.assertEqual(obj["tier2"]["envelope"]["token_budget"], 20000)
        self.assertTrue(obj["tier2"]["envelope_ok"])

    def test_tiny_token_budget_breaches_the_envelope_and_fails(self):
        """A near-zero cap forces an over-budget breach -> envelope_ok False
        -> passed False -> exit 1 (the bound is ENFORCED, not decorative)."""
        code, obj = _run_cli([
            "run", self._INTENT,
            "--vault", self.vault, "--tier1", "true",
            "--token-budget", "1",
        ])
        self.assertEqual(code, 1)
        self.assertFalse(obj["passed"])
        self.assertFalse(obj["tier2"]["envelope_ok"])
        self.assertTrue(
            any("token_budget" in b for b in obj["tier2"]["breaches"]),
            "the breach names the token budget",
        )

    def test_omitted_flag_keeps_the_contract_default(self):
        """No flag -> 0 -> the contract default (100_000), byte-identical to
        every pre-flag run."""
        code, obj = _run_cli([
            "run", self._INTENT, "--vault", self.vault, "--tier1", "true",
        ])
        self.assertEqual(code, 0)
        self.assertEqual(obj["tier2"]["envelope"]["token_budget"], 100_000)

    def test_negative_token_budget_clamps_to_default_not_zero_spend(self):
        """A raw negative value clamps to 0 first (same as _cmd_team) — the
        omitted-flag semantics, never a literal negative cap that
        TaskContract.validate would reject."""
        code, obj = _run_cli([
            "run", self._INTENT,
            "--vault", self.vault, "--tier1", "true",
            "--token-budget", "-5",
        ])
        self.assertEqual(code, 0)
        self.assertEqual(obj["tier2"]["envelope"]["token_budget"], 100_000)


class TestCLIRunConverseMode(unittest.TestCase):
    """`run --mode converse` — the flag the client's chat path sends.

    The Work page's chat turns used to reach the engine with no kind at all,
    infer "write", and get graded as builds that produced no files. The fix is
    only real if the whole path accepts it: argparse must know the choice, and
    the verdict that comes back must say `replied`, not `failed`. Offline +
    deterministic, exactly like every other run test here: no --tier1 (a chat
    message has no codebase, the gate skips honestly) and the stub answers.
    """

    _INTENT = "Create a wordpress theme like moppers slashcreative"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_mode_converse_is_accepted_and_lands_replied(self):
        code, obj = _run_cli([
            "run", self._INTENT, "--vault", self.vault,
            "--mode", "converse",
        ])
        self.assertEqual(code, 0)
        self.assertEqual(obj["outcome"], "replied")
        self.assertTrue(obj["passed"])
        self.assertTrue(obj["tier2"]["ran"])
        self.assertNotIn("file", obj["outcome_reason"])


if __name__ == "__main__":
    unittest.main()


class TestProjectTokenBudget(unittest.TestCase):
    """--token-budget on the PROJECT subcommand (2026-08-29).

    The run and team paths took a budget from day one; project never did, so
    every build step lived on the contract's 100k default — and the first
    four-seat board step measured 105,843 tokens, failing on the ENVELOPE with
    a Tier-2 score of 0.7625 that had actually cleared the judge. A build
    step's cap must be the caller's deliberate number, not an accident.
    """

    def test_project_token_budget_reaches_run_project(self):
        from unittest import mock
        import scprism_engine.__main__ as cli_mod
        with tempfile.TemporaryDirectory() as vault, \
                tempfile.TemporaryDirectory() as project_dir:
            with mock.patch("scprism_engine.project.run_project") as rp:
                rp.return_value = mock.Mock(
                    passed=True, to_json=lambda: "{}", spans_path="")
                _run_cli([
                    "project", "write PROJECT.md saying hello",
                    "--project-dir", project_dir, "--vault", vault,
                    "--token-budget", "150000",
                ])
                self.assertEqual(
                    rp.call_args.kwargs.get("token_budget"), 150000)

    def test_project_budget_reaches_the_contract_itself(self):
        # The seam INSIDE run_project: a caller-set budget must land on the
        # step contract; 0 must leave the contract default untouched.
        from unittest import mock
        from scprism_engine import project as project_mod
        with tempfile.TemporaryDirectory() as vault, \
                tempfile.TemporaryDirectory() as project_dir:
            import scprism_engine.contract as contract_mod
            with mock.patch.object(contract_mod, "parse",
                                   wraps=contract_mod.parse) as sp:
                project_mod.run_project(
                    "write PROJECT.md saying hello", token_budget=150000,
                    project_dir=project_dir, vault=vault)
                budgets = [c.kwargs.get("token_budget")
                           for c in sp.call_args_list]
                self.assertIn(150000, budgets)
