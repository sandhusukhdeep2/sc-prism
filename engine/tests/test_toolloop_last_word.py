"""Out of tool turns: the model is asked for its answer once (2026-11-15).

Seen in the installed app: a researcher on a local model was asked which
businesses in a town have no website. It ran nine searches, each returning
eight results, and fetched three pages — then asked for a thirteenth tool, and
the loop ended there. What came back was

    [incomplete: I ran out of tool turns (12 used) while still researching —
    this is what I had, not a finished answer.]

and nothing else: every reply had been a bare tool request, so "what I had"
was empty. Seventy-odd search results had been read and paid for, and not one
word about them was written. The team's summary said "0 businesses confirmed".

The loop had no turn in which the model was told the tools were finished. It
was shown results and asked "what next?" twelve times, and never "that is all
— what did you find?". So when the cap is reached the loop now asks exactly
once: the last request was not run, no more tools will run, write the answer
from what the tools already returned. A real answer is returned with a plain
note of where the research stopped; anything else — another tool request, an
empty reply, a stand-in — leaves the old marker exactly as it was.

Still bounded: one more model call, never a tool; and none at all when the
run's token budget is already spent.
"""

import copy
import json
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.gateway import ModelCallResult
from scprism_engine.mcp import MCPTool
from scprism_engine.toolloop import INCOMPLETE_PREFIX, run_tool_loop

SEARCH = MCPTool(
    name="web_search",
    description="Search the web.",
    input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
)

MARKER = (
    "[incomplete: I ran out of tool turns (2 used) while still researching — "
    "this is what I had, not a finished answer.]"
)


def _res(text, tokens_in=10, tokens_out=5, is_real=True):
    return ModelCallResult(
        text=text,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cache="miss",
        provider="stub",
        model="stub",
        is_real=is_real,
    )


def _ask(query="bakery"):
    return "```tool_call\n%s\n```" % json.dumps(
        {"tool": "web_search", "arguments": {"q": query}}
    )


def _messages():
    return [
        {"role": "system", "content": "You are the researcher."},
        {"role": "user", "content": "which businesses have no website?"},
    ]


def _found(name, args):
    return {"content": [{"type": "text", "text": "Hill St Bakery — no site listed"}]}


def _run(replies, seen=None, execs=None, **kw):
    """Run the loop with a cap of two tool turns over canned replies."""
    queue = iter(replies)
    seen = seen if seen is not None else []
    execs = execs if execs is not None else []

    def model_fn(messages):
        seen.append(copy.deepcopy(messages))
        return next(queue)

    def tool_exec(name, args):
        execs.append(name)
        return _found(name, args)

    return run_tool_loop(
        messages=_messages(),
        tools=[SEARCH],
        model_fn=model_fn,
        tool_exec=tool_exec,
        max_iters=2,
        **kw,
    )


class TheLastWordTest(unittest.TestCase):
    def test_the_answer_written_when_asked_is_the_answer(self):
        seen, execs = [], []
        result = _run(
            [_res(_ask()), _res(_ask("cafe")), _res(_ask("plumber")),
             _res("Hill St Bakery has no website.")],
            seen, execs,
        )
        self.assertTrue(result.text.startswith("Hill St Bakery has no website."))
        self.assertFalse(result.text.lstrip().startswith(INCOMPLETE_PREFIX))
        self.assertTrue(result.is_real)

    def test_the_answer_says_where_the_research_stopped(self):
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()), _res("One found.")]
        )
        self.assertIn("2 tool turns", result.text)
        self.assertIn("stopped", result.text)

    def test_the_model_is_told_its_tools_are_finished(self):
        seen = []
        _run([_res(_ask()), _res(_ask()), _res(_ask("third")), _res("One found.")], seen)
        last = seen[-1]
        # Its own unanswered request is in the conversation, then the notice.
        self.assertEqual(last[-2]["role"], "assistant")
        self.assertIn("third", last[-2]["content"])
        self.assertEqual(last[-1]["role"], "user")
        said = last[-1]["content"]
        self.assertIn("was not run", said)
        self.assertIn("No more tools", said)
        self.assertIn("2", said)

    def test_it_is_one_more_call_and_never_a_tool(self):
        seen, execs = [], []
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()), _res("One found.")],
            seen, execs,
        )
        self.assertEqual(len(execs), 2)
        self.assertEqual(len(seen), 4)  # two tool turns + the refused ask + the last word
        self.assertEqual(result.iterations, 2)
        self.assertEqual(len(result.tool_calls), 2)

    def test_every_call_is_counted_in_the_tokens(self):
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()), _res("One found.", 100, 40)]
        )
        self.assertEqual(result.tokens_in, 130)
        self.assertEqual(result.tokens_out, 55)


class StillUnfinishedTest(unittest.TestCase):
    def test_asking_for_another_tool_instead_is_still_unfinished(self):
        seen, execs = [], []
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()), _res(_ask("again"))],
            seen, execs,
        )
        self.assertEqual(result.text, MARKER)
        self.assertEqual(len(execs), 2, "the refused request was run")
        self.assertNotIn("```tool_call", result.text)

    def test_a_reply_wrapped_round_a_tool_request_is_still_unfinished(self):
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()),
             _res("Let me check one more.\n" + _ask("again"))]
        )
        self.assertTrue(result.text.startswith(INCOMPLETE_PREFIX))
        self.assertNotIn("```tool_call", result.text)

    def test_an_empty_reply_is_still_unfinished(self):
        result = _run([_res(_ask()), _res(_ask()), _res(_ask()), _res("   ")])
        self.assertEqual(result.text, MARKER)

    def test_a_stand_in_is_not_taken_for_the_answer(self):
        """A provider that went away answers with a stand-in. That is not the
        model's word on what it found, and must not replace the marker."""
        result = _run(
            [_res(_ask()), _res(_ask()), _res(_ask()),
             _res("[offline: no provider reachable]", is_real=False)]
        )
        self.assertEqual(result.text, MARKER)
        self.assertNotIn("offline", result.text)

    def test_no_last_word_is_asked_once_the_token_budget_is_spent(self):
        seen = []
        result = _run(
            [_res(_ask(), 100, 100), _res(_ask(), 100, 100), _res(_ask(), 100, 100),
             _res("One found.")],
            seen,
            token_budget=10_000,
        )
        # Within budget: asked.
        self.assertEqual(len(seen), 4)
        self.assertTrue(result.text.startswith("One found."))

        seen = []
        result = _run(
            [_res(_ask(), 100, 100), _res(_ask(), 100, 100), _res(_ask(), 100, 100),
             _res("One found.")],
            seen,
            token_budget=600,
        )
        self.assertEqual(len(seen), 3, "a call was made past the token budget")
        self.assertEqual(result.text, MARKER)


if __name__ == "__main__":
    unittest.main()
