"""A disclosed skill's CITED reference is expanded into the prompt block.

Tier 3 only pays off if the body can reach it. The rule is deliberately narrow:
a reference is appended only when the skill's own instructions NAME it. A
skill carrying ten references and citing one must cost one — otherwise the
folder shape is a token tax rather than a saving.

`_build_skill_context` stays a PURE function. The reference text is already in
memory (read eagerly at load time under the containment guards), so expansion
is a lookup, never I/O.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.context import DisclosedSkill
from scprism_engine.loop import MAX_SKILLS_BLOCK_CHARS, _build_skill_context


def _skill(name="code-review", instructions="# P\n1. Do it.", resources=None):
    return DisclosedSkill(
        name=name,
        instructions=instructions,
        tokens=10,
        matched_on="diff",
        resources=resources or {},
    )


class TestReferenceExpansion(unittest.TestCase):
    def test_a_cited_reference_is_appended(self):
        block, injected = _build_skill_context(
            [
                _skill(
                    instructions="# P\nFollow references/api.md exactly.",
                    resources={"references/api.md": "THE-API-RULES"},
                )
            ]
        )
        self.assertIn("THE-API-RULES", block)
        self.assertIn("references/api.md", block)
        self.assertEqual(injected, ["code-review"])

    def test_an_uncited_reference_is_never_appended(self):
        block, _ = _build_skill_context(
            [
                _skill(
                    instructions="# P\n1. Do it.",
                    resources={"references/unused.md": "NEVER-INCLUDE-ME"},
                )
            ]
        )
        self.assertNotIn("NEVER-INCLUDE-ME", block)

    def test_only_the_cited_one_of_many_is_appended(self):
        block, _ = _build_skill_context(
            [
                _skill(
                    instructions="# P\nSee references/b.md.",
                    resources={
                        "references/a.md": "AAA-BODY",
                        "references/b.md": "BBB-BODY",
                        "references/c.md": "CCC-BODY",
                    },
                )
            ]
        )
        self.assertIn("BBB-BODY", block)
        self.assertNotIn("AAA-BODY", block)
        self.assertNotIn("CCC-BODY", block)

    def test_a_big_reference_fills_the_room_instead_of_being_dropped(self):
        """Found by an end-to-end run, not by the first version of this test.

        When instructions+reference overflow, the truncation branch used to cut
        the INSTRUCTIONS only — so the reference vanished entirely and the block
        came back at 133 chars with ~3,900 characters of room unused. Cap the
        combined body instead: the reference is what the model was told to
        follow, so it should fill whatever space is left."""
        block, _ = _build_skill_context(
            [
                _skill(
                    instructions="# P\nSee references/huge.md.",
                    resources={"references/huge.md": "z" * (MAX_SKILLS_BLOCK_CHARS * 2)},
                )
            ]
        )
        self.assertLessEqual(len(block), MAX_SKILLS_BLOCK_CHARS)
        # The room is actually USED — not left empty by a dropped reference.
        self.assertGreater(len(block), MAX_SKILLS_BLOCK_CHARS - 100)
        self.assertIn("zzz", block)

    def test_a_skill_with_no_resources_is_byte_identical(self):
        """The whole flat-skill path must not move."""
        before, names_before = _build_skill_context([_skill(resources={})])
        after, names_after = _build_skill_context([_skill()])
        self.assertEqual(before, after)
        self.assertEqual(names_before, names_after)


if __name__ == "__main__":
    unittest.main()
