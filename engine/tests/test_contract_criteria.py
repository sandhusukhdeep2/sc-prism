import unittest

import _bootstrap  # noqa: F401  (sets up sys.path)

from scprism_engine.contract import parse


class TestCriteriaMatchTheMode(unittest.TestCase):
    """A read task is not judged by whether the build passed.

    Every run used to get the write-mode pair — "repository checks pass" and "a
    plausible IMPLEMENTATION of the intent". For a task that changes a repo that
    is right. For a companion wake it is unmeetable by construction: no repo, no
    tests, no change. Sukhdeep's wakes were doing the work asked of them, being
    scored 0.0175 for it, and his pass rate read 3% because most of what this
    app does is read-only.
    """

    def test_a_write_task_is_still_judged_on_the_build_and_the_change(self):
        c = parse("add a rate limit guard to the uploader", mode="write")
        joined = " ".join(c.acceptance_criteria)
        self.assertIn("tests/lint/build", joined)
        self.assertIn("plausible implementation", joined)

    def test_a_read_task_is_NOT_asked_for_a_passing_build(self):
        c = parse("review the vault and report what needs attention", mode="read")
        joined = " ".join(c.acceptance_criteria)
        self.assertNotIn("tests/lint/build", joined)
        self.assertNotIn("plausible implementation", joined)

    def test_a_read_task_is_judged_on_answering_from_real_evidence(self):
        intent = "review the vault and report what needs attention"
        c = parse(intent, mode="read")
        joined = " ".join(c.acceptance_criteria)
        self.assertIn("evidence actually gathered", joined)
        self.assertIn(intent, joined)

    def test_RESTING_is_a_pass_when_the_reply_says_what_it_checked(self):
        # The companion charter says resting is a real outcome. A judge that
        # cannot score it as one turns "nothing to do" into a failure every
        # time the vault is quiet.
        c = parse("check in on the business", mode="read")
        joined = " ".join(c.acceptance_criteria)
        self.assertIn("nothing needed doing", joined)
        self.assertIn("IS a pass", joined)

    def test_tier1_is_named_not_applicable_rather_than_left_to_read_as_failure(self):
        c = parse("check in on the business", mode="read")
        self.assertTrue(
            any("not applicable" in x for x in c.acceptance_criteria),
            "a skipped tier-1 must be stated as inapplicable, not as unverified",
        )

    def test_an_explicit_criteria_list_is_never_overridden(self):
        mine = ["tier2: it rhymes"]
        c = parse("write a poem", mode="read", acceptance_criteria=mine)
        self.assertEqual(c.acceptance_criteria, mine)

    def test_the_mode_is_settled_before_the_criteria_are_chosen(self):
        # `parse` infers the mode when none is given; the criteria must follow
        # the INFERRED mode, not the default.
        c = parse("review and analyze the vault contents")
        self.assertEqual(c.mode, "read")
        self.assertNotIn("tests/lint/build", " ".join(c.acceptance_criteria))


class TestConverseCriteria(unittest.TestCase):
    """A chat turn is not judged as a build that produced no files.

    The Work page's chat reached the engine with no kind information, the
    contract inferred "write", and the judge was handed the write-mode pair —
    so a perfectly good conversational reply ("what look do you want for the
    theme?") scored ~0 on acceptance and completion and the run was stamped
    failed: "no files were produced". The judge was behaving correctly given
    wrong criteria. A conversational turn gets conversational criteria.
    """

    _INTENT = "Create a wordpress theme like moppers slashcreative"

    def test_converse_is_a_valid_explicit_mode(self):
        c = parse(self._INTENT, mode="converse")
        self.assertEqual(c.mode, "converse")

    def test_a_converse_turn_is_NOT_asked_for_files_or_a_build(self):
        joined = " ".join(parse(self._INTENT, mode="converse").acceptance_criteria)
        self.assertNotIn("tests/lint/build", joined)
        self.assertNotIn("plausible implementation", joined)

    def test_a_converse_turn_is_judged_on_being_responsive_to_what_was_said(self):
        joined = " ".join(parse(self._INTENT, mode="converse").acceptance_criteria)
        self.assertIn("responsive", joined)
        self.assertIn(self._INTENT, joined)

    def test_the_right_clarifying_question_IS_a_complete_turn(self):
        # The failing real run: the reply asked what look the theme should
        # have instead of guessing. That is the turn done WELL, not undone.
        joined = " ".join(parse(self._INTENT, mode="converse").acceptance_criteria)
        self.assertIn("IS a complete turn", joined)
        self.assertIn("clarifying question", joined)

    def test_the_reply_is_held_to_honesty_about_what_it_did_not_do(self):
        joined = " ".join(parse(self._INTENT, mode="converse").acceptance_criteria)
        self.assertIn("honest", joined)
        self.assertIn("no file", joined)

    def test_tier1_is_named_not_applicable_rather_than_left_to_read_as_failure(self):
        c = parse(self._INTENT, mode="converse")
        self.assertTrue(
            any("not applicable" in x for x in c.acceptance_criteria),
            "a chat turn's skipped tier-1 must be stated as inapplicable",
        )

    def test_converse_gets_converse_criteria_not_the_read_pair(self):
        # The read branch has its own honest shape ("evidence actually
        # gathered"); a chat turn must not borrow it.
        joined = " ".join(parse(self._INTENT, mode="converse").acceptance_criteria)
        self.assertNotIn("evidence actually gathered", joined)

    def test_converse_is_only_ever_explicit_never_inferred(self):
        # `_infer_mode` stays a read/write question: nothing about an intent's
        # wording — not even the word "converse" — may route a run into chat
        # grading. The only way in is the caller saying so.
        c = parse("converse with me about the roadmap")
        self.assertNotEqual(c.mode, "converse")

    def test_an_explicit_criteria_list_is_still_never_overridden(self):
        mine = ["tier2: it charms"]
        c = parse(self._INTENT, mode="converse", acceptance_criteria=mine)
        self.assertEqual(c.acceptance_criteria, mine)


if __name__ == "__main__":
    unittest.main()
