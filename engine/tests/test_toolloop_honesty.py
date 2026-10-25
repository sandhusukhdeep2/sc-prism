"""HONESTY: a ``tool_call`` fence must never reach a user, and the tool-turn
budget must be big enough to research yet still bounded (2026-08-18).

The live bug, reproduced here verbatim from the recorded Verdict
(``https-themeforest-net-user-slashcreative-945c8737``): the local model
replied with PROSE plus an unexecuted ``tool_call`` block. F9 correctly refused
to fire it (the block was not the whole reply) and the loop returned that text
as the final answer, so the chat rendered a raw protocol fence as the
assistant's answer. Nothing in the loop stripped it, and nothing said the
investigation had stopped early.

These tests pin BOTH halves of the fix:
  * every ``run_tool_loop`` return path goes through the SHARED guard
    (``guard_answer`` / ``incomplete_answer``), so no path can leak a fence —
    including the ones that did not exist when this was written;
  * the tool-turn budget defaults to ``DEFAULT_MAX_ITERS``, is overridable per
    run and by ``SCPRISM_TOOL_TURNS``, and is clamped both ways so no override
    can unbound the loop.
"""

import json
import os
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPTool
from scprism_engine.toolloop import (
    DEFAULT_MAX_ITERS,
    INCOMPLETE_PREFIX,
    MAX_MAX_ITERS,
    MIN_MAX_ITERS,
    default_max_iters,
    guard_answer,
    has_tool_call_fence,
    mark_incomplete,
    resolve_max_iters,
    run_tool_loop,
    strip_tool_call_blocks,
)

ECHO = MCPTool(name="echo", description="Echo text back.", input_schema={})

# The EXACT text the user's chat rendered on 2026-08-17 (from the saved
# Verdict's `response` field) — prose, then an unexecuted tool request.
LIVE_BUG_TEXT = (
    "The HTTPS fetcher hit a local issue, so I'll search for this instead.\n\n"
    '```tool_call\n{"tool": "web_search", "arguments": '
    '{"query": "themeforest.net slashcreative"}}\n```'
)


def _res(text, tokens_in=10, tokens_out=5):
    return ModelCallResult(
        text=text,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache="miss",
        provider="stub",
        model="stub",
        is_real=True,
    )


def _call(name="echo", arguments=None):
    return "```tool_call\n%s\n```" % json.dumps(
        {"tool": name, "arguments": arguments or {"text": "x"}}
    )


def _messages():
    return [
        {"role": "system", "content": "You are the companion."},
        {"role": "user", "content": "research this for me"},
    ]


def _ok_tool(name, args):
    return {"content": [{"type": "text", "text": "observed"}]}


class TestSharedGuard(unittest.TestCase):
    """The guard itself — one function every user-visible path can lean on."""

    def test_the_live_bug_text_loses_its_fence_and_keeps_its_prose(self):
        guarded = guard_answer(LIVE_BUG_TEXT)
        self.assertNotIn("```tool_call", guarded)
        self.assertNotIn("web_search", guarded.split("]", 1)[1])
        # The prose the model DID write is preserved, verbatim.
        self.assertIn(
            "The HTTPS fetcher hit a local issue, so I'll search for this instead.",
            guarded,
        )
        # And it is MARKED, so the UI can show it as an unfinished
        # investigation rather than as an answer.
        self.assertTrue(guarded.startswith(INCOMPLETE_PREFIX))
        self.assertIn("still asking to run a tool (web_search)", guarded)

    def test_a_normal_completion_is_byte_identical(self):
        for text in (
            "Here is the answer: 42.",
            "```python\nprint('hi')\n```",  # an ordinary code fence is untouched
            "I considered calling a tool but answered directly.",
            "",
        ):
            self.assertEqual(guard_answer(text), text)
            self.assertFalse(has_tool_call_fence(text))

    def test_every_block_is_stripped_not_just_the_last(self):
        text = "one\n%s\ntwo\n%s\nthree" % (_call("a"), _call("b"))
        body, names = strip_tool_call_blocks(text)
        self.assertNotIn("```tool_call", body)
        self.assertEqual(names, ["a", "b"])
        self.assertIn("one", body)
        self.assertIn("two", body)
        self.assertIn("three", body)

    def test_an_unterminated_fence_owns_the_rest_of_the_reply(self):
        # A model cut off mid-request: there is no closing fence, so nothing
        # after the opener is answer text and none of it may be shown.
        body, _ = strip_tool_call_blocks('prose first\n```tool_call\n{"tool": "web_')
        self.assertEqual(body, "prose first")

    def test_a_fence_with_a_code_fence_inside_a_string_argument(self):
        # F2's balanced-brace scan: a ``` inside a JSON string must not end the
        # block early and leave half a fence on screen.
        text = _call("write", {"body": "```\nhello\n```"}) + "\ndone"
        body, names = strip_tool_call_blocks(text)
        self.assertEqual(names, ["write"])
        self.assertEqual(body, "done")

    def test_marking_is_applied_exactly_once(self):
        once = guard_answer(LIVE_BUG_TEXT)
        self.assertEqual(guard_answer(once), once)  # already clean, unchanged
        self.assertEqual(mark_incomplete(once, "some other reason"), once)

    def test_guard_never_raises_on_odd_input(self):
        self.assertEqual(strip_tool_call_blocks(None), ("", []))
        self.assertFalse(has_tool_call_fence(None))
        self.assertFalse(has_tool_call_fence(7))


