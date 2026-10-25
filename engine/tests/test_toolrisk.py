"""Tool RISK classification — and its enforcement at the approval gate.

The user's complaint was measured, not vague: 32 held calls across his wakes,
every one of them a READ (web_fetch 8x, vault_read 8x, web_search 6x,
project_status 6x, read_file 2x, vault_list 2x). With `{"require":["all"]}`
each new tool NAME cost a separate prompt, and an unattended wake that met one
stalled until the blocking timeout. His decision: let it work, hold only risky
tools.

These tests assert the classification WHERE IT IS ENFORCED — through
`ApprovalGate.call_tool`, with a spy inner source that records every call, so
"unheld" means the tool REALLY RAN and "held" means the inner source was NEVER
touched. A table-only test would prove nothing about what the engine does.
"""

import unittest

import _bootstrap  # noqa: F401

from scprism_engine.approval import ApprovalGate, ToolApprovalPolicy, load_approval_policy
from scprism_engine.mcp import MCPTool
from scprism_engine.toolrisk import (
    ACTING,
    FIRST_PARTY_READ_ONLY,
    READ_ONLY,
    READ_ONLY_GRANT,
    classify,
    is_read_only,
    provider_of,
)


class Source:
    """A duck-typed tool source that RECORDS what actually reached it.

    `provider` mirrors what the real source classes stamp on their spans
    (VaultToolProvider -> "vault", WebToolProvider -> "web", MCPClient -> none,
    so the gate tags it "mcp"). `calls` is the proof of egress: a held call must
    leave it empty."""

    def __init__(self, provider=None, server_name="srv", tools=()):
        self.calls = []
        self.server_name = server_name
        self.parent_span_id = None
        self.telemetry = None
        self._tools = list(tools)
        if provider is not None:
            self.provider = provider

    def list_tools(self):
        return [MCPTool(name=t, description="", input_schema={}) for t in self._tools]

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "ran:%s" % name}]}


def _held(result):
    return bool(result.get("held")) and bool(result.get("isError"))


# ---------------------------------------------------------------------------
# The classification itself
# ---------------------------------------------------------------------------


class TestClassification(unittest.TestCase):
    def test_first_party_reads_are_read_only(self):
        for tool in ("vault_read", "vault_list", "vault_search", "project_status"):
            self.assertEqual(classify("vault", tool), READ_ONLY, tool)
        for tool in ("web_fetch", "web_search"):
            self.assertEqual(classify("web", tool), READ_ONLY, tool)

    def test_every_tool_he_was_prompted_for_is_covered(self):
        """His six held read tools, by name — the measurement this fixes.

        `read_file` is an MCP filesystem tool, not one of ours: we cannot read
        that server's source, so it stays ACTING even though its name says
        "read". That is the honest answer, and it is the one enforced."""
        ours = [("vault", "vault_read"), ("vault", "vault_list"),
                ("vault", "project_status"), ("web", "web_fetch"),
                ("web", "web_search")]
        for provider, tool in ours:
            self.assertTrue(is_read_only(provider, tool), tool)
        self.assertEqual(classify("mcp", "read_file"), ACTING)

    def test_unknown_mcp_tool_defaults_to_acting(self):
        """A name is not evidence. Every shape of unknown is held."""
        for tool in (
            "notion.create_page",   # obviously a write
            "notion.search",        # sounds like a read — we cannot verify it
            "send_email",
            "write_file",
            "vault_read",           # OUR name, THEIR server: still acting
            "web_fetch",
        ):
            self.assertEqual(classify("mcp", tool), ACTING, tool)

    def test_unknown_provider_and_junk_inputs_are_acting(self):
        for provider, tool in (
            (None, "vault_read"),
            ("", "vault_read"),
            ("Vault", "vault_read"),      # case matters; no fuzzy matching
            ("vault", None),
            ("vault", 7),
            (7, "vault_read"),
            ("some-plugin", "vault_read"),
        ):
            self.assertEqual(classify(provider, tool), ACTING, repr((provider, tool)))

    def test_a_new_tool_on_a_first_party_source_is_acting_until_listed(self):
        """The allowlist is the point: being 'ours' is not enough."""
        self.assertEqual(classify("vault", "vault_write"), ACTING)
        self.assertEqual(classify("vault", "vault_delete"), ACTING)
        self.assertEqual(classify("web", "web_post"), ACTING)

    def test_the_allowlist_never_carries_a_mutating_name(self):
        """A guard on the table itself: no write/delete/send verb may creep in."""
        banned = ("write", "delete", "remove", "send", "create", "update",
                  "put", "post", "patch", "exec", "run", "pay", "buy")
        for provider, tools in FIRST_PARTY_READ_ONLY.items():
            for tool in tools:
                for verb in banned:
                    self.assertNotIn(verb, tool, "%s/%s" % (provider, tool))

    def test_provider_of_defaults_conservatively(self):
        self.assertEqual(provider_of(Source(provider="vault")), "vault")
        self.assertEqual(provider_of(Source()), "mcp")          # MCPClient shape
        self.assertEqual(provider_of(object()), "mcp")          # unroutable
        self.assertEqual(provider_of(object(), Source(provider="web")), "web")


