"""Pure tests for the model tool-use loop core (MCP v2b, ADR-035).

No subprocess, no network: fake ``model_fn`` / ``tool_exec`` closures return
real ``ModelCallResult`` objects and canned tools/call results. These prove the
loop contract — the byte-identical no-tools fast path, the observation
feed-back, honest blocked/failed handling, the max_iters budget, token
accumulation — plus the ``parse_tool_call`` / ``build_tool_manifest`` helpers.
"""

import copy
import json
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPBlockedError, MCPError, MCPTool
from scprism_engine.toolloop import (
    ToolCallTrace,
    ToolLoopResult,
    build_tool_manifest,
    parse_tool_call,
    run_tool_loop,
)

ECHO = MCPTool(
    name="echo",
    description="Echo the given text back to the caller.",
    input_schema={
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    },
)
ADD = MCPTool(name="add", description="Add two numbers.", input_schema={})


def _res(text, tokens_in=10, tokens_out=5, is_real=False, cache="miss"):
    return ModelCallResult(
        text=text,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache=cache,
        provider="stub",
        model="stub",
        is_real=is_real,
    )


def _tool_call(name, arguments=None):
    payload = {"tool": name}
    if arguments is not None:
        payload["arguments"] = arguments
    return "```tool_call\n%s\n```" % json.dumps(payload)


def _scripted_model(responses, seen):
    """A model_fn that replays canned results, logging what it was shown."""
    replies = iter(responses)

    def model_fn(messages):
        seen.append(copy.deepcopy(messages))
        return next(replies)

    return model_fn


def _messages():
    return [
        {"role": "system", "content": "You are the companion."},
        {"role": "user", "content": "do the thing"},
    ]


class TestNoToolsFastPath(unittest.TestCase):
    def test_empty_tools_single_call_no_manifest_no_mutation(self):
        messages = _messages()
        snapshot = copy.deepcopy(messages)
        seen = []
        model_fn = _scripted_model([_res("plain answer", 7, 3, is_real=True)], seen)

        def tool_exec(name, args):
            raise AssertionError("tool_exec must never run on the fast path")

        result = run_tool_loop(
            messages=messages, tools=[], model_fn=model_fn, tool_exec=tool_exec
        )
        self.assertIsInstance(result, ToolLoopResult)
        self.assertEqual(result.text, "plain answer")
        self.assertEqual(result.iterations, 0)
        self.assertEqual(result.tool_calls, [])
        self.assertEqual(result.tokens_in, 7)
        self.assertEqual(result.tokens_out, 3)
        self.assertTrue(result.is_real)
        # Exactly one model call, shown the caller's messages VERBATIM — no
        # manifest, no protocol text (the byte-identical guarantee).
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0], snapshot)
        self.assertNotIn("tool_call", json.dumps(seen[0]))
        # The caller's messages were not mutated.
        self.assertEqual(messages, snapshot)

    def test_none_tools_takes_the_same_fast_path(self):
        seen = []
        model_fn = _scripted_model([_res("hi")], seen)
        result = run_tool_loop(
            messages=_messages(), tools=None, model_fn=model_fn, tool_exec=None
        )
        self.assertEqual(result.text, "hi")
        self.assertEqual(len(seen), 1)
        self.assertNotIn("tool_call", json.dumps(seen[0]))


