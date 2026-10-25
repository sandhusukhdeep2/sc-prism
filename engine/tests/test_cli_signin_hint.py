"""A CLI that is not signed in must say so, not "did not answer within 180s".

Found live 2026-08-31 while answering "is it working with Gemini or not". The
gemini bridge reported:

    [offline:gemini-cli:gemini-cli-account] the gemini CLI did not answer
    within 180s

which reads like a slow model or a broken network. The real cause, visible in
the partial stdout the bounded runner had already captured:

    Opening authentication page in your browser. Do you want to continue? [Y/n]:

The CLI is not signed in. It blocks on an interactive consent prompt that a
non-interactive bridge can never answer — and it ignores stdin=DEVNULL, so it
waits for a human until we kill it. Nothing here is fixable by retrying or by
raising the timeout; the user must sign in ONCE in their own terminal.

The timeout message stays for a genuine timeout — this only reclassifies the
case where the captured output proves the CLI was waiting on a human.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.gateway import GatewayError, cli_signin_hint
from scprism_engine.gateway import _offline_cause


class TestSigninDetection(unittest.TestCase):
    def test_the_real_gemini_prompt_is_recognised(self):
        out = "\nOpening authentication page in your browser. Do you want to continue? [Y/n]: "
        hint = cli_signin_hint("gemini", out)
        self.assertIn("not signed in", hint)
        # The message must carry the FIX, in the words of the thing to run.
        self.assertIn("gemini", hint)

    def test_other_common_signin_phrasings(self):
        for out in (
            "Please run `claude login` to authenticate",
            "You are not logged in. Run: codex login",
            "Authentication required — sign in to continue",
            "OAuth consent needed; press Y to open the browser",
        ):
            self.assertTrue(cli_signin_hint("claude", out), f"missed: {out!r}")

    def test_a_genuine_slow_answer_is_not_reclassified(self):
        self.assertEqual(cli_signin_hint("gemini", "Thinking about your question…"), "")
        self.assertEqual(cli_signin_hint("gemini", ""), "")

    def test_the_word_login_inside_a_normal_answer_does_not_trip_it(self):
        # A model ANSWERING a question about login code must not be mistaken
        # for a CLI asking us to log in.
        out = "Here is the login form component you asked for:\n\nfunction Login() {"
        self.assertEqual(cli_signin_hint("claude", out), "")



class TestOurOwnErrorsReadAsProse(unittest.TestCase):
    """A GatewayError message is already written FOR the user; stamping the
    class name on the front ("GatewayError: the gemini CLI is not signed in…")
    turns advice into a stack-trace fragment. Foreign exceptions keep the name,
    which is the only clue they carry."""

    def test_our_own_error_is_shown_verbatim(self):
        msg = "the gemini CLI is not signed in — run `gemini` once in your Terminal."
        self.assertEqual(_offline_cause(GatewayError(msg)), msg)

    def test_a_foreign_exception_still_names_its_type(self):
        self.assertIn("KeyError", _offline_cause(KeyError("boom")))


if __name__ == "__main__":
    unittest.main()
