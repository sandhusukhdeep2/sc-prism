"""The sensitivity gate matches WORDS, not substrings (2026-08-17).

Found by real use. `SENSITIVE_KEYWORDS` was matched with plain `in`
containment, so any string carrying one as a SUBSTRING was forced local — and,
at the web-tool gate, killed before egress. The research query "mlx multi token
prediction" contains "token", so it never ran; because a blocked call correctly
records no destination, the user was told nothing at all. A legitimate search
simply vanished.

These tests hold BOTH edges of the new rule:
  * the false positives are released — the query runs, the words route normally;
  * nothing real is released — a credential in any of its ordinary shapes
    (prose, snake_case, a URL query parameter, a JSON argument, a plural) still
    trips, and an ambiguous word in genuinely sensitive company still trips;
  * ONE rule everywhere — `route()`, `guard_cloud_tool_result`, the MCP arg gate,
    the web-tool arg gate and `planner.route` agree on every case, so what keeps
    a run local and what withholds a tool result can never diverge.
"""

import json
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import mcp as mcp_module
from scprism_engine import webtools as webtools_module
from scprism_engine.gateway import (
    LOCAL,
    Gateway,
    guard_cloud_tool_result,
    sensitive_hit,
)
from scprism_engine.planner import Step, route as plan_route

# The false positives this fix releases. Each is real work a user asked for.
RELEASED = [
    "mlx multi token prediction",   # "token" — the query that vanished
    "production values",            # "prod" / "production"
    "authentic",                    # "auth"
    "prodigy",                      # "prod"
    "customer-facing copy",         # "customer"
    "write the customer-facing landing page",
    "tokenizer benchmark",          # "token"
    "reproduce the crash",          # "prod"
    "authorise the budget",         # not "authorization" as a word
]

# Deliberately NOT released. These stayed sensitive as bare words: word
# boundaries alone were enough to fix them (no ordinary English word contains
# them by accident), so there was no reason to weaken them further.
STILL_STRONG_AS_BARE_WORDS = [
    "the login flow",
    "the authentication flow",
    "the authorization header",
    "keep this secret",
    "hash the credential",
]

# What must still trip, in the shapes a secret really takes.
STILL_CAUGHT = [
    "the prod database password",
    "api-key",
    "apikey",
    "api_key",
    "api key",
    "private-key",
    "privatekey",
    "private key",
    "rotate the customer password store",
    "refactor the auth token exchange",     # ambiguous pair
    "export the customer data",             # ambiguous + qualifier
    "restore the production database",      # ambiguous + qualifier
    "config aws_password=hunter2trapdoor",  # underscore is a word edge
    "PASSWORD",                             # case-insensitive
    "rotate all api-keys",                  # plural
    "the stored credentials",               # plural
    "https://example.com/page?token=abc123",  # assigned a value
    "his ssn is on file",
    "strip pii before export",
]


class TheReleasedFalsePositives(unittest.TestCase):
    def test_they_no_longer_match(self):
        for text in RELEASED:
            self.assertIsNone(sensitive_hit(text), f"still tripping: {text!r}")

    def test_the_query_that_vanished_now_routes_normally(self):
        gw = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        d = gw.route("mlx multi token prediction")
        self.assertNotIn("sensitive", d.reason)
        self.assertEqual(d.provider, "claude-cli")

    def test_the_query_that_vanished_now_reaches_the_web_tool_gate(self):
        prov = webtools_module.WebToolProvider.__new__(
            webtools_module.WebToolProvider
        )
        prov.allowed_tools = None
        self.assertIsNone(
            prov._blocked_reason("web_search", {"query": "mlx multi token prediction"})
        )


class TheProtectionIsIntact(unittest.TestCase):
    def test_they_all_still_match(self):
        for text in STILL_CAUGHT:
            self.assertIsNotNone(sensitive_hit(text), f"no longer caught: {text!r}")

    def test_a_sensitive_intent_still_forces_local(self):
        gw = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        d = gw.route("the prod database password")
        self.assertEqual(d.target, LOCAL)
        self.assertIn("password", d.matched)

    def test_the_unambiguous_words_were_not_weakened(self):
        for text in STILL_STRONG_AS_BARE_WORDS:
            self.assertIsNotNone(sensitive_hit(text), f"weakened: {text!r}")

    def test_a_json_argument_named_for_a_credential_is_blocked(self):
        """The arg gates scan `json.dumps(arguments)`, so a KEY named for a
        credential reads as an assignment and trips — "multi token prediction"
        as a VALUE does not."""
        client = mcp_module.MCPClient.__new__(mcp_module.MCPClient)
        client.allowed_tools = None
        self.assertIsNotNone(client._blocked_reason("echo", {"token": "abc123"}))
        self.assertIsNone(
            client._blocked_reason("echo", {"query": "mlx multi token prediction"})
        )

    def test_a_secret_bearing_url_is_still_blocked_at_the_web_gate(self):
        prov = webtools_module.WebToolProvider.__new__(
            webtools_module.WebToolProvider
        )
        prov.allowed_tools = None
        reason = prov._blocked_reason(
            "web_fetch", {"url": "https://example.com/p?token=abc123"}
        )
        self.assertIsNotNone(reason)
        self.assertIn("sensitive", reason)


