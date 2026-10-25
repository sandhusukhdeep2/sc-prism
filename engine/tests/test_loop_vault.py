"""Integration: the tool-use loop + the real CLI over the governed VAULT source.

Mirrors ``test_loop_web`` but with ``VaultToolProvider``: a scripted fake model
asks to ``vault_read`` a note in a throwaway vault, the loop executes it (real
provider, real path confinement, a real ``tool_exec`` span), feeds the note back,
and the model answers quoting the observation — so the final text carries the
REAL note text, never a fabricated one.

It also pins the WIRING decision (mission-control design Part 1): the vault tools
are ALWAYS AVAILABLE — a plain ``run`` with no flags at all puts vault_list /
vault_read / vault_search / project_status in the run's tool catalogue (the
manifest the model actually receives), and ``--no-vault-tools`` is the explicit
opt-out that restores the tool-less path. Fully offline: the gateway's
``model_call`` is patched, no network, no real user data.
"""

import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout

import _bootstrap  # noqa: F401

import scprism_engine.gateway as gateway_mod
from scprism_engine.__main__ import _build_vault_provider, _compose_tool_source, main
from scprism_engine.gateway import ModelCallResult
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.vault_tools import VaultToolProvider
from scprism_engine.webtools import CompositeToolClient

_VAULT_TOOL_NAMES = {"vault_list", "vault_read", "vault_search", "project_status"}
_NOTE_BODY = "# Retry policy\n\nMAGIC_NOTE_TOKEN — always retry with backoff.\n"


