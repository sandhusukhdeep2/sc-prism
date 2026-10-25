"""`allowed-tools` may only ever NARROW a grant. Never widen one.

The Agent Skills spec has an experimental `allowed-tools` field — "a
space-separated string of tools that are pre-approved to run" — and says
nothing at all about how a host must enforce it. That silence is the hazard:
a skill file is a shareable, importable artifact. If reading one could GRANT a
capability, importing a skill would be a privilege escalation with no user
action at all.

So the hard rule, repeated in the production docstring:

    a skill's declaration is NEVER an argument to any AgentGrants constructor;
    it is only ever the right operand of `&` against grants.granted(agent).

`normalize()` is deliberately untouched. Its only other callers are
`subset_of_user` and `AgentGrants.__init__` — the no-escalation primitive
itself — and widening it to satisfy a skill-parsing test would be exactly the
wrong direction.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.capabilities import (
    AgentGrants,
    normalize,
    parse_allowed_tools,
    skill_narrowing,
)


class TestParseAllowedTools(unittest.TestCase):
    def test_splits_on_whitespace_as_the_spec_writes_it(self):
        # normalize() splits on commas only, so 'vault web' is frozenset() there.
        self.assertEqual(normalize("vault web"), frozenset())
        self.assertEqual(parse_allowed_tools("vault web"), frozenset({"vault", "web"}))

    def test_also_accepts_commas(self):
        self.assertEqual(parse_allowed_tools("vault, web"), frozenset({"vault", "web"}))

    def test_unknown_tokens_shrink_never_widen(self):
        # The spec's own example is `Bash(git:*) Bash(jq:*) Read` — vocabulary
        # this engine cannot enforce. Keep only what we can actually gate.
        self.assertEqual(parse_allowed_tools("Bash(git:*) Read vault"), frozenset({"vault"}))

    def test_no_recognised_token_returns_None_not_empty(self):
        """The normal case for an imported skill. Treating a foreign
        vocabulary as a real EMPTY declaration would refuse every tool for the
        turn and kill the run."""
        self.assertIsNone(parse_allowed_tools("Bash(git:*) Read"))

    def test_absent_returns_None(self):
        self.assertIsNone(parse_allowed_tools(""))
        self.assertIsNone(parse_allowed_tools(None))


class TestSkillNarrowing(unittest.TestCase):
    def test_a_silent_skill_means_no_narrowing(self):
        """A skill that declares nothing may need the full grant — one silent
        skill in the set must not narrow the turn."""
        self.assertIsNone(skill_narrowing([frozenset({"vault"}), None]))
        self.assertIsNone(skill_narrowing([]))

    def test_declarations_union_rather_than_intersect(self):
        # Up to three skills disclose at once; intersecting three narrow
        # declarations collapses to the empty set and kills the run.
        self.assertEqual(
            skill_narrowing([frozenset({"vault"}), frozenset({"web"})]),
            frozenset({"vault", "web"}),
        )


class TestNarrowingCanNeverEscalate(unittest.TestCase):
    def test_a_skill_cannot_grant_what_the_seat_does_not_hold(self):
        # The fixture that matters: the SEAT holds less than the USER. An
        # implementation that passed the declaration to AgentGrants as
        # `requested` would clamp it to the USER and hand back `web`.
        grants = AgentGrants(
            user=["vault", "web", "terminal"],
            requested={"reviewer": ["vault"]},
        )
        declared = parse_allowed_tools("web terminal")
        effective = grants.granted("reviewer") & declared
        # The seat holds only `vault`; the skill permits only web/terminal. The
        # honest result is NOTHING — the skill cannot conjure a capability the
        # seat never had. (That empty turn must be explained by a refusal naming
        # the SKILL, never by AgentGrants.refusal, which would blame the user's
        # grant for a capability the user actually holds.)
        self.assertEqual(effective, frozenset())
        self.assertNotIn("web", effective)
        self.assertNotIn("terminal", effective)
        # And the property that matters everywhere: never more than the seat.
        self.assertTrue(effective <= grants.granted("reviewer"))

    def test_a_skill_cannot_grant_what_the_user_does_not_hold(self):
        grants = AgentGrants(user=["vault"], requested={"reviewer": ["vault"]})
        declared = parse_allowed_tools("vault web computer terminal tools writes")
        self.assertEqual(grants.granted("reviewer") & declared, frozenset({"vault"}))

    def test_narrowing_is_only_ever_an_intersection(self):
        """Property: for any seat grant and any declaration, the result is a
        subset of what the seat already held."""
        grants = AgentGrants(
            user=["vault", "web", "terminal", "writes"],
            requested={"a": ["vault", "web"]},
        )
        for raw in ("web", "terminal", "vault web terminal writes", "Bash(x) vault"):
            declared = parse_allowed_tools(raw)
            if declared is None:
                continue
            self.assertTrue((grants.granted("a") & declared) <= grants.granted("a"))


if __name__ == "__main__":
    unittest.main()


class TestDeclarationReachesTheCatalog(unittest.TestCase):
    """End-to-end: a real skill file's declaration lands on its CatalogEntry."""

    def _entry(self, frontmatter):
        import os
        import shutil
        import tempfile

        from scprism_engine.skills import load_vault_skill_catalog

        v = tempfile.mkdtemp(prefix="scprism-at-")
        try:
            d = os.path.join(v, "skills")
            os.makedirs(d)
            with open(os.path.join(d, "x.md"), "w", encoding="utf-8") as fh:
                fh.write(f"---\nname: x\ndescription: d\n{frontmatter}---\n\n# P\n")
            return load_vault_skill_catalog(v)[0]
        finally:
            shutil.rmtree(v, ignore_errors=True)

    def test_the_spec_field_is_read(self):
        self.assertEqual(
            self._entry("allowed-tools: vault web\n").allowed_tools,
            frozenset({"vault", "web"}),
        )

    def test_our_metadata_alias_is_read(self):
        self.assertEqual(
            self._entry("metadata:\n  scprism_capabilities: vault\n").allowed_tools,
            frozenset({"vault"}),
        )

    def test_a_foreign_vocabulary_leaves_the_grant_alone(self):
        self.assertIsNone(self._entry("allowed-tools: Bash(git:*) Read\n").allowed_tools)

    def test_a_silent_skill_declares_nothing(self):
        self.assertIsNone(self._entry("").allowed_tools)

    def test_an_indented_allowed_tools_cannot_hijack_the_declaration(self):
        """The reserved-key guard covers allowed-tools too: a foreign skill's
        metadata block must not be able to widen its own declaration."""
        e = self._entry("allowed-tools: vault\nmetadata:\n  allowed-tools: terminal writes\n")
        self.assertEqual(e.allowed_tools, frozenset({"vault"}))