class TheUsersOwnWordsAreMatchedAsWords(unittest.TestCase):
    def test_a_user_word_matches_as_a_word_and_not_as_a_substring(self):
        gw = Gateway(env={"SCPRISM_PRIMARY": "claude-cli", "SCPRISM_SENSITIVE": "Acme"})
        # As a word: kept local, and the reason names the word.
        d = gw.route("email Acme the invoice")
        self.assertEqual(d.target, LOCAL)
        self.assertIn("acme", d.reason)
        # Inside another word: NOT a match — this is the substring bug.
        self.assertIsNone(sensitive_hit("acmeville harbour authority", ("acme",)))
        self.assertEqual(gw.route("acmeville harbour authority").provider, "claude-cli")

    def test_a_multi_word_user_entry_still_matches(self):
        gw = Gateway(
            env={"SCPRISM_PRIMARY": "claude-cli", "SCPRISM_SENSITIVE": "payroll audit"}
        )
        d = gw.route("summarize the payroll audit findings")
        self.assertEqual(d.target, LOCAL)
        self.assertIn("payroll audit", d.reason)

    def test_a_user_word_reaches_the_tool_result_guard_too(self):
        gw = Gateway(env={"SCPRISM_SENSITIVE": "hollowmere"})
        _safe, withheld = gw.guard_tool_result("the Hollowmere merger closes Friday")
        self.assertTrue(withheld)
        # ...and does not withhold a result that merely contains it as a substring.
        text = "hollowmereish is not a word anyone uses"
        self.assertEqual(gw.guard_tool_result(text), (text, False))


class OneRuleEverywhere(unittest.TestCase):
    """`route()` and `guard_cloud_tool_result` (and the two arg gates, and the
    planner) must agree on every case — one rule, five call sites."""

    def _gw(self):
        return Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})

    def test_route_and_the_result_guard_agree(self):
        for text in RELEASED:
            gw = self._gw()
            self.assertNotIn("sensitive", gw.route(text).reason, text)
            self.assertEqual(guard_cloud_tool_result(text), (text, False), text)
        for text in STILL_CAUGHT:
            gw = self._gw()
            self.assertEqual(gw.route(text).target, LOCAL, text)
            _safe, withheld = guard_cloud_tool_result(text)
            self.assertTrue(withheld, text)

    def test_the_mcp_and_web_arg_gates_agree(self):
        client = mcp_module.MCPClient.__new__(mcp_module.MCPClient)
        client.allowed_tools = None
        web = webtools_module.WebToolProvider.__new__(webtools_module.WebToolProvider)
        web.allowed_tools = None
        for text in RELEASED:
            self.assertIsNone(client._blocked_reason("echo", {"text": text}), text)
            self.assertIsNone(web._blocked_reason("web_search", {"query": text}), text)
        for text in STILL_CAUGHT:
            self.assertIsNotNone(client._blocked_reason("echo", {"text": text}), text)
            self.assertIsNotNone(web._blocked_reason("web_search", {"query": text}), text)

    def test_the_planner_agrees(self):
        for text in RELEASED:
            step = plan_route(Step(index=0, description=text))
            self.assertNotIn("sensitive", step.reason, text)
        for text in STILL_CAUGHT:
            step = plan_route(Step(index=0, description=text))
            self.assertEqual(step.route, LOCAL, text)
            self.assertIn("sensitive", step.reason, text)

    def test_json_wrapping_does_not_change_the_verdict(self):
        """The arg gates scan a JSON dump; that wrapping must not itself create
        or destroy a hit."""
        for text in RELEASED + STILL_CAUGHT:
            bare = sensitive_hit(text) is not None
            wrapped = sensitive_hit(json.dumps({"query": text})) is not None
            self.assertEqual(bare, wrapped, text)


if __name__ == "__main__":
    unittest.main()
