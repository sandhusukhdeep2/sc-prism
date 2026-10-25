"""Tier 3 of progressive disclosure: a skill's bundled reference files.

The Agent Skills spec describes three tiers — metadata at startup (~100
tokens), the SKILL.md body when the skill activates (<5000 tokens), and
bundled files "loaded only when required". SC Prism had the first two. This is
the third, and it is the whole performance argument for the folder shape: a
skill can carry a large reference that costs nothing until the body cites it.

READ EAGERLY, on purpose. Storing paths and opening them later at prompt-build
time would split the deliberately gapless check-then-open pair in `_load_one`
(islink -> realpath containment -> getsize -> open) and create a TOCTOU: swap
the file for a symlink to ~/.ssh/id_rsa between load and disclosure and the
deferred open() dereferences it straight into the doer's prompt, with the
load-time-only test still green. The token saving was never in the read — it
is in what enters the PROMPT, and the block cap already delivers that.
"""
import os
import shutil
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.skills import load_vault_skill_catalog


class TestSkillResources(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-res-")
        self.skills = os.path.join(self.vault, "skills")
        os.makedirs(self.skills)

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def _folder_skill(self, slug, body="# Procedure\n1. Do it.", refs=None):
        d = os.path.join(self.skills, slug)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(f"---\nname: {slug}\ndescription: d\n---\n\n{body}\n")
        if refs:
            rd = os.path.join(d, "references")
            os.makedirs(rd, exist_ok=True)
            for fname, text in refs.items():
                with open(os.path.join(rd, fname), "w", encoding="utf-8") as fh:
                    fh.write(text)
        return d

    def _entry(self, slug):
        return next(e for e in load_vault_skill_catalog(self.vault) if e.name == slug)

    def test_folder_skill_collects_reference_contents(self):
        self._folder_skill("code-review", refs={"api.md": "# API\nThe rules."})
        e = self._entry("code-review")
        self.assertEqual(set(e.resources), {"references/api.md"})
        self.assertIn("The rules.", e.resources["references/api.md"])

    def test_reference_text_is_NOT_in_the_instructions(self):
        """Tier 3 must stay out of tier 2, or it costs tokens on every match."""
        self._folder_skill("code-review", refs={"api.md": "SENTINEL-REFERENCE-TEXT"})
        e = self._entry("code-review")
        self.assertNotIn("SENTINEL-REFERENCE-TEXT", e.instructions)

    def test_flat_skill_has_no_resources(self):
        with open(os.path.join(self.skills, "flat.md"), "w", encoding="utf-8") as fh:
            fh.write("---\nname: flat\ndescription: d\n---\n\n# P\n")
        self.assertEqual(self._entry("flat").resources, {})

    def test_a_symlinked_reference_is_never_read(self):
        """The same rule _load_one applies to skill files themselves: git
        preserves symlinks, so a committed references/notes.md -> ~/.ssh/id_rsa
        must never be dereferenced into a prompt."""
        d = self._folder_skill("linky", refs={"real.md": "fine"})
        secret = os.path.join(self.vault, "outside-secret.txt")
        with open(secret, "w", encoding="utf-8") as fh:
            fh.write("KEY-MATERIAL-MUST-NOT-LEAK")
        os.symlink(secret, os.path.join(d, "references", "leak.md"))
        e = self._entry("linky")
        self.assertNotIn("references/leak.md", e.resources)
        blob = "".join(e.resources.values())
        self.assertNotIn("KEY-MATERIAL-MUST-NOT-LEAK", blob)

    def test_an_oversized_reference_is_skipped_not_truncated(self):
        self._folder_skill("big", refs={"huge.md": "x" * (64 * 1024)})
        self.assertEqual(self._entry("big").resources, {})

    def test_references_are_one_level_deep_only(self):
        """The spec: "Keep file references one level deep from SKILL.md"."""
        d = self._folder_skill("deep", refs={"ok.md": "shallow"})
        nested = os.path.join(d, "references", "nested")
        os.makedirs(nested)
        with open(os.path.join(nested, "deep.md"), "w", encoding="utf-8") as fh:
            fh.write("too deep")
        e = self._entry("deep")
        self.assertEqual(set(e.resources), {"references/ok.md"})

    def test_reference_count_is_capped(self):
        refs = {f"r{i}.md": f"body {i}" for i in range(40)}
        self._folder_skill("many", refs=refs)
        self.assertLessEqual(len(self._entry("many").resources), 20)


if __name__ == "__main__":
    unittest.main()
