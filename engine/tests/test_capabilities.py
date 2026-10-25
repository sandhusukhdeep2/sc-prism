"""Per-agent capabilities — the ENFORCEMENT tests (2026-08-15 Sukh design).

The product's cardinal sin is a capability that is shown but not enforced, so
every assertion here is made at the enforcement point (``AgentGrants`` /
``AgentCapabilityGate`` / ``project.apply_file_ops``), never at a UI:

  * a capability the USER does not hold can never be granted to an agent, no
    matter what the manager asked for — and the over-ask is recorded, not
    silently dropped;
  * an agent without ``web`` cannot fetch: the web provider is never touched,
    a ``refused=True`` span lands, and the model sees an honest observation;
  * an agent without ``vault`` cannot read a note;
  * an agent without ``writes`` writes NOTHING to the project directory;
  * a shared tool source enforces DIFFERENT grants for different agents;
  * no grant at all leaves every path byte-identical.
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.capabilities import (
    CAPABILITIES,
    AgentCapabilityGate,
    AgentGrants,
    CapabilityDenied,
    capability_for_provider,
    enforce,
    normalize,
    subset_of_user,
)
from scprism_engine.project import apply_file_ops
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.webtools import CompositeToolClient


class _Tool:
    def __init__(self, name):
        self.name = name
        self.description = name
        self.input_schema = {"type": "object"}


class _FakeSource:
    """A duck-typed tool source that RECORDS whether it was ever touched.

    The point of the gate is that a refused call never reaches here, so
    ``calls`` staying empty is the proof, not a rendered label.
    """

    def __init__(self, provider, tools, telemetry=None):
        self.provider = provider
        self.server_name = provider
        self.telemetry = telemetry
        self.parent_span_id = None
        self._tools = [_Tool(t) for t in tools]
        self.calls = []

    def list_tools(self):
        return list(self._tools)

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "REAL RESULT " + name}]}


# ---------------------------------------------------------------------------
# The no-escalation rule
# ---------------------------------------------------------------------------


class TestNoEscalation(unittest.TestCase):
    def test_a_capability_the_user_lacks_can_never_be_granted(self):
        # The manager asks for everything; the user holds only the vault.
        grants = AgentGrants(user=["vault"], requested={"researcher": list(CAPABILITIES)})
        self.assertEqual(grants.granted("researcher"), frozenset({"vault"}))
        for cap in ("web", "tools", "writes"):
            self.assertFalse(grants.allows("researcher", cap))

    def test_the_over_ask_is_recorded_not_silently_dropped(self):
        grants = AgentGrants(user=["vault"], requested={"researcher": ["vault", "web"]})
        self.assertEqual(
            grants.escalations, [{"agent": "researcher", "capability": "web"}]
        )
        line = grants.escalation_lines()[0]
        self.assertIn("researcher", line)
        self.assertIn("you do not hold it", line)

    def test_the_refusal_names_the_users_own_grant_as_the_reason(self):
        grants = AgentGrants(user=["vault"], requested={"scout": ["web"]})
        reason = grants.refusal("scout", "web")
        self.assertIn("you have not granted", reason)
        # And when the USER has it but this agent was not given it, the reason
        # is the agent's grant — two different facts, two different sentences.
        grants2 = AgentGrants(user=["web"], requested={"scout": []})
        self.assertIn("was not granted", grants2.refusal("scout", "web"))

    def test_an_agent_nobody_staffed_holds_nothing(self):
        grants = AgentGrants(user=list(CAPABILITIES), requested={"lead": ["web"]})
        self.assertEqual(grants.granted("stranger"), frozenset())

    def test_subset_and_normalize_drop_names_the_engine_cannot_enforce(self):
        self.assertEqual(normalize("vault, WEB ,telepathy"), frozenset({"vault", "web"}))
        self.assertEqual(subset_of_user(["vault"], ["vault", "web"]), frozenset({"vault"}))

    def test_enforce_raises_with_the_reason(self):
        grants = AgentGrants(user=["vault"], requested={"scout": ["vault"]})
        enforce(grants, "scout", "vault")  # granted -> no raise
        with self.assertRaises(CapabilityDenied) as caught:
            enforce(grants, "scout", "web")
        self.assertEqual(caught.exception.capability, "web")
        self.assertIn("scout", str(caught.exception))
        # No grant table at all -> the feature is off, nothing is enforced.
        enforce(None, "scout", "web")

    def test_from_cli_reads_a_json_object_and_refuses_rubbish(self):
        grants = AgentGrants.from_cli("vault,web", '{"a": ["web"], "b": ["vault"]}')
        self.assertEqual(grants.granted("a"), frozenset({"web"}))
        self.assertEqual(grants.granted("b"), frozenset({"vault"}))
        # A bare list is the solo agent.
        solo = AgentGrants.from_cli("web", "web")
        self.assertEqual(solo.granted(""), frozenset({"web"}))
        # Nothing declared -> no grant table -> no gate.
        self.assertIsNone(AgentGrants.from_cli(None, None))
        with self.assertRaises(CapabilityDenied):
            AgentGrants.from_cli("web", "{not json")

    def test_provider_tags_map_to_the_capability_they_need(self):
        self.assertEqual(capability_for_provider("vault"), "vault")
        self.assertEqual(capability_for_provider("web"), "web")
        self.assertEqual(capability_for_provider("my-mcp-server"), "tools")


# ---------------------------------------------------------------------------
# The tool gate — refusal BY THE ENGINE
# ---------------------------------------------------------------------------


class TestCapabilityGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.telemetry = Telemetry(os.path.join(self.tmp, "spans.jsonl"))
        self.web = _FakeSource("web", ["web_fetch", "web_search"], self.telemetry)
        self.vault = _FakeSource("vault", ["vault_read", "vault_list"], self.telemetry)
        self.source = CompositeToolClient([self.web, self.vault])

    def test_an_agent_without_web_cannot_fetch(self):
        grants = AgentGrants(user=["vault", "web"], requested={"scribe": ["vault"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scribe")
        result = gate.call_tool("web_fetch", {"url": "https://example.com"})
        # THE PROOF: the web provider was never touched.
        self.assertEqual(self.web.calls, [])
        self.assertTrue(result["isError"])
        self.assertTrue(result["refused"])
        self.assertIn("refused", result["content"][0]["text"])

    def test_an_agent_without_vault_cannot_read_a_note(self):
        grants = AgentGrants(user=["vault", "web"], requested={"scout": ["web"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        gate.call_tool("vault_read", {"path": "notes/private.md"})
        self.assertEqual(self.vault.calls, [])

    def test_a_granted_tool_still_runs_for_real(self):
        grants = AgentGrants(user=["web"], requested={"scout": ["web"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        result = gate.call_tool("web_fetch", {"url": "https://example.com"})
        self.assertEqual(len(self.web.calls), 1)
        self.assertIn("REAL RESULT", result["content"][0]["text"])

    def test_the_manager_cannot_hand_out_what_the_user_lacks(self):
        # The manager staffed this agent with web; the USER has no web at all.
        grants = AgentGrants(user=["vault"], requested={"scout": ["web"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        gate.call_tool("web_fetch", {"url": "https://example.com"})
        self.assertEqual(self.web.calls, [])
        self.assertEqual(gate.refusals[0]["capability"], "web")

    def test_the_model_is_only_shown_the_tools_it_has(self):
        grants = AgentGrants(user=["vault", "web"], requested={"scribe": ["vault"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scribe")
        names = sorted(t.name for t in gate.list_tools())
        self.assertEqual(names, ["vault_list", "vault_read"])

    def test_one_shared_source_enforces_two_different_grants(self):
        grants = AgentGrants(
            user=["vault", "web"],
            requested={"scribe": ["vault"], "scout": ["web"]},
        )
        gate = AgentCapabilityGate(self.source, grants)
        gate.set_agent("scribe")
        gate.call_tool("web_fetch", {"url": "https://example.com"})
        self.assertEqual(self.web.calls, [])
        gate.set_agent("scout")
        gate.call_tool("web_fetch", {"url": "https://example.com"})
        self.assertEqual(len(self.web.calls), 1)

    def test_a_refusal_lands_as_a_real_span(self):
        grants = AgentGrants(user=["vault"], requested={"scout": ["vault"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        gate.call_tool("web_fetch", {"url": "https://example.com"})
        spans = read_spans(os.path.join(self.tmp, "spans.jsonl"))
        refused = [s for s in spans if s.get("attrs", {}).get("refused")]
        self.assertEqual(len(refused), 1)
        attrs = refused[0]["attrs"]
        self.assertEqual(attrs["tool"], "web_fetch")
        self.assertEqual(attrs["agent"], "scout")
        self.assertEqual(attrs["capability"], "web")
        self.assertIn("may not use the web", attrs["reason"])

    def test_an_unknown_tool_name_is_refused_not_guessed(self):
        # A model that invents a tool must not slip past the gate by being
        # unattributable: an unowned name needs 'tools', which this agent lacks.
        grants = AgentGrants(user=["vault"], requested={"scout": ["vault"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        result = gate.call_tool("rm_rf", {})
        self.assertTrue(result["refused"])
        self.assertEqual(self.web.calls, [])
        self.assertEqual(self.vault.calls, [])

    def test_attributes_pass_through_the_wrapper(self):
        grants = AgentGrants(user=["web"], requested={"scout": ["web"]})
        gate = AgentCapabilityGate(self.source, grants, agent="scout")
        gate.parent_span_id = "span-123"
        self.assertEqual(gate.parent_span_id, "span-123")
        self.assertEqual(self.web.parent_span_id, "span-123")


# ---------------------------------------------------------------------------
# The `writes` gate — enforced at the project write choke point
# ---------------------------------------------------------------------------


class TestProjectWritesCapability(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.mkdtemp()

    def test_an_agent_without_writes_writes_nothing(self):
        grants = AgentGrants(user=["writes"], requested={"critic": ["vault"]})
        result = apply_file_ops(
            [("a.txt", "hello")], self.project, grants=grants, agent="critic"
        )
        self.assertEqual(result["written"], [])
        self.assertFalse(os.path.exists(os.path.join(self.project, "a.txt")))
        self.assertIn("was not granted", result["rejected"][0]["reason"])

    def test_the_user_lacking_writes_stops_every_agent(self):
        grants = AgentGrants(user=["vault"], requested={"builder": ["writes"]})
        result = apply_file_ops(
            [("a.txt", "hello")], self.project, grants=grants, agent="builder"
        )
        self.assertEqual(result["written"], [])
        self.assertIn("you have not granted", result["rejected"][0]["reason"])

    def test_a_granted_agent_writes_for_real(self):
        grants = AgentGrants(user=["writes"], requested={"builder": ["writes"]})
        result = apply_file_ops(
            [("a.txt", "hello")], self.project, grants=grants, agent="builder"
        )
        self.assertEqual(result["written"], ["a.txt"])
        with open(os.path.join(self.project, "a.txt")) as f:
            self.assertEqual(f.read(), "hello")

    def test_no_grant_table_is_byte_identical(self):
        result = apply_file_ops([("a.txt", "hello")], self.project)
        self.assertEqual(result["written"], ["a.txt"])


# ---------------------------------------------------------------------------
# The CLI seam
# ---------------------------------------------------------------------------


class TestCliSeam(unittest.TestCase):
    def test_the_gate_is_only_built_when_a_grant_was_declared(self):
        from scprism_engine.__main__ import _apply_capability_gate

        source = _FakeSource("web", ["web_fetch"])
        self.assertIs(_apply_capability_gate(source, None), source)
        grants = AgentGrants(user=["web"], requested={"": ["web"]})
        gated = _apply_capability_gate(source, grants)
        self.assertIsInstance(gated, AgentCapabilityGate)
        self.assertIsNone(_apply_capability_gate(None, grants))

    def test_the_real_cli_parser_carries_the_grant_to_the_gate(self):
        # End of the seam: the flags the app sends parse into a grant table
        # whose clamping is already done. No mocks — the real parser.
        from scprism_engine.__main__ import _build_grants, _build_parser

        args = _build_parser().parse_args(
            [
                "run",
                "do a thing",
                "--vault",
                "/tmp/v",
                "--user-capabilities",
                "vault",
                "--agent-capabilities",
                '{"scout": ["vault", "web"]}',
            ]
        )
        grants, ok = _build_grants(args)
        self.assertTrue(ok)
        self.assertIsNotNone(grants)
        # The manager asked for web; the user has none, so the agent has none.
        self.assertEqual(grants.granted("scout"), frozenset({"vault"}))
        self.assertEqual(grants.escalations, [{"agent": "scout", "capability": "web"}])

    def test_no_flags_means_no_grant_table_at_all(self):
        from scprism_engine.__main__ import _build_grants, _build_parser

        args = _build_parser().parse_args(["run", "x", "--vault", "/tmp/v"])
        grants, ok = _build_grants(args)
        self.assertTrue(ok)
        self.assertIsNone(grants)

    def test_a_project_run_carries_the_writes_grant_end_to_end(self):
        # The `writes` capability reaches project.apply_file_ops through the
        # SAME two flags, so a staffed seat's write gate is real end to end.
        from scprism_engine.__main__ import _build_grants, _build_parser

        args = _build_parser().parse_args(
            [
                "project",
                "build it",
                "--project-dir",
                "/tmp/p",
                "--vault",
                "/tmp/v",
                "--agents",
                "lead:local,critic:local",
                "--user-capabilities",
                "vault,writes",
                "--agent-capabilities",
                '{"lead": ["writes"], "critic": ["vault"]}',
            ]
        )
        grants, ok = _build_grants(args)
        self.assertTrue(ok)
        self.assertTrue(grants.allows("lead", "writes"))
        self.assertFalse(grants.allows("critic", "writes"))
        project = tempfile.mkdtemp()
        blocked = apply_file_ops([("x.txt", "hi")], project, grants=grants, agent="critic")
        self.assertEqual(blocked["written"], [])
        self.assertFalse(os.path.exists(os.path.join(project, "x.txt")))
        allowed = apply_file_ops([("y.txt", "hi")], project, grants=grants, agent="lead")
        self.assertEqual(allowed["written"], ["y.txt"])

    def test_grants_serialize_for_the_audit_trail(self):
        grants = AgentGrants(user=["vault"], requested={"scout": ["vault", "web"]})
        blob = json.loads(json.dumps(grants.to_dict()))
        self.assertEqual(blob["user"], ["vault"])
        self.assertEqual(blob["agents"], {"scout": ["vault"]})
        self.assertEqual(blob["escalations"][0]["capability"], "web")


if __name__ == "__main__":
    unittest.main()


class TestGrantsFromSeatFiles(unittest.TestCase):
    """Slice B (2026-08-29): each board seat's grant comes from ITS OWN
    definition file — `<vault>/agents/<slug>.md`, `tools:` line — clamped to
    the run's real ceiling (what the user actually enabled: vault always
    unless opted out, web only when --web). A seat with no file or no tools
    line keeps the full ceiling (byte-identical to today); a file asking past
    the ceiling is an ESCALATION said out loud, never silently dropped."""

    def _vault(self, files):
        import tempfile, os
        vault = tempfile.mkdtemp()
        os.makedirs(os.path.join(vault, "agents"), exist_ok=True)
        for name, tools_line in files.items():
            with open(os.path.join(vault, "agents", f"{name}.md"), "w") as fh:
                fh.write(f"---\nname: {name}\nmodel: local\n{tools_line}\n---\nbody\n")
        return vault

    def test_declared_seat_clamped_undeclared_seat_keeps_ceiling(self):
        from scprism_engine.capabilities import grants_from_seat_files

        vault = self._vault({"researcher": "tools: [web]", "planner": "tools: [vault]"})
        g = grants_from_seat_files(vault, ["researcher", "planner", "implementer"], ["vault", "web"])
        self.assertEqual(g.granted("researcher"), frozenset({"web"}))
        self.assertEqual(g.granted("planner"), frozenset({"vault"}))
        self.assertEqual(g.granted("implementer"), frozenset({"vault", "web"}))

    def test_over_ask_becomes_an_escalation_not_a_silent_drop(self):
        from scprism_engine.capabilities import grants_from_seat_files

        vault = self._vault({"researcher": "tools: [web, vault]"})
        g = grants_from_seat_files(vault, ["researcher"], ["vault"])  # web NOT enabled
        self.assertEqual(g.granted("researcher"), frozenset({"vault"}))
        lines = g.escalation_lines()
        self.assertTrue(any("researcher" in l and "web" in l for l in lines), lines)

    def test_nothing_declared_returns_none_byte_identical(self):
        from scprism_engine.capabilities import grants_from_seat_files

        vault = self._vault({})
        self.assertIsNone(grants_from_seat_files(vault, ["planner", "implementer"], ["vault"]))

    def test_seat_name_slugs_like_the_client(self):
        from scprism_engine.capabilities import grants_from_seat_files

        vault = self._vault({"reviewer-verifier": "tools: [vault]"})
        g = grants_from_seat_files(vault, ["Reviewer / Verifier"], ["vault", "web"])
        self.assertEqual(g.granted("Reviewer / Verifier"), frozenset({"vault"}))