class TestToolRounds(unittest.TestCase):
    def test_one_tool_call_then_final(self):
        messages = _messages()
        snapshot = copy.deepcopy(messages)
        seen = []
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "hi"})), _res("final: it said hi")],
            seen,
        )
        execs = []

        def tool_exec(name, args):
            execs.append((name, args))
            return {"content": [{"type": "text", "text": "hi"}]}

        result = run_tool_loop(
            messages=messages, tools=[ECHO, ADD], model_fn=model_fn, tool_exec=tool_exec
        )
        self.assertEqual(result.text, "final: it said hi")
        self.assertEqual(result.iterations, 1)
        self.assertEqual(execs, [("echo", {"text": "hi"})])
        self.assertEqual(len(result.tool_calls), 1)
        trace = result.tool_calls[0]
        self.assertIsInstance(trace, ToolCallTrace)
        self.assertEqual(trace.tool, "echo")
        self.assertTrue(trace.ok)
        self.assertFalse(trace.blocked)
        self.assertIn("hi", trace.detail)
        # Round 1: the manifest reached the SYSTEM message (extended, not a
        # second system turn).
        round1 = seen[0]
        self.assertEqual(round1[0]["role"], "system")
        self.assertIn("You are the companion.", round1[0]["content"])
        self.assertIn("- echo: ", round1[0]["content"])
        # Round 2: the model saw its own assistant turn plus the tool_result
        # observation as a USER turn carrying the REAL content.
        round2 = seen[1]
        self.assertEqual(round2[-2]["role"], "assistant")
        self.assertIn("tool_call", round2[-2]["content"])
        self.assertEqual(round2[-1]["role"], "user")
        self.assertIn("```tool_result", round2[-1]["content"])
        observation = json.loads(
            round2[-1]["content"].split("```tool_result\n", 1)[1].rsplit("\n```", 1)[0]
        )
        self.assertEqual(observation["tool"], "echo")
        self.assertTrue(observation["ok"])
        self.assertEqual(observation["content"], [{"type": "text", "text": "hi"}])
        # The caller's messages were not mutated by the loop path either.
        self.assertEqual(messages, snapshot)

    def test_no_system_message_inserts_manifest_at_index_0(self):
        seen = []
        model_fn = _scripted_model([_res("done")], seen)
        run_tool_loop(
            messages=[{"role": "user", "content": "q"}],
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda name, args: {"content": []},
        )
        self.assertEqual(seen[0][0]["role"], "system")
        self.assertIn("- echo: ", seen[0][0]["content"])
        self.assertEqual(seen[0][1], {"role": "user", "content": "q"})

    def test_blocked_tool_feeds_back_honest_ok_false_and_continues(self):
        seen = []
        model_fn = _scripted_model(
            [_res(_tool_call("add", {"a": 1, "b": 2})), _res("understood, blocked")],
            seen,
        )

        def tool_exec(name, args):
            # F6: a GOVERNANCE block raises the MCPBlockedError subclass.
            raise MCPBlockedError("tool 'add' is not allowed")

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO, ADD], model_fn=model_fn, tool_exec=tool_exec
        )
        # No exception escaped; the loop continued to the model's next text.
        self.assertEqual(result.text, "understood, blocked")
        self.assertEqual(result.iterations, 1)
        trace = result.tool_calls[0]
        self.assertFalse(trace.ok)
        self.assertTrue(trace.blocked)
        self.assertIn("not allowed", trace.detail)
        # The observation was truthful: ok false, the error as content.
        observation = seen[1][-1]["content"]
        self.assertIn('"ok": false', observation)
        self.assertIn("not allowed", observation)

    def test_is_error_result_is_failed_but_not_blocked(self):
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"})), _res("ok then")], []
        )

        def tool_exec(name, args):
            return {
                "isError": True,
                "content": [{"type": "text", "text": "unknown tool: echo"}],
            }

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
        )
        trace = result.tool_calls[0]
        self.assertFalse(trace.ok)
        self.assertFalse(trace.blocked)
        self.assertIn("unknown tool", trace.detail)

    def test_unexpected_tool_exec_exception_propagates(self):
        # A protocol/infra bug is not the model's business: no swallowing.
        model_fn = _scripted_model([_res(_tool_call("echo", {"text": "x"}))], [])

        def tool_exec(name, args):
            raise RuntimeError("infra broke")

        with self.assertRaises(RuntimeError):
            run_tool_loop(
                messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
            )

    def test_max_iters_cap_is_honest_and_bounded(self):
        max_iters = 2
        model_calls = []
        execs = []

        def greedy_model(messages):
            # Always asks for another tool — never a final answer.
            model_calls.append(len(messages))
            return _res(_tool_call("echo", {"text": "again"}))

        def tool_exec(name, args):
            execs.append(name)
            return {"content": [{"type": "text", "text": "again"}]}

        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=greedy_model,
            tool_exec=tool_exec,
            max_iters=max_iters,
        )
        # Bounded: exactly max_iters tool execs, max_iters + 1 model calls.
        self.assertEqual(len(execs), max_iters)
        self.assertEqual(len(model_calls), max_iters + 1)
        self.assertEqual(result.iterations, max_iters)
        self.assertEqual(len(result.tool_calls), max_iters)
        # HONEST + SAFE: the unexecuted request the model just made is stripped,
        # and the reply says exactly what stopped it, with the real count.
        self.assertNotIn("```tool_call", result.text)
        self.assertEqual(
            result.text,
            "[incomplete: I ran out of tool turns (2 used) while still "
            "researching — this is what I had, not a finished answer.]",
        )

    def test_malformed_tool_call_block_is_a_final_answer(self):
        # A malformed block never fires a tool (it is not a parseable request)
        # — and it is never SHOWN either: a raw fence in chat is the bug this
        # guard exists for, parseable or not.
        text = "```tool_call\n{not json at all\n```"
        model_fn = _scripted_model([_res(text)], [])

        def tool_exec(name, args):
            raise AssertionError("malformed block must never execute a tool")

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
        )
        self.assertNotIn("```tool_call", result.text)
        self.assertTrue(result.text.startswith("[incomplete:"))
        self.assertEqual(result.iterations, 0)
        self.assertEqual(result.tool_calls, [])

    def test_tokens_accumulate_but_is_real_describes_the_returned_text(self):
        """Tokens are a sum over the loop; realness is a claim about ONE text.

        This used to assert `is_real` was OR-ed across every call, which made
        the flag and the text describe different completions. A real team run
        on 2026-08-27 showed what that costs: a lead answered its first turn
        genuinely, read a vault note, and its second turn died with an
        IncompleteRead — so the loop returned the `[offline:...]` stand-in as
        its text with `is_real=True` beside it, and the board printed a
        stand-in labelled a genuine reply. In a product whose whole claim is
        that it never fakes activity, that is the one bug that matters.
        """
        model_fn = _scripted_model(
            [
                _res(_tool_call("echo", {"text": "a"}), 10, 2, is_real=False),
                _res(_tool_call("echo", {"text": "b"}), 20, 4, is_real=True),
                _res("done", 30, 8, is_real=False),
            ],
            [],
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda name, args: {"content": [{"type": "text", "text": "x"}]},
        )
        # Every call really was paid for, so the tokens still sum.
        self.assertEqual(result.tokens_in, 60)
        self.assertEqual(result.tokens_out, 14)
        # The text returned is the LAST call's, and that call was not real.
        self.assertEqual(result.text, "done")
        self.assertFalse(result.is_real)
        self.assertEqual(result.iterations, 2)
        self.assertEqual([t.tool for t in result.tool_calls], ["echo", "echo"])

    def test_a_real_last_turn_is_real_even_after_stand_in_turns(self):
        """The correction runs both ways: an earlier stand-in cannot taint a
        genuine final answer any more than an earlier real call can bless a
        stand-in."""
        model_fn = _scripted_model(
            [
                _res(_tool_call("echo", {"text": "a"}), 10, 2, is_real=False),
                _res("genuine answer", 30, 8, is_real=True),
            ],
            [],
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda name, args: {"content": [{"type": "text", "text": "x"}]},
        )
        self.assertEqual(result.text, "genuine answer")
        self.assertTrue(result.is_real)


