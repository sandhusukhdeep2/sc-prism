"""The capability gap record — Step 1 of the self-extending-tools lifecycle.

The spec's requirement, and the reason this exists at all:

    "Gaps are visible in the manager view — the user should see the manager say
     'I need a tool for this' rather than silently failing or fabricating an
     answer."

That is the whole value. A missing tool today produces either a quiet failure
or, worse, a plausible answer the model made up. A gap record turns the second
failure mode into the first, and the first into something actionable.

Acceptance criterion from the spec: a gap surfaces within ONE TURN of the
manager encountering it.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolgen import CapabilityGap, gap_from_failure, parse_gap_block


class TestGapRecord(unittest.TestCase):
    def test_it_carries_what_was_asked_and_what_was_missing(self):
        g = gap_from_failure(
            task="reconcile last week's supplier invoices",
            missing="nothing can read Northwind Foods PDF invoices",
            input_shape="a PDF per delivery, in vault/inbox/invoices/",
        )
        self.assertIsInstance(g, CapabilityGap)
        self.assertIn("reconcile", g.task)
        self.assertIn("Northwind", g.missing)
        self.assertIn("PDF", g.input_shape)

    def test_it_never_proposes_an_implementation(self):
        """A gap is a REPORT, not a plan. The manifest comes next, and it is
        the user who approves its scope — a gap that arrived with code attached
        would have skipped the gate that constrains everything downstream."""
        g = gap_from_failure(task="t", missing="m", input_shape="i")
        for attr in ("code", "implementation", "tool_py", "source"):
            self.assertFalse(hasattr(g, attr), f"a gap must not carry {attr}")

    def test_it_reads_as_the_manager_speaking_to_the_user(self):
        g = gap_from_failure(
            task="reconcile supplier invoices",
            missing="nothing can read that invoice format",
            input_shape="PDF",
        )
        line = g.to_line()
        self.assertIn("I need a tool", line)
        self.assertIn("reconcile supplier invoices", line)

    def test_it_asks_for_real_examples(self):
        """No fixtures, no registration. The manager must ask for real data
        rather than inventing it — the never-fabricate rule, applied here."""
        g = gap_from_failure(task="t", missing="m", input_shape="i")
        self.assertIn("example", g.to_line().lower())


class TestParsingAGapFromAReply(unittest.TestCase):
    BLOCK = (
        "I could not finish this.\n\n"
        "```capability_gap\n"
        "task: reconcile last week's supplier invoices\n"
        "missing: nothing can read Northwind Foods PDF invoices\n"
        "input_shape: one PDF per delivery in vault/inbox/invoices/\n"
        "```\n"
    )

    def test_a_well_formed_block_parses(self):
        g = parse_gap_block(self.BLOCK)
        self.assertIsNotNone(g)
        self.assertIn("Northwind", g.missing)

    def test_no_block_is_not_an_error(self):
        self.assertIsNone(parse_gap_block("just an ordinary answer"))

    def test_a_block_missing_a_field_is_refused_rather_than_guessed(self):
        self.assertIsNone(parse_gap_block("```capability_gap\ntask: x\n```"))

    def test_more_than_one_block_is_refused(self):
        # Two gaps in one reply means the model is listing possibilities, not
        # reporting the one thing that actually blocked it.
        self.assertIsNone(parse_gap_block(self.BLOCK + self.BLOCK))

    def test_the_parsed_gap_is_bounded(self):
        long_task = "x" * 5000
        g = parse_gap_block(
            f"```capability_gap\ntask: {long_task}\nmissing: m\ninput_shape: i\n```"
        )
        self.assertIsNotNone(g)
        self.assertLessEqual(len(g.task), 400)


if __name__ == "__main__":
    unittest.main()
