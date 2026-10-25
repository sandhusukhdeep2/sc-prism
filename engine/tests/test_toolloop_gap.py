"""The loop catches a capability gap and carries it out.

A gap the user never sees is exactly the silent failure it exists to replace,
so reporting one has to survive the trip out of the loop. The acceptance
criterion is one turn: the manager encounters the gap, and the user sees it.

The block is also STRIPPED from the answer text, for the same reason a
`tool_call` fence is: it is a protocol artefact, not prose, and showing it raw
would put machinery in front of someone who asked a question.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolloop import run_tool_loop


class _Res:
    def __init__(self, text):
        self.text, self.tokens_in, self.tokens_out, self.is_real = text, 5, 5, True


REPLY = (
    "I can't do this with what I have.\n\n"
    "```capability_gap\n"
    "task: reconcile last week's supplier invoices\n"
    "missing: nothing can read Northwind Foods PDF invoices\n"
    "input_shape: one PDF per delivery in vault/inbox/invoices/\n"
    "```\n"
)


class TestLoopCarriesTheGap(unittest.TestCase):
    def _run(self, reply):
        return run_tool_loop(
            messages=[{"role": "user", "content": "reconcile the invoices"}],
            tools=[],
            model_fn=lambda _m: _Res(reply),
            tool_exec=lambda _n, _a: {"content": "", "isError": False},
        )

    def test_a_gap_is_carried_out_of_the_loop(self):
        r = self._run(REPLY)
        self.assertIsNotNone(r.capability_gap)
        self.assertIn("Northwind", r.capability_gap.missing)

    def test_no_gap_is_the_ordinary_case(self):
        self.assertIsNone(self._run("here is your answer").capability_gap)

    def test_the_block_never_reaches_the_user_as_prose(self):
        r = self._run(REPLY)
        self.assertNotIn("capability_gap", r.text)
        self.assertNotIn("input_shape:", r.text)

    def test_the_model_s_own_words_survive(self):
        r = self._run(REPLY)
        self.assertIn("can't do this", r.text)

    def test_a_malformed_block_is_ignored_and_left_out_of_the_answer(self):
        # Refusing to guess: a half-written block is not a gap. But it is still
        # protocol noise, so it must not be shown either.
        r = self._run("nope\n\n```capability_gap\ntask: x\n```\n")
        self.assertIsNone(r.capability_gap)
        self.assertNotIn("capability_gap", r.text)


if __name__ == "__main__":
    unittest.main()