class TestParseToolCall(unittest.TestCase):
    def test_valid_block(self):
        call = parse_tool_call('```tool_call\n{"tool": "echo", "arguments": {"text": "hi"}}\n```')
        self.assertEqual(call, {"tool": "echo", "arguments": {"text": "hi"}})

    def test_absent_arguments_default_to_empty_object(self):
        call = parse_tool_call('```tool_call\n{"tool": "echo"}\n```')
        self.assertEqual(call, {"tool": "echo", "arguments": {}})

    def test_last_block_wins(self):
        text = (
            '```tool_call\n{"tool": "first", "arguments": {}}\n```\n'
            "thinking...\n"
            '```tool_call\n{"tool": "second", "arguments": {}}\n```'
        )
        self.assertEqual(parse_tool_call(text)["tool"], "second")

    def test_surrounding_prose_and_whitespace_tolerated(self):
        text = '  I will call it now.\n\n```tool_call\n  {"tool": "echo"}  \n```  \n'
        self.assertEqual(parse_tool_call(text)["tool"], "echo")

    def test_crlf_line_endings_tolerated(self):
        text = '```tool_call\r\n{"tool": "echo", "arguments": {}}\r\n```'
        self.assertEqual(parse_tool_call(text)["tool"], "echo")

    def test_bad_json_returns_none(self):
        self.assertIsNone(parse_tool_call("```tool_call\n{nope\n```"))

    def test_non_dict_json_returns_none(self):
        self.assertIsNone(parse_tool_call('```tool_call\n["echo"]\n```'))

    def test_missing_tool_returns_none(self):
        self.assertIsNone(parse_tool_call('```tool_call\n{"arguments": {}}\n```'))

    def test_empty_tool_returns_none(self):
        self.assertIsNone(parse_tool_call('```tool_call\n{"tool": ""}\n```'))

    def test_non_string_tool_returns_none(self):
        self.assertIsNone(parse_tool_call('```tool_call\n{"tool": 3}\n```'))

    def test_non_dict_arguments_returns_none(self):
        self.assertIsNone(
            parse_tool_call('```tool_call\n{"tool": "echo", "arguments": [1]}\n```')
        )

    def test_no_block_returns_none(self):
        self.assertIsNone(parse_tool_call("just a normal final answer"))
        self.assertIsNone(parse_tool_call(""))

    def test_tool_result_block_is_not_a_tool_call(self):
        self.assertIsNone(
            parse_tool_call('```tool_result\n{"tool": "echo", "ok": true}\n```')
        )


