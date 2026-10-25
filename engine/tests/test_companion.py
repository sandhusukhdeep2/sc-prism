"""Companion charter tests — the co-founder always gets its instructions."""

import unittest

from scprism_engine.companion import COMPANION_SYSTEM, companion_messages


class CompanionMessageTests(unittest.TestCase):
    def test_system_charter_always_present(self):
        msgs = companion_messages("plan the sprint", env={})
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("co-founder", msgs[0]["content"])
        self.assertIn("You draft, the user confirms", msgs[0]["content"])
        self.assertEqual(msgs[1], {"role": "user", "content": "plan the sprint"})

    def test_interview_context_appended(self):
        env = {"SCPRISM_CONTEXT": "Business: bakery\nNever touch: prod DB"}
        msgs = companion_messages("hi", env=env)
        self.assertIn("Workspace context", msgs[0]["content"])
        self.assertIn("Business: bakery", msgs[0]["content"])
        # Charter still leads.
        self.assertTrue(msgs[0]["content"].startswith(COMPANION_SYSTEM[:40]))

    def test_blank_context_ignored(self):
        msgs = companion_messages("hi", env={"SCPRISM_CONTEXT": "   "})
        self.assertNotIn("Workspace context", msgs[0]["content"])


if __name__ == "__main__":
    unittest.main()
