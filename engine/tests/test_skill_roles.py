"""Task P3-1 — role-scoped skill disclosure.

A skill can be tagged with roles (frontmatter ``roles:`` / ``agents:``) so it
reaches ONLY the matching agent in the role board. No roles ⇒ GLOBAL — today's
behavior, byte-identical. Three layers under test:

  * ``context.disclose(task, catalog, role=...)`` — the role filter layered ON
    TOP of the unchanged trigger match (``role=""`` ⇒ today's behavior).
  * ``skills.load_vault_skill_catalog`` — parsing the ``roles:`` / ``agents:``
    frontmatter key into ``CatalogEntry.roles`` (no key ⇒ ``[]`` = global).
  * ``team.run_role_board(skill_catalog=...)`` — per-agent role disclosure into
    THAT agent's board prompt (planner-scoped skill reaches the planner, not the
    developer; a global skill reaches everyone; no catalog ⇒ no injection).
"""

import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.context import CatalogEntry, disclose
from scprism_engine.skills import load_vault_skill_catalog
from scprism_engine import team as team_module
from scprism_engine.team import AgentSpec, run_role_board

SKILLS_HEADER = "Relevant saved skills"


# ---------------------------------------------------------------------------
# 1. disclose() role filter.
# ---------------------------------------------------------------------------
class DiscloseRoleFilterTests(unittest.TestCase):
    def _catalog(self):
        # All three share the SAME trigger, so trigger matching is constant and
        # the role filter is the only discriminator under test.
        return [
            CatalogEntry(name="global-skill", triggers=["deploy"], instructions="G"),
            CatalogEntry(
                name="plan-skill", triggers=["deploy"], instructions="P", roles=["planner"]
            ),
            CatalogEntry(
                name="dev-skill", triggers=["deploy"], instructions="D", roles=["developer"]
            ),
        ]

    def test_default_roles_is_empty_global(self):
        self.assertEqual(CatalogEntry(name="x").roles, [])

    def test_no_role_returns_all_matching_triggers_as_today(self):
        # role="" ⇒ today's behavior: every trigger match, no role filtering.
        got = [d.name for d in disclose("deploy the app", self._catalog())]
        self.assertEqual(got, ["global-skill", "plan-skill", "dev-skill"])

    def test_global_entry_discloses_for_any_role_and_for_empty(self):
        for role in ("planner", "developer", "lead", ""):
            names = [d.name for d in disclose("deploy the app", self._catalog(), role=role)]
            self.assertIn("global-skill", names)

    def test_role_tagged_entry_only_for_its_role(self):
        planner = [d.name for d in disclose("deploy the app", self._catalog(), role="planner")]
        self.assertEqual(planner, ["global-skill", "plan-skill"])
        dev = [d.name for d in disclose("deploy the app", self._catalog(), role="developer")]
        self.assertEqual(dev, ["global-skill", "dev-skill"])
        # A role with no dedicated skill still gets the global one only.
        lead = [d.name for d in disclose("deploy the app", self._catalog(), role="lead")]
        self.assertEqual(lead, ["global-skill"])

    def test_role_match_is_case_insensitive(self):
        cat = [CatalogEntry(name="p", triggers=["deploy"], instructions="P", roles=["Planner"])]
        self.assertEqual(len(disclose("deploy", cat, role="planner")), 1)
        self.assertEqual(len(disclose("deploy", cat, role="PLANNER")), 1)
        self.assertEqual(disclose("deploy", cat, role="developer"), [])

    def test_role_is_an_additional_filter_not_a_replacement(self):
        # A role-matching entry whose TRIGGER does not fire still discloses
        # nothing — role is layered ON TOP of trigger matching, never instead.
        cat = [CatalogEntry(name="p", triggers=["rollback"], instructions="P", roles=["planner"])]
        self.assertEqual(disclose("deploy the app", cat, role="planner"), [])


# ---------------------------------------------------------------------------
# 2. skills.py frontmatter parsing.
# ---------------------------------------------------------------------------
class SkillsRolesFrontmatterTests(unittest.TestCase):
    def _vault(self, files):
        vault = tempfile.mkdtemp()
        d = os.path.join(vault, "skills")
        os.makedirs(d)
        for name, content in files.items():
            with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                fh.write(content)
        return vault

    def test_roles_key_parsed_space_and_comma_separated(self):
        vault = self._vault(
            {
                "a.md": "---\nname: a\nroles: planner developer\n---\nBody.\n",
                "b.md": "---\nname: b\nroles: planner, lead\n---\nBody.\n",
            }
        )
        cat = {e.name: e for e in load_vault_skill_catalog(vault)}
        self.assertEqual(cat["a"].roles, ["planner", "developer"])
        self.assertEqual(cat["b"].roles, ["planner", "lead"])

    def test_agents_key_is_an_alias_for_roles(self):
        vault = self._vault({"c.md": "---\nname: c\nagents: developer\n---\nBody.\n"})
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(cat[0].roles, ["developer"])

    def test_no_roles_key_is_global(self):
        vault = self._vault({"d.md": "---\nname: d\nwhen_to_use: x thing\n---\nBody.\n"})
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(cat[0].roles, [])


# ---------------------------------------------------------------------------
# 3. run_role_board per-agent role disclosure.
# ---------------------------------------------------------------------------
class _FakeRoute:
    def __init__(self, provider):
        self.provider = provider
        self.model = f"{provider}-model"
        self.target = "local" if provider == "local" else "cloud"
        self.is_local = provider == "local"
        self.reason = "fake"