class TestF1GuardObservation(unittest.TestCase):
    """F1 — the tool-RESULT egress gate. A guard redacts a sensitive result
    BEFORE it is fed back, so the secret never reaches the next model call; the
    withholding is recorded truthfully on the trace. Default None = identity."""

    def _secret_tool_exec(self, name, args):
        return {"content": [{"type": "text", "text": "config secret=hunter2trapdoor"}]}

    def _withholding_guard(self, content):
        if "secret" in content.lower():
            return "[withheld: sensitive]", True
        return content, False

    def _observation(self, messages):
        raw = messages[-1]["content"].split("```tool_result\n", 1)[1].rsplit("\n```", 1)[0]
        return json.loads(raw)

    def test_guard_withholds_sensitive_result_from_next_turn(self):
        seen = []
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"})), _res("done")], seen
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=self._secret_tool_exec,
            guard_observation=self._withholding_guard,
        )
        # The observation the model saw on turn 2 is the REDACTED string — the
        # secret is nowhere in the messages fed back (never egresses).
        obs = self._observation(seen[1])
        self.assertEqual(obs["content"], "[withheld: sensitive]")
        self.assertNotIn("hunter2trapdoor", json.dumps(seen[1]))
        # The trace records the withholding truthfully (honest audit).
        trace = result.tool_calls[0]
        self.assertTrue(trace.withheld)
        self.assertTrue(trace.ok)  # the tool itself succeeded; only feed-back redacted

    def test_clean_result_passes_through_and_withheld_false(self):
        seen = []
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"})), _res("done")], seen
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda n, a: {"content": [{"type": "text", "text": "plain fact"}]},
            guard_observation=self._withholding_guard,
        )
        obs = self._observation(seen[1])
        self.assertEqual(obs["content"], [{"type": "text", "text": "plain fact"}])
        self.assertFalse(result.tool_calls[0].withheld)

    def test_default_none_guard_is_identity_and_feeds_secret_unchanged(self):
        # The byte-identical guarantee: with no guard the observation is
        # UNCHANGED (this is a LOCAL/zero-egress route's behavior — nothing to
        # redact), so withheld stays False.
        seen = []
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"})), _res("done")], seen
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=self._secret_tool_exec,
        )
        obs = self._observation(seen[1])
        self.assertEqual(obs["content"], [{"type": "text", "text": "config secret=hunter2trapdoor"}])
        self.assertFalse(result.tool_calls[0].withheld)


