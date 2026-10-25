import unittest

import _bootstrap  # noqa: F401  (sets up sys.path)

from scprism_engine.contract import parse, ContractError
from scprism_engine.planner import plan, route, Step, LOCAL, CLOUD, WRITE, READ


class TestPlannerRouting(unittest.TestCase):
    def test_sensitive_keyword_forces_local(self):
        step = Step(index=0, description="Rotate the customer password store")
        route(step)
        self.assertEqual(step.route, LOCAL)
        self.assertIn("sensitive", step.reason)

    def test_auth_keyword_forces_local_even_when_heavy(self):
        # Contains both a heavy word (refactor) and a sensitive word (auth).
        step = Step(index=0, description="Refactor the auth token exchange")
        route(step)
        self.assertEqual(step.route, LOCAL, "sensitivity must win over load")

    def test_heavy_keyword_routes_cloud(self):
        step = Step(index=0, description="Design a distributed rate limiter")
        route(step)
        self.assertEqual(step.route, CLOUD)

    def test_default_routes_local(self):
        step = Step(index=0, description="Add a small helper function")
        route(step)
        self.assertEqual(step.route, LOCAL)

    def test_plan_of_sensitive_intent_is_all_local(self):
        contract = parse("add password hashing for customer login")
        steps = plan(contract)
        self.assertTrue(steps)
        for s in steps:
            self.assertEqual(
                s.route, LOCAL, f"step {s.index} leaked to cloud: {s.description}"
            )

    def test_write_contract_emits_a_write_step(self):
        contract = parse("add a rate-limit guard")
        steps = plan(contract)
        self.assertTrue(any(s.kind == WRITE for s in steps))

    def test_read_contract_emits_no_write_step(self):
        contract = parse("analyze the request pipeline")
        self.assertEqual(contract.mode, "read")
        steps = plan(contract)
        self.assertFalse(any(s.kind == WRITE for s in steps))


if __name__ == "__main__":
    unittest.main()


class TestSingleStepPlan(unittest.TestCase):
    """A ONE-STEP task, for work that is one small piece rather than a change
    to a codebase.

    The default plan is understand -> locate -> produce, and each step runs its
    OWN tool loop with its own turn budget — so a task needing two notes reads
    them three times over. Measured on the companion wake: 15m24s and 69,976
    tokens to return "I ran out of tool turns", every hour, having never once
    completed. The same wake with steps=1 finished its research in 4m29s on
    8,993 tokens.
    """

    def test_one_step_read_plan_is_a_single_findings_step(self):
        c = parse("check in on the business", mode="read", steps=1)
        steps = plan(c)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0].index, 0)
        self.assertEqual(steps[0].kind, READ)
        self.assertIn("check in on the business", steps[0].description)

    def test_one_step_write_plan_is_a_single_implement_step(self):
        c = parse("add a rate limit guard to the uploader", mode="write", steps=1)
        steps = plan(c)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0].kind, WRITE)

    def test_absent_steps_keeps_the_default_plan_byte_identical(self):
        # The flag is omit-means-default: an unused steps field must not change
        # a single existing plan.
        for mode in ("read", "write"):
            intent = "add a guard" if mode == "write" else "review the vault"
            self.assertEqual(
                [s.description for s in plan(parse(intent, mode=mode))],
                [s.description for s in plan(parse(intent, mode=mode, steps=None))],
            )

    def test_steps_must_be_positive_when_given(self):
        with self.assertRaises(ContractError):
            parse("anything", mode="read", steps=0).validate()


class TestConversePlan(unittest.TestCase):
    """A conversational turn is one reply, never a code-task pipeline.

    The default understand -> locate -> produce shape exists for changing a
    codebase. Run over a chat message it does the same research three times
    and hands the judge a trajectory that looks like an aborted build. A
    converse contract therefore always plans the single-step shape — the same
    one steps=1 buys — whatever the caller set steps to.
    """

    _INTENT = "Create a wordpress theme like moppers slashcreative"

    def test_a_converse_contract_plans_exactly_one_step(self):
        steps = plan(parse(self._INTENT, mode="converse"))
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0].index, 0)

    def test_the_one_step_is_a_reply_not_findings_or_an_implementation(self):
        steps = plan(parse(self._INTENT, mode="converse"))
        self.assertEqual(steps[0].kind, READ)
        self.assertIn("Reply", steps[0].description)
        self.assertIn(self._INTENT, steps[0].description)

    def test_mutating_wording_cannot_smuggle_a_write_step_into_a_chat(self):
        # "Create ..." trips `_looks_like_write`; the mode outranks the verb.
        steps = plan(parse(self._INTENT, mode="converse"))
        self.assertFalse(any(s.kind == WRITE for s in steps))

    def test_converse_wins_even_over_an_explicit_steps_count(self):
        steps = plan(parse(self._INTENT, mode="converse", steps=4))
        self.assertEqual(len(steps), 1)
