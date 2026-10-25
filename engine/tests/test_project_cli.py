"""CLI project subcommand tests (Task A3) — file-writing runs in a project dir.

The 'project' subcommand mirrors 'run' but writes to a project directory and
gates on Tier-1 (verify_command) instead of Tier-2. It returns Verdict JSON
and exits 0 pass / 1 fail, like 'run'.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.__main__ import main
from scprism_engine.team import parse_agents
from scprism_engine.vault_tools import VaultToolProvider
from scprism_engine.webtools import CompositeToolClient, WebToolProvider


def _run_cli(argv):
    """Invoke the CLI, capturing (exit_code, parsed_stdout_json)."""
    out = io.StringIO()
    err = io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    text = out.getvalue().strip()
    # `project` (like `run`) prints Verdict.to_json() raw.
    parsed = json.loads(text) if text else None
    return code, parsed


class TestProjectCLI(unittest.TestCase):
    """Project subcommand invocations."""

    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self._tmp_vault = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name
        self.vault = self._tmp_vault.name

    def tearDown(self):
        self._tmp_proj.cleanup()
        self._tmp_vault.cleanup()

    def test_project_subcommand_basic_invocation(self):
        """Call project subcommand with required args only."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
        ])
        # With offline stub model, verdict should have "passed" and be valid JSON.
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)
        self.assertIsInstance(obj["passed"], bool)
        # Offline stub should return fail (since no file blocks in a stub response).
        self.assertFalse(obj["passed"])
        # Exit-code contract: failed verdict -> exit 1 (scripts gate on this).
        self.assertEqual(code, 1)

    def test_project_subcommand_with_tier1(self):
        """Call project subcommand with --tier1 (single value, not repeatable)."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--tier1", "true",
        ])
        self.assertIsNotNone(obj)
        self.assertIn("passed", obj)
        # Offline stub -> no file blocks -> failed verdict -> exit 1,
        # even though the tier1 command itself would pass.
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)

    def test_project_subcommand_with_context(self):
        """Call project subcommand with --context."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--context", "Some project brief.",
        ])
        self.assertIsNotNone(obj)
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)

    def test_project_subcommand_with_refine_feedback(self):
        """Call project subcommand with --refine-feedback."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--refine-feedback", "Fix this error.",
        ])
        self.assertIsNotNone(obj)
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)

    def test_project_subcommand_with_never_touch(self):
        """Call project subcommand with repeatable --never-touch."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--never-touch", "*.secret",
            "--never-touch", ".env*",
        ])
        self.assertIsNotNone(obj)
        self.assertIn("passed", obj)
        self.assertFalse(obj["passed"])
        self.assertEqual(code, 1)

    def test_project_subcommand_unknown_flag_exits_with_argparse_error(self):
        """Unknown flag should cause SystemExit with argparse's exit code 2."""
        with self.assertRaises(SystemExit) as ctx:
            main([
                "project", "test intent",
                "--project-dir", self.project_dir,
                "--vault", self.vault,
                "--unknown-flag", "value",
            ])
        self.assertEqual(ctx.exception.code, 2)

    def test_project_subcommand_missing_required_project_dir(self):
        """Missing --project-dir should cause SystemExit with exit code 2."""
        with self.assertRaises(SystemExit) as ctx:
            main([
                "project", "test intent",
                "--vault", self.vault,
            ])
        self.assertEqual(ctx.exception.code, 2)

    def test_project_subcommand_missing_required_vault(self):
        """Missing --vault should cause SystemExit with exit code 2."""
        with self.assertRaises(SystemExit) as ctx:
            main([
                "project", "test intent",
                "--project-dir", self.project_dir,
            ])
        self.assertEqual(ctx.exception.code, 2)