class TestF2CodeFenceInArgs(unittest.TestCase):
    """F2 — a ``` code fence inside a JSON string argument (and braces inside
    strings) no longer truncates the block; balanced-brace parsing reads it."""

    def test_parse_handles_fence_and_braces_inside_string_arg(self):
        arg_text = "```python\ndef f():\n    return {'a': {'b': 1}}\n```"
        block = "```tool_call\n%s\n```" % json.dumps(
            {"tool": "run", "arguments": {"code": arg_text}}
        )
        call = parse_tool_call(block)
        self.assertIsNotNone(call)
        self.assertEqual(call["tool"], "run")
        self.assertEqual(call["arguments"]["code"], arg_text)

    def test_loop_runs_tool_with_fenced_code_argument(self):
        arg_text = "here is code:\n```js\nconst x = {y: 1};\n```\ndone"
        seen = []
        model_fn = _scripted_model(
            [
                _res("```tool_call\n%s\n```" % json.dumps(
                    {"tool": "echo", "arguments": {"text": arg_text}}
                )),
                _res("final"),
            ],
            seen,
        )
        execs = []

        def tool_exec(name, args):
            execs.append((name, args))
            return {"content": [{"type": "text", "text": "ok"}]}

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
        )
        # The tool ran with the EXACT fenced argument (no truncation at ```).
        self.assertEqual(execs, [("echo", {"text": arg_text})])
        self.assertEqual(result.text, "final")


class TestF6InfraVsGovernanceBlock(unittest.TestCase):
    """F6 — a governance block (MCPBlockedError) is blocked=True; an INFRA fault
    (plain MCPError: broken pipe / timeout / JSON-RPC) is blocked=False."""

    def test_infra_mcp_error_is_failed_but_not_blocked(self):
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"})), _res("ok then")], []
        )

        def tool_exec(name, args):
            raise MCPError("timed out waiting for response to 'tools/call'")

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
        )
        trace = result.tool_calls[0]
        self.assertFalse(trace.ok)
        self.assertFalse(trace.blocked)  # an infra fault is NOT a governance block
        self.assertIn("timed out", trace.detail)

    def test_governance_block_subclass_is_blocked_true(self):
        model_fn = _scripted_model(
            [_res(_tool_call("add", {"a": 1})), _res("understood")], []
        )

        def tool_exec(name, args):
            raise MCPBlockedError("tool 'add' is not allowed")

        result = run_tool_loop(
            messages=_messages(), tools=[ADD], model_fn=model_fn, tool_exec=tool_exec
        )
        self.assertFalse(result.tool_calls[0].ok)
        self.assertTrue(result.tool_calls[0].blocked)


class TestF7TokenBudget(unittest.TestCase):
    """F7 — a tight token_budget stops the loop before the next call with an
    honest note distinct from the max-iters note."""

    def test_tight_budget_stops_early_with_honest_note(self):
        calls = []

        def greedy(messages):
            calls.append(1)
            return _res(_tool_call("echo", {"text": "again"}), tokens_in=40, tokens_out=40)

        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=greedy,
            tool_exec=lambda n, a: {"content": [{"type": "text", "text": "ok"}]},
            max_iters=10,  # NOT the limiter here — the token budget is
            token_budget=50,  # first call (80 tokens) already exceeds it
        )
        # First call runs; the budget check before the 2nd call stops the loop.
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.iterations, 1)
        self.assertNotIn("```tool_call", result.text)  # never shown to a user
        self.assertIn(
            "[incomplete: I reached this run's token budget after 1 tool turns",
            result.text,
        )
        self.assertNotIn("ran out of tool turns", result.text)  # distinct reason

    def test_no_budget_default_never_stops_early(self):
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "x"}), 1000, 1000), _res("final")], []
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda n, a: {"content": []},
        )  # token_budget default None
        self.assertEqual(result.text, "final")