class TestNoReturnPathLeaksAFence(unittest.TestCase):
    """The contract that outlives this file: whatever path the loop returns
    through, the text it hands back carries no tool_call fence."""

    def _paths(self):
        """(label, kwargs) for EVERY way ``run_tool_loop`` can return, each
        driven by a model that always emits a fence."""
        greedy = lambda messages: _res(_call())  # noqa: E731
        prose = lambda messages: _res(LIVE_BUG_TEXT)  # noqa: E731
        return [
            # 1. The tool-less fast path (no manifest was ever sent).
            ("no tools", dict(tools=None, model_fn=prose, tool_exec=_ok_tool)),
            # 2. The final-answer path via F9 (prose wrapped around a block) —
            #    the path the live bug actually took.
            ("f9 final answer", dict(tools=[ECHO], model_fn=prose, tool_exec=_ok_tool)),
            # 3. The max_iters exhaustion path.
            (
                "tool turns exhausted",
                dict(tools=[ECHO], model_fn=greedy, tool_exec=_ok_tool, max_iters=2),
            ),
            # 4. The token-budget path (F7).
            (
                "token budget",
                dict(
                    tools=[ECHO],
                    model_fn=greedy,
                    tool_exec=_ok_tool,
                    max_iters=10,
                    token_budget=1,
                ),
            ),
        ]

    def test_no_path_returns_a_tool_call_fence(self):
        for label, kwargs in self._paths():
            with self.subTest(path=label):
                result = run_tool_loop(messages=_messages(), **kwargs)
                self.assertNotIn("```tool_call", result.text)
                self.assertTrue(
                    result.text.startswith(INCOMPLETE_PREFIX),
                    "%s: unfinished work must be MARKED, got %r" % (label, result.text),
                )


class TestExhaustionSaysWhatHappened(unittest.TestCase):
    def test_exhaustion_message_names_the_count(self):
        # Reaching the budget means every turn was a BLOCK-ONLY request (F9
        # sends anything else down the final-answer path), so the model wrote
        # no prose to hand back and the honest reply is the marker alone —
        # never the unexecuted request it was in the middle of making.
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=lambda m: _res(_call("web_search", {"q": "x"})),
            tool_exec=_ok_tool,
            max_iters=4,
        )
        self.assertEqual(
            result.text,
            "[incomplete: I ran out of tool turns (4 used) while still "
            "researching — this is what I had, not a finished answer.]",
        )
        self.assertEqual(result.iterations, 4)
        # The count is the REAL one, not the constant: a per-run cap is named
        # honestly too.
        other = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=lambda m: _res(_call()),
            tool_exec=_ok_tool,
            max_iters=7,
        )
        self.assertIn("(7 used)", other.text)

    def test_token_budget_reason_is_distinct_from_tool_turns(self):
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=lambda m: _res(_call(), tokens_in=100, tokens_out=100),
            tool_exec=_ok_tool,
            max_iters=10,
            token_budget=50,
        )
        self.assertIn("reached this run's token budget", result.text)
        self.assertNotIn("ran out of tool turns", result.text)