class TestProjectSubcommandAgentsRoster(unittest.TestCase):
    """P1-3: `project --agents` parses into a roster and reaches
    `run_project(roster=...)` — the CLI+argparse leg of wiring a roster from
    the client down to `run_project` (P1-2 already made `run_project` itself
    run a per-role board when `roster` is given; this task only wires the
    flag through)."""

    _AGENTS = "lead:claude,planner:gemini,developer:local"

    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self._tmp_vault = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name
        self.vault = self._tmp_vault.name

    def tearDown(self):
        self._tmp_proj.cleanup()
        self._tmp_vault.cleanup()

    def test_agents_flag_accepted_by_argparse(self):
        """--agents is a recognized flag on the `project` subparser (not an
        'unrecognized arguments' SystemExit(2)), mirroring how `team` accepts
        --agents. Real (unmocked) end-to-end run with keyless cloud/local
        providers only (never a `-cli` bridge provider), same discipline as
        test_team_cli.py's `_AGENTS` — no real network/subprocess call."""
        code, obj = _run_cli([
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
            "--agents", self._AGENTS,
        ])
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)

    def test_agents_flag_builds_roster_and_forwards_to_run_project(self):
        """When --agents is given, `_cmd_project` parses it with the SAME
        `parse_agents` `team` uses and passes the resulting roster to
        `run_project(roster=...)`."""
        fake_verdict = mock.Mock()
        fake_verdict.passed = True
        fake_verdict.to_json.return_value = "{}"
        fake_verdict.spans_path = os.path.join(self.vault, "spans.jsonl")
        with mock.patch(
            "scprism_engine.project.run_project", return_value=fake_verdict
        ) as run_project_mock:
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                main([
                    "project", "test intent",
                    "--project-dir", self.project_dir,
                    "--vault", self.vault,
                    "--agents", self._AGENTS,
                ])
        run_project_mock.assert_called_once()
        kwargs = run_project_mock.call_args.kwargs
        self.assertIn("roster", kwargs)
        self.assertEqual(kwargs["roster"], parse_agents(self._AGENTS))

    def test_agents_flag_absent_roster_is_none(self):
        """Omitting --agents keeps `roster=None` — the byte-identical
        single-doer path (P1-2's default)."""
        fake_verdict = mock.Mock()
        fake_verdict.passed = True
        fake_verdict.to_json.return_value = "{}"
        fake_verdict.spans_path = os.path.join(self.vault, "spans.jsonl")
        with mock.patch(
            "scprism_engine.project.run_project", return_value=fake_verdict
        ) as run_project_mock:
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                main([
                    "project", "test intent",
                    "--project-dir", self.project_dir,
                    "--vault", self.vault,
                ])
        run_project_mock.assert_called_once()
        kwargs = run_project_mock.call_args.kwargs
        self.assertIn("roster", kwargs)
        self.assertIsNone(kwargs["roster"])


def _inner(source):
    """Look through the live destructive-command denylist.

    `_compose_tool_source` now wraps whatever it composes in
    `toolhooks.PreToolUseGate`, so every run path gets the `rm -rf` guard by
    construction. These tests assert WHICH provider was offered to the step,
    which is the layer underneath.
    """
    return getattr(source, "source", source)


