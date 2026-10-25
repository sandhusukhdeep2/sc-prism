"""The claude CLI bridge must send our system prompt AS a system prompt.

Found live 2026-08-31, running a real web-research task through the
subscription bridge. The bridge flattened every message into ONE ``-p`` argv
string that began "System instructions: You are the SC Prism Companion…", so
Claude received our own harness prompt as USER text. It did exactly what a
well-aligned model should do with a system prompt pasted into a user turn — it
treated it as an injection attempt and commented on it instead of answering:

    "This message is structured as if it were a system prompt defining a new
     persona ("SC Prism Companion") with its own tool-calling protocol…"

and on a shorter run:

    "I don't see a request in your message yet — just system context."

The run's spans proved the tools themselves were fine (8 real search results,
a 200 on the user's own pricing page) — the ANSWER was destroyed at the last
turn by the framing. `claude` has `--append-system-prompt` for precisely this.
Providers with no such flag keep the flattened prompt; the test pins that too,
so the fix cannot silently drop the system prompt for them.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.gateway import _CLI_PROVIDERS, cli_argv_for


MESSAGES = [
    {"role": "system", "content": "You are the SC Prism Companion. Tools: web_search."},
    {"role": "user", "content": "Find the price of the Moppers theme."},
]


class TestClaudeBridgeSystemPrompt(unittest.TestCase):
    def setUp(self):
        self.argv = cli_argv_for("claude-cli", MESSAGES)

    def test_the_system_prompt_travels_in_its_own_flag(self):
        self.assertIn("--append-system-prompt", self.argv)
        idx = self.argv.index("--append-system-prompt")
        self.assertIn("SC Prism Companion", self.argv[idx + 1])

    def test_the_user_prompt_is_not_a_pasted_system_prompt(self):
        prompt = self.argv[self.argv.index("-p") + 1]
        self.assertNotIn("System instructions:", prompt)
        self.assertNotIn("SC Prism Companion", prompt)

    def test_the_user_prompt_still_carries_the_actual_request(self):
        prompt = self.argv[self.argv.index("-p") + 1]
        self.assertIn("Moppers", prompt)

    def test_the_existing_setting_sources_guard_survives(self):
        self.assertIn("--setting-sources", self.argv)


class TestBridgesWithoutTheFlag(unittest.TestCase):
    """gemini/codex have no system-prompt flag — they keep the flattened prompt,
    and it must still CONTAIN the system text rather than losing it."""

    def test_gemini_keeps_the_system_text_in_the_prompt(self):
        argv = cli_argv_for("gemini-cli", MESSAGES)
        self.assertNotIn("--append-system-prompt", argv)
        blob = " ".join(argv)
        self.assertIn("SC Prism Companion", blob)
        self.assertIn("Moppers", blob)

    def test_every_provider_is_covered_by_one_of_the_two_paths(self):
        for name in _CLI_PROVIDERS:
            argv = cli_argv_for(name, MESSAGES)
            self.assertIn("Moppers", " ".join(argv), f"{name} lost the request")
            self.assertIn(
                "SC Prism Companion", " ".join(argv), f"{name} lost the system prompt"
            )


if __name__ == "__main__":
    unittest.main()
