"""A reply that holds no answer text is a NAMED no-answer, asked for once (2026-11-14).

Seen on the released build: a seat on the owner's local reasoning model was
asked for its next turn and the board said ``no answer — KeyError: 'content'``,
a hundred seconds later.

What the server's own log shows for those hundred seconds: the same request
three times, each ending ``finish_reason=length`` at exactly the 4,096-token
allowance. The model had spent the whole allowance thinking. An
OpenAI-compatible server leaves ``content`` out of the message when there is no
answer text (its thinking goes in ``reasoning_content``), so the gateway's
``message["content"]`` raised ``KeyError`` — which it files under "the body was
not a completion" and retries. At temperature 0 the retry is the same question
with the same ending, twice more.

So two things were wrong, and neither was the model's:

  * the cause was printed as a programming error, not as what happened;
  * a VERDICT — the model answered, with nothing — was retried as if it were a
    broken pipe, tripling the wait.

A missing, null or blank ``content`` is the model writing no answer. It is
named in plain words, asked for once, and keeps the token counts the server
measured.
"""
import json
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.gateway import Gateway, RouteDecision, stand_in_cause


class _FakeResp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


_MSGS = [{"role": "user", "content": "Add a third line to hello.md"}]
_USAGE = {"prompt_tokens": 1989, "completion_tokens": 4096}


def _body(message, finish="stop", usage=_USAGE):
    return {"choices": [{"message": message, "finish_reason": finish}], "usage": usage}


#: What the owner's server sent: the allowance gone, all of it thinking.
ONLY_THINKING = _body(
    {"role": "assistant", "reasoning_content": "Let me look at the file again…"},
    finish="length",
)


def _local():
    return RouteDecision(
        provider="local", model="m", target="local", is_local=True,
        reason="test", base_url="http://x", api_key="",
    )


def _claude():
    return RouteDecision(
        provider="claude", model="claude-x", target="cloud", is_local=False,
        reason="test", base_url="http://x", api_key="k",
    )


def _call(*bodies, route=None):
    """Run one `model_call` against a server that answers with `bodies` in turn
    (the last one repeats). Returns (result, how many requests were made)."""
    gw = Gateway(env={})
    sent = {"n": 0}

    def urlopen(req, timeout=None):
        body = bodies[min(sent["n"], len(bodies) - 1)]
        sent["n"] += 1
        return _FakeResp(body)

    with mock.patch("urllib.request.urlopen", urlopen), mock.patch("time.sleep"):
        res = gw.model_call(_MSGS, route or _local())
    return res, sent["n"]


class TestAReplyWithNoAnswerTextIsNamed(unittest.TestCase):
    def test_an_allowance_spent_thinking_says_so(self):
        res, _ = _call(ONLY_THINKING)
        self.assertFalse(res.is_real)
        # The stand-in family the clients keep out of the chat.
        self.assertTrue(res.text.startswith("[offline:local:m] "), res.text)
        self.assertEqual(
            stand_in_cause(res.text),
            "the model spent its whole answer allowance (4,096 tokens) thinking "
            "and wrote no answer",
        )

    def test_it_is_never_printed_as_a_programming_error(self):
        res, _ = _call(ONLY_THINKING)
        self.assertNotIn("KeyError", res.text)

    def test_it_is_asked_once_not_three_times(self):
        """The model answered. Asking again at temperature 0 is the same wait
        for the same ending."""
        _, sent = _call(ONLY_THINKING)
        self.assertEqual(sent, 1)

    def test_the_tokens_the_server_measured_are_kept(self):
        """They are a measurement, not an estimate: the model really read 1,989
        tokens and really produced 4,096."""
        res, _ = _call(ONLY_THINKING)
        self.assertEqual((res.tokens_in, res.tokens_out), (1989, 4096))

    def test_a_null_or_blank_content_is_the_same_as_a_missing_one(self):
        for content in (None, "", "  \n"):
            with self.subTest(content=content):
                res, sent = _call(
                    _body({"content": content, "reasoning_content": "hm"}, finish="length")
                )
                self.assertFalse(res.is_real)
                self.assertIn("thinking and wrote no answer", res.text)
                self.assertEqual(sent, 1)

    def test_cut_off_with_no_thinking_reported_does_not_claim_thinking(self):
        res, _ = _call(_body({"role": "assistant"}, finish="length"))
        self.assertEqual(
            stand_in_cause(res.text),
            "the model reached its answer allowance (4,096 tokens) before "
            "writing an answer",
        )

    def test_a_tool_request_with_no_text_says_that(self):
        """A server that reads the model's own tool syntax hands the request
        over as `tool_calls` and leaves the text out. This engine asks for
        tools in the text, so it cannot act on that — and says which it was."""
        res, sent = _call(
            _body(
                {"role": "assistant", "tool_calls": [{"id": "1", "type": "function",
                 "function": {"name": "read_file", "arguments": "{}"}}]},
                finish="tool_calls",
            )
        )
        self.assertFalse(res.is_real)
        self.assertEqual(
            stand_in_cause(res.text),
            "the model answered with a tool request only, in a form this app "
            "does not read, and wrote no text",
        )
        self.assertEqual(sent, 1)

    def test_a_finished_reply_with_nothing_in_it_is_an_empty_answer(self):
        res, _ = _call(_body({"role": "assistant"}, finish="stop"))
        self.assertEqual(stand_in_cause(res.text), "the model returned an empty answer")