class TestProjectWebAndVaultTools(unittest.TestCase):
    """`project --web` + vault tools (2026-08-28): the governed tool source
    reaches `run_project`'s step dispatch the same way `run`/`team` wire theirs
    into `loop.run`. Before this landed the project path had NO tool loop at
    all — a plan step that says "research X first" ran blind, and the client
    bridge had to drop its `web` parameter on the floor. Offline throughout:
    the stub model never emits a tool_call, so nothing egresses — only the
    WIRING is under test (the tool round-trip itself is test_loop_web.py's)."""

    def setUp(self):
        self._tmp_proj = tempfile.TemporaryDirectory()
        self._tmp_vault = tempfile.TemporaryDirectory()
        self.project_dir = self._tmp_proj.name
        self.vault = self._tmp_vault.name

    def tearDown(self):
        self._tmp_proj.cleanup()
        self._tmp_vault.cleanup()

    def _base_argv(self, *extra):
        return [
            "project", "test intent",
            "--project-dir", self.project_dir,
            "--vault", self.vault,
        ] + list(extra)

    def _run_project_kwargs(self, *extra):
        """Invoke the CLI with `run_project` mocked; return the kwargs
        `_cmd_project` forwarded (the roster tests' pattern)."""
        fake_verdict = mock.Mock()
        fake_verdict.passed = True
        fake_verdict.to_json.return_value = "{}"
        fake_verdict.spans_path = os.path.join(self.vault, "spans.jsonl")
        with mock.patch(
            "scprism_engine.project.run_project", return_value=fake_verdict
        ) as run_project_mock:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                main(self._base_argv(*extra))
        run_project_mock.assert_called_once()
        return run_project_mock.call_args.kwargs

    def test_web_flag_accepted_by_argparse(self):
        """--web is a recognized flag on the `project` subparser (not an
        'unrecognized arguments' SystemExit(2) — which is exactly how every
        build step died when the client pushed it before the engine knew it)."""
        code, obj = _run_cli(self._base_argv("--web"))
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)

    def test_search_flags_accepted_by_argparse(self):
        """--search-api-key / --search-endpoint parse alongside --web, same as
        `run`/`team`. Offline: the stub never calls web_search, so the bogus
        endpoint is never contacted."""
        code, obj = _run_cli(self._base_argv(
            "--web",
            "--search-api-key", "k",
            "--search-endpoint", "http://127.0.0.1:9/nope",
        ))
        self.assertIsNotNone(obj, "stdout should parse as JSON")
        self.assertIn("passed", obj)

    def test_web_flag_forwards_web_provider_to_run_project(self):
        """--web builds the governed WebToolProvider and hands it (plus the
        shared Telemetry — the F3 one-run_id lesson) to `run_project`. With
        --no-vault-tools it is the ONLY source, so it arrives unwrapped
        (_compose_tool_source's single-source contract)."""
        kwargs = self._run_project_kwargs("--web", "--no-vault-tools")
        self.assertIn("mcp_client", kwargs)
        self.assertIsInstance(_inner(kwargs["mcp_client"]), WebToolProvider)
        self.assertIsNotNone(kwargs["telemetry"])

    def test_vault_tools_offered_by_default(self):
        """No flags -> the vault tools are offered to the step, the same
        mission-control default `run`/`team` have (the vault is the user's own
        LOCAL data; --no-vault-tools is the opt-out)."""
        kwargs = self._run_project_kwargs()
        self.assertIn("mcp_client", kwargs)
        self.assertIsInstance(_inner(kwargs["mcp_client"]), VaultToolProvider)

    def test_web_plus_default_vault_tools_compose(self):
        """--web with the default vault tools -> ONE composite source fanning
        both, exactly what `run` builds for the same flags."""
        kwargs = self._run_project_kwargs("--web")
        self.assertIn("mcp_client", kwargs)
        self.assertIsInstance(_inner(kwargs["mcp_client"]), CompositeToolClient)

    def test_no_vault_tools_without_web_is_toolless(self):
        """--no-vault-tools alone restores the tool-less path: no source, no
        Telemetry built — byte-identical to the project path before tools."""
        kwargs = self._run_project_kwargs("--no-vault-tools")
        self.assertIn("mcp_client", kwargs)
        self.assertIsNone(kwargs["mcp_client"])
        self.assertIsNone(kwargs["telemetry"])

    def test_web_provider_reaches_the_step_loop(self):
        """End to end through the REAL run_project: the step's dispatch doer
        lists the web provider's tools (loop.run's tool path), proving the
        source reached the step loop — not merely `_cmd_project`'s kwargs."""
        calls = []

        def spy(provider_self):
            calls.append(True)
            return []

        with mock.patch.object(WebToolProvider, "list_tools", spy):
            code, obj = _run_cli(self._base_argv("--web", "--no-vault-tools"))
        self.assertTrue(
            calls, "the step loop listed the web provider's tools"
        )
        self.assertIsNotNone(obj)
        self.assertIn("passed", obj)

    def test_run_project_forwards_tool_source_and_telemetry_into_loop_run(self):
        """`run_project` itself threads mcp_client + telemetry straight into
        `loop.run` — the exact seam `_cmd_run` uses for `run`."""
        from scprism_engine.project import run_project

        fake_verdict = mock.Mock()
        fake_verdict.passed = False
        tool_source = object()
        telemetry = object()
        with mock.patch(
            "scprism_engine.loop.run", return_value=fake_verdict
        ) as loop_run_mock:
            verdict = run_project(
                "test intent",
                project_dir=os.path.join(self.project_dir, "fresh"),
                vault=self.vault,
                mcp_client=tool_source,
                telemetry=telemetry,
            )
        loop_run_mock.assert_called_once()
        kwargs = loop_run_mock.call_args.kwargs
        self.assertIs(kwargs["mcp_client"], tool_source)
        self.assertIs(kwargs["telemetry"], telemetry)
        self.assertIs(verdict, fake_verdict)


if __name__ == "__main__":
    unittest.main()
