"""The gap reaches the user, and a draft manifest follows from it.

Step 1's acceptance criterion: "A capability gap surfaces in the manager view
within one turn of the manager encountering it."

Two halves. The model must KNOW it may report a gap — otherwise it does what
models do when a tool is missing, which is apologise vaguely or invent an
answer. And the loop must CATCH the report, because a gap the user never sees
is the silent failure it exists to replace.

Then Step 2: the draft manifest. It is generated from the gap and the user's
own examples, and it starts with NOTHING granted — every permission on it has
to be argued for and approved, which is what makes Gate 1 the gate that
constrains all the others.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.mcp import MCPTool
from scprism_engine.toolgen import draft_manifest, gap_from_failure
from scprism_engine.toolloop import build_tool_manifest


class TestTheModelKnowsItMayReportAGap(unittest.TestCase):
    def setUp(self):
        self.manifest = build_tool_manifest(
            [MCPTool(name="web_search", description="search", input_schema={})]
        )

    def test_the_tool_manifest_teaches_the_gap_block(self):
        self.assertIn("capability_gap", self.manifest)

    def test_it_is_offered_as_the_alternative_to_faking_an_answer(self):
        low = self.manifest.lower()
        self.assertIn("do not invent", low)
        self.assertIn("capability_gap", low)

    def test_it_does_not_weaken_the_act_dont_narrate_rule(self):
        """A gap must be the LAST resort, not a way out of using the tools that
        are already there — otherwise it becomes an excuse."""
        low = self.manifest.lower()
        self.assertIn("already authorized", low)
        self.assertIn("call it now", low)


class TestDraftManifest(unittest.TestCase):
    def setUp(self):
        self.gap = gap_from_failure(
            task="reconcile last week's supplier invoices",
            missing="nothing can read Northwind Foods PDF invoices",
            input_shape="one PDF per delivery in vault/inbox/invoices/",
        )

    def test_it_starts_with_nothing_granted(self):
        """Every permission must be argued for. A draft that arrives with
        access already assumed has skipped the gate that matters."""
        d = draft_manifest(self.gap)
        for cls, paths in d["permissions"].items():
            self.assertEqual(paths, [], f"{cls} was granted without being asked for")

    def test_it_is_confidential_and_local_until_argued_otherwise(self):
        d = draft_manifest(self.gap)
        self.assertEqual(d["data_class"], "confidential")
        self.assertEqual(d["execution_target"], "local_only")

    def test_it_is_unapproved_and_unproven(self):
        d = draft_manifest(self.gap)
        self.assertIsNone(d["approved_by"])
        self.assertEqual(d["passing_tests"], 0)

    def test_the_name_comes_from_the_gap_and_is_legal(self):
        d = draft_manifest(self.gap)
        self.assertRegex(d["name"], r"^[a-z][a-z0-9_]{2,63}$")

    def test_the_description_quotes_the_user_not_the_model(self):
        d = draft_manifest(self.gap)
        self.assertIn("invoice", d["description"].lower())

    def test_a_requested_permission_is_carried_but_still_unapproved(self):
        d = draft_manifest(self.gap, requested={"filesystem_read": ["inbox/invoices/**"]})
        self.assertEqual(d["permissions"]["filesystem_read"], ["inbox/invoices/**"])
        self.assertIsNone(d["approved_by"])

    def test_a_wildcard_request_is_refused_at_draft_time(self):
        # Better to fail here, while it is cheap, than to put a wildcard in
        # front of a user for approval as though it were reasonable.
        from scprism_engine.toolgen import ManifestError, parse_manifest

        d = draft_manifest(self.gap, requested={"filesystem_read": ["**"]})
        with self.assertRaises(ManifestError):
            parse_manifest(d)

    def test_the_draft_parses_as_a_real_manifest(self):
        from scprism_engine.toolgen import parse_manifest

        m = parse_manifest(draft_manifest(self.gap))
        self.assertFalse(m.callable)


if __name__ == "__main__":
    unittest.main()


class TestTheDefaultNameIsUsable(unittest.TestCase):
    """A default the user must rewrite every time is not a default.

    The first version slugged the `missing` field, which is phrased as a
    complaint — "nothing can read Northwind Foods PDF invoices" became
    `nothing_can_read_northwind`. A tool is named for what it DOES.
    """

    def test_it_reads_as_a_thing_that_does_something(self):
        g = gap_from_failure(
            task="reconcile last week's supplier invoices",
            missing="nothing can read Northwind Foods PDF invoices",
            input_shape="PDF",
        )
        name = draft_manifest(g)["name"]
        self.assertNotIn("nothing", name)
        self.assertRegex(name, r"^[a-z][a-z0-9_]{2,63}$")

    def test_it_drops_the_leading_negation_whatever_the_wording(self):
        for missing in (
            "nothing can read the POS export",
            "no tool can parse the roster spreadsheet",
            "there is no way to read the XML feed",
        ):
            with self.subTest(missing=missing):
                g = gap_from_failure(task="do the thing", missing=missing, input_shape="x")
                name = draft_manifest(g)["name"]
                self.assertNotIn("nothing", name)
                self.assertNotIn("no_tool", name)

    def test_it_still_says_what_the_tool_is_about(self):
        g = gap_from_failure(
            task="reconcile invoices",
            missing="nothing can read Northwind Foods PDF invoices",
            input_shape="PDF",
        )
        self.assertIn("invoice", draft_manifest(g)["name"])
