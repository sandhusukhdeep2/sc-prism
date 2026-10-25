"""A subscription CLI that is out of budget must name the fix: switch model.

Sukhdeep, 2026-08-31: "claude fable is out of budget, but Claude opus is
working, I changed it — can you check it next time and show user you wanna
switch and then switch."

Today a plan limit surfaces as `claude exited 1: <whatever the CLI printed>`,
which tells the user nothing they can act on. A plan limit is not an outage:
the SAME subscription usually has another model with budget left, and the user
can be back to work in one click. This is the same discipline as the sign-in
hint — classify from the output we already captured, and say what to do.

The hint must NEVER fire on an ordinary failure (a crash, a bad flag), because
telling someone to switch models when the real fault is elsewhere sends them
down the wrong path.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.gateway import cli_plan_limit_hint


class TestPlanLimitDetection(unittest.TestCase):
    def test_the_usage_limit_phrasings_are_recognised(self):
        for out in (
            "Claude usage limit reached. Your limit will reset at 3pm.",
            "You've reached your usage limit for Claude Fable 5.",
            "Plan limit reached for this model.",
            "insufficient quota for this model",
            "You have exceeded your current quota",
        ):
            self.assertTrue(cli_plan_limit_hint("claude", out), f"missed: {out!r}")

    def test_the_hint_names_the_model_to_switch_to(self):
        hint = cli_plan_limit_hint("claude", "Claude usage limit reached.")
        self.assertIn("out of budget", hint)
        # It must point at the concrete escape route, in Settings, by name.
        self.assertIn("another model", hint)
        self.assertIn("Settings", hint)

    def test_an_ordinary_failure_is_not_reclassified(self):
        for out in (
            "error: unknown option '--frobnicate'",
            "TypeError: cannot read property 'x' of undefined",
            "",
        ):
            self.assertEqual(cli_plan_limit_hint("claude", out), "")

    def test_a_model_answering_about_quotas_does_not_trip_it(self):
        out = "Your API has a quota system; here is how to raise the limit in code:"
        self.assertEqual(cli_plan_limit_hint("claude", out), "")


if __name__ == "__main__":
    unittest.main()