class TestToolTurnBudget(unittest.TestCase):
    """FIX 2: bigger, configurable — and still bounded."""

    def test_default_is_the_documented_constant(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SCPRISM_TOOL_TURNS", None)
            self.assertEqual(default_max_iters(), DEFAULT_MAX_ITERS)
            self.assertEqual(resolve_max_iters(None), DEFAULT_MAX_ITERS)
            self.assertEqual(resolve_max_iters(0), DEFAULT_MAX_ITERS)

    def test_env_override_is_honoured_and_clamped(self):
        cases = [
            ("20", 20),
            ("1", 1),
            ("0", MIN_MAX_ITERS),  # clamped up: a tool loop gets at least one
            ("-5", MIN_MAX_ITERS),
            ("9999", MAX_MAX_ITERS),  # clamped down: never unbounded
            ("nonsense", DEFAULT_MAX_ITERS),  # a typo falls back, never crashes
            ("", DEFAULT_MAX_ITERS),
        ]
        for raw, want in cases:
            with self.subTest(env=raw):
                with mock.patch.dict(os.environ, {"SCPRISM_TOOL_TURNS": raw}):
                    self.assertEqual(default_max_iters(), want)

    def test_per_run_value_wins_over_env_and_is_clamped(self):
        with mock.patch.dict(os.environ, {"SCPRISM_TOOL_TURNS": "5"}):
            self.assertEqual(resolve_max_iters(7), 7)  # explicit beats env
            self.assertEqual(resolve_max_iters(9999), MAX_MAX_ITERS)
            self.assertEqual(resolve_max_iters(0), 5)  # 0 = "no choice" -> env

    def test_the_loop_really_runs_the_resolved_number_of_turns(self):
        for env, per_run, want in [("", None, DEFAULT_MAX_ITERS), ("3", None, 3), ("3", 6, 6)]:
            with self.subTest(env=env, per_run=per_run):
                execs = []
                patched = {"SCPRISM_TOOL_TURNS": env} if env else {}
                with mock.patch.dict(os.environ, patched, clear=False):
                    if not env:
                        os.environ.pop("SCPRISM_TOOL_TURNS", None)
                    result = run_tool_loop(
                        messages=_messages(),
                        tools=[ECHO],
                        model_fn=lambda m: _res(_call()),
                        tool_exec=lambda n, a: (execs.append(n) or {"content": []}),
                        max_iters=per_run,
                    )
                self.assertEqual(len(execs), want)
                self.assertEqual(result.iterations, want)
                self.assertIn("(%d used)" % want, result.text)

    def test_the_new_default_is_defensibly_bigger_but_still_capped(self):
        # The live failure spent 1 turn on a failed fetch and 3 on searches and
        # was cut off; the shape of a real research turn (fetch, fall back to a
        # search, read three results, correct and read three more) is 9.
        self.assertGreaterEqual(DEFAULT_MAX_ITERS, 9)
        self.assertLessEqual(DEFAULT_MAX_ITERS, MAX_MAX_ITERS)
        self.assertLess(MAX_MAX_ITERS, 100)


class _FakeVerdict:
    """Just enough Verdict for `_cmd_run`'s print/exit path."""

    passed = True
    spans_path = ""

    def to_json(self):
        return "{}"


class TestPerRunFlagReachesTheLoop(unittest.TestCase):
    """`--tool-turns` is how the APP passes a per-run value, threaded exactly
    the way `--token-budget` was: omitted means the engine's own default."""

    def _captured_run(self, argv, vault):
        import io
        from contextlib import redirect_stderr, redirect_stdout

        from scprism_engine import __main__ as cli

        seen = {}

        def fake_run(contract, **kwargs):
            seen.update(kwargs)
            return _FakeVerdict()

        with mock.patch.object(cli, "run", fake_run):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                cli.main(argv + ["--vault", vault])
        return seen

    def test_the_flag_is_forwarded_and_omitting_it_means_default(self):
        import tempfile

        with tempfile.TemporaryDirectory() as vault:
            with_flag = self._captured_run(["run", "look this up", "--tool-turns", "20"], vault)
            self.assertEqual(with_flag["mcp_max_iters"], 20)
            # Omitted -> 0 -> "no per-run choice", which resolve_max_iters maps
            # to the env/engine default. Byte-identical to before the flag.
            without = self._captured_run(["run", "look this up"], vault)
            self.assertEqual(without["mcp_max_iters"], 0)
            self.assertEqual(resolve_max_iters(without["mcp_max_iters"]), DEFAULT_MAX_ITERS)


if __name__ == "__main__":
    unittest.main()