class TestWhatWasAlreadyRightStaysRight(unittest.TestCase):
    def test_an_answer_is_an_answer_with_or_without_thinking_beside_it(self):
        for message in (
            {"content": "Done — third line added."},
            {"content": "Done — third line added.", "reasoning_content": "easy"},
        ):
            with self.subTest(message=message):
                res, sent = _call(_body(message))
                self.assertTrue(res.is_real)
                self.assertEqual(res.text, "Done — third line added.")
                self.assertEqual(sent, 1)

    def test_a_cut_off_answer_is_still_a_real_cut_off_answer(self):
        res, _ = _call(_body({"content": "Done — thi"}, finish="length"))
        self.assertTrue(res.is_real)
        self.assertTrue(res.truncated)
        self.assertEqual(res.text, "Done — thi")

    def test_a_body_that_is_not_a_completion_is_still_retried(self):
        """No `choices` at all is the server hiccup the retry exists for."""
        res, sent = _call({"error": "busy"}, _body({"content": "recovered"}))
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "recovered")
        self.assertEqual(sent, 2)


def _blocks(*content, stop="end_turn"):
    return {
        "content": list(content),
        "stop_reason": stop,
        "usage": {"input_tokens": 50, "output_tokens": 120},
    }


_THINKING = {"type": "thinking", "thinking": "Let me work through it…", "signature": "s"}


class TestTheMessagesApiIsReadTheSameWay(unittest.TestCase):
    """The same fault in the other reader. A Messages reply is a LIST of
    blocks, and with thinking on the first block is the thinking, which has no
    `text`. Reading `content[0]["text"]` made every such reply a `KeyError:
    'text'` — three paid calls and no answer. The answer is the text blocks."""

    def test_the_answer_is_the_text_block_wherever_it_sits(self):
        res, sent = _call(
            _blocks(_THINKING, {"type": "text", "text": "Done."}), route=_claude()
        )
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "Done.")
        self.assertEqual(sent, 1)

    def test_several_text_blocks_are_one_answer(self):
        res, _ = _call(
            _blocks({"type": "text", "text": "Done. "}, {"type": "text", "text": "Third line added."}),
            route=_claude(),
        )
        self.assertEqual(res.text, "Done. Third line added.")

    def test_an_allowance_spent_thinking_says_so_once_with_its_tokens(self):
        res, sent = _call(_blocks(_THINKING, stop="max_tokens"), route=_claude())
        self.assertFalse(res.is_real)
        self.assertEqual(
            stand_in_cause(res.text),
            "the model spent its whole answer allowance (4,096 tokens) thinking "
            "and wrote no answer",
        )
        self.assertEqual(sent, 1)
        self.assertEqual((res.tokens_in, res.tokens_out), (50, 120))

    def test_a_reply_with_no_blocks_is_an_empty_answer(self):
        res, sent = _call(_blocks(), route=_claude())
        self.assertFalse(res.is_real)
        self.assertEqual(stand_in_cause(res.text), "the model returned an empty answer")
        self.assertEqual(sent, 1)

    def test_a_plain_reply_is_what_it_always_was(self):
        res, _ = _call(_blocks({"type": "text", "text": "Hello."}), route=_claude())
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "Hello.")
        self.assertEqual((res.tokens_in, res.tokens_out), (50, 120))


if __name__ == "__main__":
    unittest.main()