# ---------------------------------------------------------------------------
# ENFORCEMENT — the same claims, through ApprovalGate.call_tool
# ---------------------------------------------------------------------------


class TestEnforcementAtTheGate(unittest.TestCase):
    """`require: ["all"]` + the read-only class grant — his migrated policy."""

    def policy(self, granted=(READ_ONLY_GRANT,)):
        return ToolApprovalPolicy(require=["all"], granted=list(granted))

    def test_read_only_tool_runs_unheld_and_really_reaches_the_source(self):
        vault = Source(provider="vault", server_name="vault", tools=["vault_read"])
        gate = ApprovalGate(vault, self.policy())
        result = gate.call_tool("vault_read", {"path": "notes/x.md"})
        self.assertFalse(_held(result))
        self.assertEqual(vault.calls, [("vault_read", {"path": "notes/x.md"})])

    def test_web_reads_run_unheld(self):
        web = Source(provider="web", server_name="web", tools=["web_fetch", "web_search"])
        gate = ApprovalGate(web, self.policy())
        for tool, args in (("web_fetch", {"url": "https://x"}), ("web_search", {"query": "q"})):
            self.assertFalse(_held(gate.call_tool(tool, args)))
        self.assertEqual([c[0] for c in web.calls], ["web_fetch", "web_search"])

    def test_acting_tool_is_still_held_and_never_reaches_the_source(self):
        mcp = Source(server_name="fs", tools=["write_file"])
        gate = ApprovalGate(mcp, self.policy())
        result = gate.call_tool("write_file", {"path": "/tmp/x", "text": "hi"})
        self.assertTrue(_held(result))
        self.assertEqual(mcp.calls, [])   # nothing egressed

    def test_unknown_mcp_tool_is_held_even_when_its_name_reads_harmless(self):
        mcp = Source(server_name="notion", tools=["notion.search", "notion.create_page"])
        gate = ApprovalGate(mcp, self.policy())
        for tool in ("notion.search", "notion.create_page"):
            self.assertTrue(_held(gate.call_tool(tool, {})), tool)
        self.assertEqual(mcp.calls, [])

    def test_an_mcp_server_cannot_impersonate_the_vault_by_name(self):
        """The classification keys on the PROVIDER, not the user-chosen server
        name — otherwise naming your MCP server `vault` would buy a free pass."""
        impostor = Source(server_name="vault", tools=["vault_read"])   # provider -> "mcp"
        gate = ApprovalGate(impostor, self.policy())
        self.assertTrue(_held(gate.call_tool("vault_read", {"path": "x"})))
        self.assertEqual(impostor.calls, [])

    def test_composite_routing_frees_only_the_first_party_half(self):
        """The real shape of a run: vault + web + MCP fanned into one source."""
        from scprism_engine.webtools import CompositeToolClient

        vault = Source(provider="vault", server_name="vault", tools=["vault_read"])
        mcp = Source(server_name="fs", tools=["write_file"])
        composite = CompositeToolClient([vault, mcp])
        gate = ApprovalGate(composite, self.policy())
        self.assertFalse(_held(gate.call_tool("vault_read", {"path": "a"})))
        self.assertTrue(_held(gate.call_tool("write_file", {"path": "b"})))
        self.assertEqual([c[0] for c in vault.calls], ["vault_read"])
        self.assertEqual(mcp.calls, [])

    def test_without_the_sentinel_nothing_changes(self):
        """The old shape is byte-identical: reads are held again."""
        vault = Source(provider="vault", server_name="vault", tools=["vault_read"])
        gate = ApprovalGate(vault, ToolApprovalPolicy(require=["all"], granted=[]))
        self.assertTrue(_held(gate.call_tool("vault_read", {"path": "a"})))
        self.assertEqual(vault.calls, [])

    def test_tightening_back_to_hold_everything_really_holds_the_reads(self):
        """Removing the sentinel is the whole revert — and it bites at the gate."""
        vault = Source(provider="vault", server_name="vault", tools=["vault_read"])
        free = ToolApprovalPolicy(require=["all"], granted=[READ_ONLY_GRANT, "echo"])
        self.assertFalse(_held(ApprovalGate(vault, free).call_tool("vault_read", {})))
        tightened = ToolApprovalPolicy(
            require=["all"],
            granted=[n for n in [READ_ONLY_GRANT, "echo"] if n != READ_ONLY_GRANT],
        )
        vault.calls.clear()
        self.assertTrue(_held(ApprovalGate(vault, tightened).call_tool("vault_read", {})))
        self.assertEqual(vault.calls, [])

    def test_require_side_class_mark_OVERRIDES_the_grant(self):
        """`require: ["read-only"]` reads as "require approval for reads too".

        It is how the app records a user who deliberately chose hold-everything,
        and it must WIN over a grant left behind in the same file — otherwise
        tightening up could lose to a stale line and the page would promise a
        hold the gate does not perform."""
        vault = Source(provider="vault", server_name="vault", tools=["vault_read"])
        policy = ToolApprovalPolicy(
            require=["all", READ_ONLY_GRANT], granted=[READ_ONLY_GRANT]
        )
        self.assertFalse(policy.reads_run_free())
        gate = ApprovalGate(vault, policy)
        self.assertTrue(_held(gate.call_tool("vault_read", {})))
        self.assertEqual(vault.calls, [])

    def test_the_sentinel_is_not_a_wildcard(self):
        """`read-only` frees a CLASS, never everything — unlike `all`."""
        policy = self.policy()
        self.assertEqual(policy.decide("fs", "write_file", provider="mcp"), "hold")
        self.assertEqual(policy.decide("vault", "vault_read", provider="vault"), "allow")
        self.assertTrue(policy.reads_run_free())
        self.assertFalse(ToolApprovalPolicy(require=["all"]).reads_run_free())

    def test_a_caller_that_forgets_the_provider_fails_SAFE(self):
        """No provider -> ACTING -> held. Never the other way round."""
        policy = self.policy()
        self.assertEqual(policy.decide("vault", "vault_read"), "hold")

    def test_an_explicitly_granted_name_still_wins_as_before(self):
        """The pre-existing per-name grants keep working, untouched."""
        mcp = Source(server_name="echo", tools=["add"])
        gate = ApprovalGate(mcp, ToolApprovalPolicy(require=["all"], granted=["add"]))
        self.assertFalse(_held(gate.call_tool("add", {"a": 1})))
        self.assertEqual([c[0] for c in mcp.calls], ["add"])

    def test_an_inactive_policy_is_unaffected_by_the_sentinel(self):
        mcp = Source(server_name="fs", tools=["write_file"])
        gate = ApprovalGate(mcp, ToolApprovalPolicy(require=[], granted=[READ_ONLY_GRANT]))
        self.assertFalse(_held(gate.call_tool("write_file", {})))


class TestPolicyFileCarriesTheSentinel(unittest.TestCase):
    """His real file shape, loaded the way a run loads it."""

    def test_load_approval_policy_reads_the_sentinel_from_granted(self):
        import json
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as vault:
            path = os.path.join(vault, "mcp-approvals.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "require": ["all"],
                        "granted": [
                            "web_search", "web_fetch", "read_file", "project_status",
                            "vault_read", "vault_list", "vault", READ_ONLY_GRANT,
                        ],
                    },
                    fh,
                )
            policy = load_approval_policy(vault)
        self.assertTrue(policy.reads_run_free())
        self.assertEqual(policy.decide("web", "web_fetch", provider="web"), "allow")
        self.assertEqual(policy.decide("notion", "create_page", provider="mcp"), "hold")


if __name__ == "__main__":
    unittest.main()