class TestF8CachePropagation(unittest.TestCase):
    """F8 — the tool-less degrade path (one call, zero tools) carries that
    call's REAL cache; a genuine multi-turn loop is honestly 'miss'."""

    def test_no_tools_fast_path_propagates_real_cache(self):
        result = run_tool_loop(
            messages=_messages(),
            tools=[],
            model_fn=_scripted_model([_res("hi", cache="prompt")], []),
            tool_exec=None,
        )
        self.assertEqual(result.cache, "prompt")

    def test_single_call_zero_tools_propagates_real_cache(self):
        # Tools configured, but the model answers immediately (zero tool calls).
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=_scripted_model([_res("final answer", cache="semantic")], []),
            tool_exec=lambda n, a: {"content": []},
        )
        self.assertEqual(result.iterations, 0)
        self.assertEqual(result.cache, "semantic")

    def test_multi_turn_loop_cache_is_miss(self):
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=_scripted_model(
                [_res(_tool_call("echo", {"text": "x"}), cache="prompt"),
                 _res("done", cache="prompt")],
                [],
            ),
            tool_exec=lambda n, a: {"content": []},
        )
        self.assertEqual(result.iterations, 1)
        self.assertEqual(result.cache, "miss")


class TestF9BlockOnlyFiring(unittest.TestCase):
    """F9 — a tool fires ONLY when the fenced block is the WHOLE reply; a block
    embedded in prose (stub echo / quoted block) is a final answer."""

    def test_block_only_reply_fires_the_tool(self):
        execs = []
        model_fn = _scripted_model(
            [_res(_tool_call("echo", {"text": "hi"})), _res("final")], []
        )
        result = run_tool_loop(
            messages=_messages(),
            tools=[ECHO],
            model_fn=model_fn,
            tool_exec=lambda n, a: (execs.append(n) or {"content": []}),
        )
        self.assertEqual(execs, ["echo"])
        self.assertEqual(result.text, "final")

    def test_block_embedded_in_prose_does_not_fire(self):
        # A model quoting the block in prose, or the offline stub echoing the
        # prompt: NOT a tool request — it is the final answer, no execution.
        prose = (
            "Sure, I could call it like this:\n"
            + _tool_call("echo", {"text": "hi"})
            + "\nbut here is my actual answer instead."
        )
        model_fn = _scripted_model([_res(prose)], [])

        def tool_exec(name, args):
            raise AssertionError("an embedded/quoted block must NOT execute a tool")

        result = run_tool_loop(
            messages=_messages(), tools=[ECHO], model_fn=model_fn, tool_exec=tool_exec
        )
        # No phantom execution (F9 holds) — AND no fence in the shown text.
        # This is the exact shape of the 2026-08-17 bug: prose + a block that
        # F9 refused to fire, returned verbatim into the user's chat.
        self.assertEqual(result.iterations, 0)
        self.assertEqual(result.tool_calls, [])
        self.assertNotIn("```tool_call", result.text)
        self.assertEqual(
            result.text,
            "[incomplete: I ended my turn still asking to run a tool (echo), so "
            "nothing more ran — this is what I had, not a finished answer.]\n\n"
            "Sure, I could call it like this:\n\n"
            "but here is my actual answer instead.",
        )


class TestBuildToolManifest(unittest.TestCase):
    def test_lists_every_tool_with_description_and_schema(self):
        manifest = build_tool_manifest([ECHO, ADD])
        self.assertIn("- echo: Echo the given text back to the caller.", manifest)
        self.assertIn("- add: Add two numbers.", manifest)
        # Non-empty schema is included compactly; ADD's empty one is omitted.
        self.assertIn(json.dumps(ECHO.input_schema, ensure_ascii=False), manifest)
        # Protocol instructions are present.
        self.assertIn("```tool_call", manifest)
        self.assertIn('{"tool": "<name>", "arguments": { ... }}', manifest)
        self.assertIn("ONLY", manifest)
        self.assertIn("one tool call per reply", manifest)
        self.assertIn("final answer", manifest)


if __name__ == "__main__":
    unittest.main()
