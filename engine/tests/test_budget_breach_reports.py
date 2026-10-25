"""A run that hits its token budget must still report what it got done.

Found live 2026-09-03 by running a real three-agent board. The researcher (on
Claude) did genuine web research and reported honestly that two sources blocked
the fetch; the analyst (on a local model) ran ten tool turns. Between them they
spent 110,873 tokens against a 100,000 default. The result the user saw:

    passed: False, over_budget: True, synthesis: ""

Three agents worked, real findings existed on the board, and the manager
reported NOTHING. The board is right there in memory — refusing to summarise it
is the one outcome that wastes everything already spent.

`run_team` gated the lead synthesis behind `not over_budget` (team.py:564),
while the sibling `run_role_board` carries a comment promising the opposite:
"ALWAYS run so a completion is returned even after a budget breach". Both
cannot be true.

The fix is NOT to run the model anyway — the budget was breached precisely to
stop spending. It is to assemble the synthesis DETERMINISTICALLY from the board
at zero token cost, and label it for exactly what it is.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.team import budget_synthesis


BOARD = [
    {
        "from": "researcher",
        "provider": "claude-cli",
        "model": "claude-code-subscription",
        "content": "Couldn't confirm a live price — ThemeForest returned 403 and the "
        "vendor page hit a bot wall. Known: Moppers is sold via ThemeForest item 23754555.",
    },
    {
        "from": "analyst",
        "provider": "local",
        "model": "qwen",
        "content": "[incomplete: I reached this run's token budget after 10 tool turns.]",
    },
]


class TestBudgetSynthesis(unittest.TestCase):
    def test_it_is_never_empty_when_the_board_has_work(self):
        out = budget_synthesis(BOARD, spent=110873, budget=100000)
        self.assertTrue(out.strip(), "a breached run reported nothing at all")

    def test_it_says_plainly_that_the_run_stopped_early(self):
        out = budget_synthesis(BOARD, spent=110873, budget=100000).lower()
        self.assertIn("budget", out)
        # The numbers must be there — "it stopped" without "at what" is useless.
        self.assertIn("110,873", budget_synthesis(BOARD, spent=110873, budget=100000))
        self.assertIn("100,000", budget_synthesis(BOARD, spent=110873, budget=100000))

    def test_it_carries_each_agent_s_actual_contribution(self):
        out = budget_synthesis(BOARD, spent=1, budget=1)
        self.assertIn("researcher", out)
        self.assertIn("analyst", out)
        self.assertIn("ThemeForest", out)
        self.assertIn("403", out)

    def test_it_attributes_each_contribution_to_its_ai(self):
        """Which brand did which work is the product's whole claim."""
        out = budget_synthesis(BOARD, spent=1, budget=1)
        self.assertIn("claude-cli", out)
        self.assertIn("local", out)

    def test_it_never_claims_to_be_a_finished_answer(self):
        out = budget_synthesis(BOARD, spent=1, budget=1).lower()
        self.assertNotIn("final answer", out)
        self.assertTrue(
            "not a finished" in out or "stopped" in out or "incomplete" in out,
            "the label must mark this as partial work, not a conclusion",
        )

    def test_it_tells_the_user_what_to_do_about_it(self):
        """A limit with no remedy is a dead end."""
        out = budget_synthesis(BOARD, spent=110873, budget=100000).lower()
        self.assertIn("budget", out)
        self.assertTrue("raise" in out or "increase" in out or "settings" in out)

    def test_an_empty_board_says_so_rather_than_faking_a_summary(self):
        out = budget_synthesis([], spent=100001, budget=100000)
        self.assertTrue(out.strip())
        self.assertIn("no agent", out.lower())

    def test_it_costs_no_tokens(self):
        """Deterministic assembly. The budget was breached to STOP spending —
        calling a model to explain that would be absurd."""
        import inspect

        from scprism_engine import team

        src = inspect.getsource(team.budget_synthesis)
        for forbidden in ("model_call", "gateway", "Gateway", "_call("):
            self.assertNotIn(forbidden, src, f"budget_synthesis must not call a model ({forbidden})")


if __name__ == "__main__":
    unittest.main()