def _tool_call(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


def _res(text):
    return ModelCallResult(
        text=text,
        tokens_in=len(text) // 4 + 1,
        tokens_out=len(text) // 4 + 1,
        cache="miss",
        provider="stub",
        model="stub",
        is_real=False,
    )


class TestToolLoopOverRealVault(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        os.makedirs(os.path.join(self.vault, "notes"), exist_ok=True)
        with open(os.path.join(self.vault, "notes", "retry.md"), "w", encoding="utf-8") as fh:
            fh.write(_NOTE_BODY)
        self.spans_path = os.path.join(self.vault, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_vault_read_round_trip_with_real_span(self):
        from scprism_engine.toolloop import run_tool_loop

        tel = Telemetry(self.spans_path)
        provider = VaultToolProvider(self.vault, telemetry=tel)
        tools = provider.list_tools()
        self.assertEqual({t.name for t in tools}, _VAULT_TOOL_NAMES)

        state = {"round": 0}

        def model_fn(messages):
            state["round"] += 1
            if state["round"] == 1:
                return _res(_tool_call("vault_read", {"path": "notes/retry.md"}))
            return _res("The note says: %s" % messages[-1]["content"])

        result = run_tool_loop(
            messages=[
                {"role": "system", "content": "You are the companion."},
                {"role": "user", "content": "what does my retry note say?"},
            ],
            tools=tools,
            model_fn=model_fn,
            tool_exec=provider.call_tool,
        )

        # The final text quotes the observation, which carries the REAL note.
        self.assertIn("MAGIC_NOTE_TOKEN", result.text)
        self.assertIn("```tool_result", result.text)
        self.assertEqual(result.iterations, 1)
        trace = result.tool_calls[0]
        self.assertEqual(trace.tool, "vault_read")
        self.assertTrue(trace.ok)
        self.assertFalse(trace.blocked)

        spans = [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["attrs"]["provider"], "vault")
        self.assertEqual(spans[0]["attrs"]["tool"], "vault_read")
        self.assertEqual(spans[0]["status"], "ok")
        self.assertFalse(spans[0]["attrs"]["is_error"])

    def test_a_refused_traversal_feeds_back_an_honest_failure(self):
        """The model asking for /etc/passwd gets a truthful ok:false, and the
        loop keeps going — no crash, no fabricated file."""
        from scprism_engine.toolloop import run_tool_loop

        provider = VaultToolProvider(self.vault)
        state = {"round": 0}

        def model_fn(messages):
            state["round"] += 1
            if state["round"] == 1:
                return _res(_tool_call("vault_read", {"path": "../../../etc/passwd"}))
            return _res("Observation: %s" % messages[-1]["content"])

        result = run_tool_loop(
            messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
            tools=provider.list_tools(),
            model_fn=model_fn,
            tool_exec=provider.call_tool,
        )
        self.assertFalse(result.tool_calls[0].ok)
        self.assertIn("escapes the vault", result.text)


class _CLIMixin:
    """Run the real CLI with a patched gateway so no model or network is used."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        os.makedirs(os.path.join(self.vault, "notes"), exist_ok=True)
        with open(os.path.join(self.vault, "notes", "retry.md"), "w", encoding="utf-8") as fh:
            fh.write(_NOTE_BODY)
        self._orig_model_call = gateway_mod.Gateway.model_call

    def tearDown(self):
        gateway_mod.Gateway.model_call = self._orig_model_call
        self._tmp.cleanup()

    def _run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue().strip(), err.getvalue().strip()

    def _capture_system_prompts(self):
        """Patch model_call to record every system message it is handed."""
        seen = []
        lock = threading.Lock()

        def patched(self, messages, route):  # noqa: ANN001 (test double)
            with lock:
                for m in messages:
                    if m.get("role") == "system":
                        seen.append(str(m.get("content", "")))
            return ModelCallResult(
                text="final: done", tokens_in=5, tokens_out=7, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway_mod.Gateway.model_call = patched
        return seen

    def _patch_first_call_requests(self, tool, args):
        lock = threading.Lock()
        state = {"n": 0}

        def patched(self, messages, route):  # noqa: ANN001 (test double)
            with lock:
                state["n"] += 1
                first = state["n"] == 1
            text = _tool_call(tool, args) if first else "final: done"
            return ModelCallResult(
                text=text, tokens_in=5, tokens_out=7, cache="miss",
                provider=route.provider, model=route.model, is_real=False,
            )

        gateway_mod.Gateway.model_call = patched

    def _spans(self):
        return read_spans(os.path.join(self.vault, "spans.jsonl"))


class TestVaultToolsInTheRunCatalogue(_CLIMixin, unittest.TestCase):
    """The enablement decision, pinned: ALWAYS AVAILABLE (no flag needed)."""

    def test_a_plain_run_offers_all_four_vault_tools(self):
        seen = self._capture_system_prompts()
        code, out, err = self._run_cli(
            ["run", "check my vault", "--vault", self.vault, "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        manifest = "\n".join(seen)
        for name in sorted(_VAULT_TOOL_NAMES):
            self.assertIn(name, manifest, "%s must be in the run's tool catalogue" % name)
        self.assertIn("You have access to these external tools", manifest)

    def test_no_vault_tools_restores_the_tool_less_path(self):
        seen = self._capture_system_prompts()
        code, out, err = self._run_cli(
            [
                "run", "check my vault", "--vault", self.vault,
                "--tier1", "true", "--no-vault-tools",
            ]
        )
        self.assertEqual(code, 0)
        manifest = "\n".join(seen)
        for name in _VAULT_TOOL_NAMES:
            self.assertNotIn(name, manifest)
        self.assertNotIn("You have access to these external tools", manifest)

    def test_a_plain_team_run_offers_the_vault_tools_too(self):
        seen = self._capture_system_prompts()
        code, out, err = self._run_cli(
            ["team", "check my vault", "--vault", self.vault, "--agents", "lead:local"]
        )
        manifest = "\n".join(seen)
        for name in sorted(_VAULT_TOOL_NAMES):
            self.assertIn(name, manifest)

    def test_cli_run_executes_a_real_vault_read_and_audits_it(self):
        """End to end through the production CLI: the model asks for a note, the
        engine really reads it, and a provider="vault" tool_exec span lands in
        the run's own spans.jsonl (one shared run_id, no phantom run)."""
        self._patch_first_call_requests("vault_read", {"path": "notes/retry.md"})
        code, out, err = self._run_cli(
            ["run", "read my retry note", "--vault", self.vault, "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        spans = self._spans()
        vault_execs = [
            s for s in spans
            if s["type"] == "tool_exec" and s["attrs"].get("provider") == "vault"
        ]
        self.assertTrue(vault_execs, "the vault tool really ran")
        self.assertEqual(vault_execs[0]["attrs"]["tool"], "vault_read")
        self.assertFalse(vault_execs[0]["attrs"]["is_error"])
        self.assertEqual(len({s["run_id"] for s in spans}), 1)

    def test_approval_posture_holds_a_vault_tool_through_the_cli(self):
        """--require-approval all must hold a vault call exactly like any other
        tool: a held=True span, and the note is NEVER read."""
        self._patch_first_call_requests("vault_read", {"path": "notes/retry.md"})
        code, out, err = self._run_cli(
            [
                "run", "read my retry note", "--vault", self.vault,
                "--tier1", "true", "--require-approval", "all",
            ]
        )
        self.assertEqual(code, 0)
        held = [
            s for s in self._spans()
            if s["type"] == "tool_exec" and s["attrs"].get("held") is True
        ]
        self.assertTrue(held, "the approval gate held the vault call")
        self.assertEqual(held[0]["attrs"]["provider"], "vault")
        self.assertEqual(held[0]["attrs"]["tool"], "vault_read")
        # No successful vault exec happened alongside the hold.
        self.assertFalse(
            [
                s for s in self._spans()
                if s["type"] == "tool_exec"
                and s["attrs"].get("provider") == "vault"
                and not s["attrs"].get("held")
            ]
        )


class TestVaultProviderComposition(unittest.TestCase):
    """The builder + composition helpers, at the seam the CLI uses."""

    class _Args:
        def __init__(self, vault, no_vault_tools=False):
            self.vault = vault
            self.no_vault_tools = no_vault_tools

    def test_builder_returns_a_provider_by_default(self):
        prov = _build_vault_provider(self._Args("/tmp/whatever"), None)
        self.assertIsInstance(prov, VaultToolProvider)

    def test_builder_returns_none_when_opted_out(self):
        self.assertIsNone(
            _build_vault_provider(self._Args("/tmp/whatever", True), None)
        )

    def test_vault_only_run_is_not_wrapped_in_a_composite(self):
        prov = VaultToolProvider("/tmp/whatever")
        # The live denylist (toolhooks.PreToolUseGate) now wraps whatever this
        # function composes, so every run path gets it by construction. These
        # assertions are about the COMPOSITE — that a single source is not
        # needlessly fanned — so they look through the denylist to the source
        # underneath. `.source` is the wrapper's inner handle.
        self.assertIs(_compose_tool_source([], None, prov).source, prov)

    def test_web_plus_vault_composes_with_the_vault_last(self):
        from scprism_engine.webtools import WebToolProvider

        web = WebToolProvider()
        comp = _compose_tool_source([], web, VaultToolProvider("/tmp/whatever")).source
        self.assertIsInstance(comp, CompositeToolClient)
        names = [t.name for t in comp.list_tools()]
        self.assertEqual(names[:2], ["web_fetch", "web_search"])
        self.assertEqual(set(names[2:]), _VAULT_TOOL_NAMES)


if __name__ == "__main__":
    unittest.main()