class _FakeResult:
    def __init__(self, text, tokens=5):
        self.text = text
        self.tokens = tokens
        self.is_real = True
        self.tokens_in = tokens // 2
        self.tokens_out = tokens - tokens // 2
        self.cache = "miss"


def make_recording_gateway(calls):
    """A ``team.Gateway`` double whose provider identity comes from
    ``SCPRISM_PRIMARY`` (so per-agent routing stays honest) and which records
    every user prompt it is handed keyed by provider — the test then asserts
    which skill body reached which agent."""

    class _FakeGateway:
        def __init__(self, *, env=None, **_kw):
            e = env or {}
            self.provider = e.get("SCPRISM_PRIMARY", "local")

        def route(self, _prompt):
            return _FakeRoute(self.provider)

        def model_call(self, messages, route):
            user = "\n".join(
                str(m.get("content", "")) for m in messages if m.get("role") == "user"
            )
            calls.append({"provider": route.provider, "user": user})
            return _FakeResult(f"[{route.provider}] board contribution")

    return _FakeGateway


class RoleBoardPerAgentDisclosureTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.env = {"PATH": "/nonexistent", "SCPRISM_VAULT": self._tmp.name}

    def tearDown(self):
        self._tmp.cleanup()

    def _agents(self):
        # name = the ROLE identifier (planner/developer/lead); provider is the
        # per-agent gateway id the fake reads back to attribute prompts.
        return [
            AgentSpec("lead", "Lead and synthesize.", "openai"),
            AgentSpec("planner", "Plan.", "gemini"),
            AgentSpec("developer", "Implement.", "local"),
        ]

    def _scoped_catalog(self):
        return [
            CatalogEntry(
                name="brainstorming",
                triggers=["build"],
                instructions="PLANNER_ONLY_BRAINSTORM",
                roles=["planner"],
            ),
            CatalogEntry(
                name="testing",
                triggers=["build"],
                instructions="DEVELOPER_ONLY_TESTING",
                roles=["developer"],
            ),
        ]

    def test_planner_skill_reaches_planner_not_developer(self):
        calls = []
        Fake = make_recording_gateway(calls)
        with mock.patch.object(team_module, "Gateway", Fake):
            run_role_board(
                "build the feature",
                "cloud",
                self._agents(),
                env=self.env,
                skill_catalog=self._scoped_catalog(),
            )
        planner = "\n".join(c["user"] for c in calls if c["provider"] == "gemini")
        dev = "\n".join(c["user"] for c in calls if c["provider"] == "local")
        lead = "\n".join(c["user"] for c in calls if c["provider"] == "openai")

        self.assertIn("PLANNER_ONLY_BRAINSTORM", planner)
        self.assertNotIn("DEVELOPER_ONLY_TESTING", planner)
        self.assertIn("DEVELOPER_ONLY_TESTING", dev)
        self.assertNotIn("PLANNER_ONLY_BRAINSTORM", dev)
        # The lead has no role-scoped skill: neither role-tagged body reaches it.
        self.assertNotIn("PLANNER_ONLY_BRAINSTORM", lead)
        self.assertNotIn("DEVELOPER_ONLY_TESTING", lead)

    def test_global_skill_reaches_every_agent(self):
        calls = []
        Fake = make_recording_gateway(calls)
        cat = [CatalogEntry(name="always", triggers=["build"], instructions="GLOBAL_BODY")]
        with mock.patch.object(team_module, "Gateway", Fake):
            run_role_board(
                "build the feature", "cloud", self._agents(), env=self.env, skill_catalog=cat
            )
        for provider in ("gemini", "local", "openai"):
            users = "\n".join(c["user"] for c in calls if c["provider"] == provider)
            self.assertIn("GLOBAL_BODY", users)

    def test_no_catalog_injects_no_skill_block(self):
        calls = []
        Fake = make_recording_gateway(calls)
        with mock.patch.object(team_module, "Gateway", Fake):
            run_role_board("build the feature", "cloud", self._agents(), env=self.env)
        self.assertTrue(calls)
        for c in calls:
            self.assertNotIn(SKILLS_HEADER, c["user"])

    def test_run_role_board_reports_disclosed_union(self):
        # Attribution: the board reports the UNION of what each agent was told —
        # the global skill (every agent) + each role's own skill, deduped.
        calls = []
        Fake = make_recording_gateway(calls)
        cat = self._scoped_catalog() + [
            CatalogEntry(name="always", triggers=["build"], instructions="GLOBAL_BODY")
        ]
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board(
                "build the feature", "cloud", self._agents(), env=self.env, skill_catalog=cat
            )
        self.assertEqual(sorted(result.disclosed), ["always", "brainstorming", "testing"])

    def test_no_catalog_reports_empty_disclosed(self):
        calls = []
        Fake = make_recording_gateway(calls)
        with mock.patch.object(team_module, "Gateway", Fake):
            result = run_role_board("build the feature", "cloud", self._agents(), env=self.env)
        self.assertEqual(result.disclosed, [])

    def test_team_model_adapter_carries_disclosed_out(self):
        from scprism_engine.team import team_model_adapter

        calls = []
        Fake = make_recording_gateway(calls)
        cat = [CatalogEntry(name="always", triggers=["build"], instructions="GLOBAL_BODY")]
        adapter = team_model_adapter(self._agents(), env=self.env, skill_catalog=cat)
        with mock.patch.object(team_module, "Gateway", Fake):
            mr = adapter("build the feature", "cloud")
        # The board's disclosed names ride out on ModelResult.disclosed (the same
        # optional-field-merge pipe P1-2 used for models_used).
        self.assertEqual(mr.disclosed, ["always"])


if __name__ == "__main__":
    unittest.main()
