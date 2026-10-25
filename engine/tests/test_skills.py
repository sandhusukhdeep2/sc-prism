"""Tests for the vault skill-catalog loader (Task S1).

Turns <vault>/skills/*.md into CatalogEntry objects (context.py's
progressive-disclosure catalog). Frontmatter parsing mirrors the client's
parseVaultSkill (src/lib/skills.ts ~L274) so a skill authored in the UI
round-trips identically here.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import skills as skills_mod
from scprism_engine.skills import _parse_skill_markdown, load_vault_skill_catalog


def _write_vault(files):
    """Create a temp vault dir with <vault>/skills/<name> = content for each
    (name, content) pair in ``files``. Returns the vault path."""
    vault = tempfile.mkdtemp()
    skills_dir = os.path.join(vault, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    for name, content in files.items():
        path = os.path.join(skills_dir, name)
        if isinstance(content, bytes):
            with open(path, "wb") as fh:
                fh.write(content)
        else:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(content)
    return vault


class TestLoadVaultSkillCatalog(unittest.TestCase):
    def test_frontmatter_happy_path(self):
        vault = _write_vault(
            {
                "alpha.md": (
                    "---\n"
                    "name: alpha-skill\n"
                    "description: does alpha things\n"
                    "when_to_use: alpha task, doing alpha\n"
                    "---\n"
                    "\n"
                    "Alpha body text.\n"
                )
            }
        )
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 1)
        entry = cat[0]
        self.assertEqual(entry.name, "alpha-skill")
        self.assertEqual(entry.summary, "does alpha things")
        self.assertEqual(entry.instructions, "Alpha body text.")
        self.assertIn("alpha task", entry.triggers)
        self.assertIn("doing alpha", entry.triggers)
        # The name itself is always a trigger too (progressive disclosure by
        # name alone, even with no when_to_use match).
        self.assertIn("alpha-skill", entry.triggers)

    def test_no_frontmatter_uses_heading_and_only_name_trigger(self):
        vault = _write_vault({"beta.md": "# Beta Skill\n\nBeta body text.\n"})
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 1)
        entry = cat[0]
        self.assertEqual(entry.name, "Beta Skill")
        self.assertEqual(entry.summary, "")
        # instructions = content minus frontmatter, stripped — with no
        # frontmatter to remove, the heading line stays part of the body
        # (mirrors parseVaultSkill: `body` is never stripped of its heading).
        self.assertEqual(entry.instructions, "# Beta Skill\n\nBeta body text.")
        self.assertEqual(entry.triggers, ["Beta Skill"])

    def test_no_frontmatter_no_heading_falls_back_to_filename_stem(self):
        vault = _write_vault({"gamma-skill.md": "just some body text, no heading\n"})
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 1)
        self.assertEqual(cat[0].name, "gamma-skill")
        self.assertEqual(cat[0].triggers, ["gamma-skill"])

    def test_hyphenated_frontmatter_keys_normalize_to_underscores(self):
        vault = _write_vault(
            {
                "delta.md": (
                    "---\n"
                    "name: delta-skill\n"
                    "when-to-use: fix a delta bug\n"
                    "---\n"
                    "Delta body.\n"
                )
            }
        )
        cat = load_vault_skill_catalog(vault)
        self.assertIn("fix a delta bug", cat[0].triggers)

    def test_when_to_use_splits_on_commas_semicolons_and_newlines(self):
        # The frontmatter block is line-based (mirrors parseVaultSkill: one
        # physical line = one value), so a raw newline can never land inside a
        # single fm value from file parsing. The splitting helper itself must
        # still treat commas, semicolons, AND embedded newlines as separators
        # (defensive / forward-compatible), so it is exercised directly here.
        phrases = skills_mod._split_when_to_use(
            "first phrase, second phrase; third phrase\nfourth phrase"
        )
        self.assertEqual(phrases, ["first phrase", "second phrase", "third phrase", "fourth phrase"])

    def test_when_to_use_commas_via_loader(self):
        vault = _write_vault(
            {
                "epsilon.md": (
                    "---\n"
                    "name: epsilon\n"
                    "when_to_use: one thing, another thing, a third thing\n"
                    "---\n"
                    "Body.\n"
                )
            }
        )
        cat = load_vault_skill_catalog(vault)
        triggers = cat[0].triggers
        self.assertIn("one thing", triggers)
        self.assertIn("another thing", triggers)
        self.assertIn("a third thing", triggers)
        self.assertIn("epsilon", triggers)

    def test_when_to_use_empty_phrases_dropped(self):
        phrases = skills_mod._split_when_to_use("one,, ;  ,two")
        self.assertEqual(phrases, ["one", "two"])

    def test_missing_skills_dir_returns_empty(self):
        vault = tempfile.mkdtemp()  # no skills/ subdir at all
        self.assertEqual(load_vault_skill_catalog(vault), [])

    def test_empty_skills_dir_returns_empty(self):
        vault = tempfile.mkdtemp()
        os.makedirs(os.path.join(vault, "skills"))
        self.assertEqual(load_vault_skill_catalog(vault), [])

    def test_nonexistent_vault_returns_empty(self):
        self.assertEqual(load_vault_skill_catalog("/no/such/vault/path/at/all"), [])

    def test_empty_vault_arg_returns_empty(self):
        self.assertEqual(load_vault_skill_catalog(""), [])

    def test_oversize_file_skipped(self):
        big = "x" * (33 * 1024)  # > 32 KB cap
        vault = _write_vault(
            {
                "big.md": f"---\nname: big\n---\n{big}\n",
                "small.md": "---\nname: small\n---\nfine.\n",
            }
        )
        cat = load_vault_skill_catalog(vault)
        names = [e.name for e in cat]
        self.assertNotIn("big", names)
        self.assertIn("small", names)

    def test_undecodable_file_skipped(self):
        vault = _write_vault(
            {
                "bad.md": b"\xff\xfe\x00\x01not valid utf8 \xff",
                "good.md": "---\nname: good\n---\nfine.\n",
            }
        )
        cat = load_vault_skill_catalog(vault)
        names = [e.name for e in cat]
        self.assertNotIn("bad", names)
        self.assertIn("good", names)

    def test_non_md_files_ignored(self):
        vault = _write_vault(
            {
                "notes.txt": "not a skill file",
                "real.md": "---\nname: real\n---\nBody.\n",
            }
        )
        cat = load_vault_skill_catalog(vault)
        self.assertEqual([e.name for e in cat], ["real"])

    def test_cap_at_100_files_sorted(self):
        files = {f"skill-{i:03d}.md": f"---\nname: skill-{i:03d}\n---\nBody {i}.\n" for i in range(105)}
        vault = _write_vault(files)
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 100)
        names = [e.name for e in cat]
        self.assertEqual(names, [f"skill-{i:03d}" for i in range(100)])
        self.assertNotIn("skill-100", names)
        self.assertNotIn("skill-104", names)

    def test_returns_sorted_by_filename_deterministic(self):
        vault = _write_vault(
            {
                "charlie.md": "---\nname: charlie\n---\nC.\n",
                "alpha.md": "---\nname: alpha\n---\nA.\n",
                "bravo.md": "---\nname: bravo\n---\nB.\n",
            }
        )
        cat1 = load_vault_skill_catalog(vault)
        cat2 = load_vault_skill_catalog(vault)
        self.assertEqual([e.name for e in cat1], ["alpha", "bravo", "charlie"])
        self.assertEqual([e.name for e in cat1], [e.name for e in cat2])


# A sentinel standing in for whatever sensitive out-of-vault file a malicious
# symlink might target (e.g. a private key under ~/.ssh). Kept deliberately
# neutral so it reads as a fixture, not a real credential; the loader must
# never surface it in any CatalogEntry.
_OUTSIDE_SENTINEL = "OUTSIDE_VAULT_CONTENT_MUST_NOT_LOAD"


class TestSymlinkContainment(unittest.TestCase):
    """Security: a shared/committed skills file must not be able to read a
    file OUTSIDE the vault. Symlinks are skipped outright (best-effort, never
    raise) — an exfiltration guard mirroring project.py's write boundary."""

    def test_symlink_to_outside_file_is_not_loaded(self):
        # A sensitive file living OUTSIDE the vault, ASCII + small (< 32 KB).
        outside = tempfile.mkdtemp()
        outside_path = os.path.join(outside, "id_rsa")
        with open(outside_path, "w", encoding="utf-8") as fh:
            fh.write(_OUTSIDE_SENTINEL + "\n")

        vault = _write_vault({"real.md": "---\nname: real\n---\nBody.\n"})
        # notes.md -> /outside/id_rsa  (git preserves symlinks; skills shareable)
        link = os.path.join(vault, "skills", "notes.md")
        os.symlink(outside_path, link)

        cat = load_vault_skill_catalog(vault)
        names = [e.name for e in cat]
        # The symlink is skipped; the regular file still loads.
        self.assertNotIn("notes", names)
        self.assertIn("real", names)
        # The outside content must appear in NO catalog entry, anywhere.
        for e in cat:
            self.assertNotIn(_OUTSIDE_SENTINEL, e.instructions)
            self.assertNotIn(_OUTSIDE_SENTINEL, e.summary)

    def test_regular_md_still_loads_alongside_symlink(self):
        # Regression: a normal .md file is unaffected by the symlink guard.
        outside = tempfile.mkdtemp()
        outside_path = os.path.join(outside, "outside.md")
        with open(outside_path, "w", encoding="utf-8") as fh:
            fh.write("---\nname: leaked\n---\n" + _OUTSIDE_SENTINEL + "\n")

        vault = _write_vault({"ok.md": "---\nname: ok\n---\nGood body.\n"})
        os.symlink(outside_path, os.path.join(vault, "skills", "evil.md"))

        cat = load_vault_skill_catalog(vault)
        names = [e.name for e in cat]
        self.assertEqual(names, ["ok"])
        self.assertEqual(cat[0].instructions, "Good body.")

    def test_symlink_pointing_inside_skills_dir_is_also_skipped(self):
        # Containment choice: ALL symlinks are skipped (simplest correct
        # behavior), even one pointing to another file inside skills/. The
        # target's real file still loads on its own.
        vault = _write_vault({"target.md": "---\nname: target\n---\nInside body.\n"})
        skills_dir = os.path.join(vault, "skills")
        os.symlink(os.path.join(skills_dir, "target.md"), os.path.join(skills_dir, "alias.md"))

        cat = load_vault_skill_catalog(vault)
        names = [e.name for e in cat]
        self.assertIn("target", names)
        # `alias.md` is a symlink -> skipped; only the real file is loaded once.
        self.assertEqual(names.count("target"), 1)
        self.assertNotIn("alias", names)




class TestSkillFolders(unittest.TestCase):
    """Slice C of the agent standard (2026-08-29): skills grow from flat
    ``skills/<slug>.md`` files to the ecosystem's folder shape
    ``skills/<slug>/SKILL.md`` (+ optional references/, scripts/). Both shapes
    load; on a slug collision the folder wins; nothing inside a skill folder
    except its SKILL.md is ever scanned."""

    def test_folder_skill_loads_with_folder_slug_as_fallback_name(self):
        vault = tempfile.mkdtemp()
        d = os.path.join(vault, "skills", "web-digest")
        os.makedirs(d)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("Fetch pages, then summarize with citations.\n")
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 1)
        # No fm name, no heading: the FOLDER slug names it — never "SKILL".
        self.assertEqual(cat[0].name, "web-digest")
        self.assertIn("citations", cat[0].instructions)

    def test_folder_and_flat_coexist_sorted(self):
        vault = _write_vault({"alpha.md": "# Alpha\nbody"})
        d = os.path.join(vault, "skills", "zeta")
        os.makedirs(d)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("# Zeta\nbody")
        cat = load_vault_skill_catalog(vault)
        self.assertEqual([e.name for e in cat], ["Alpha", "Zeta"])

    def test_same_slug_folder_wins_over_flat(self):
        vault = _write_vault({"digest.md": "# Flat digest\nold shape"})
        d = os.path.join(vault, "skills", "digest")
        os.makedirs(d)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("# Folder digest\nnew shape")
        cat = load_vault_skill_catalog(vault)
        self.assertEqual(len(cat), 1)
        self.assertEqual(cat[0].name, "Folder digest")

    def test_folder_without_skill_md_ignored_and_resources_never_scanned(self):
        vault = _write_vault({"real.md": "# Real\nbody"})
        d = os.path.join(vault, "skills", "not-a-skill", "references")
        os.makedirs(d)
        with open(os.path.join(d, "notes.md"), "w", encoding="utf-8") as fh:
            fh.write("# Buried\nnever a skill")
        cat = load_vault_skill_catalog(vault)
        self.assertEqual([e.name for e in cat], ["Real"])

    def test_symlinked_folder_and_symlinked_skill_md_skipped(self):
        vault = _write_vault({})
        outside = tempfile.mkdtemp()
        real_dir = os.path.join(outside, "escape")
        os.makedirs(real_dir)
        with open(os.path.join(real_dir, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write("# Escape\nsecrets")
        os.symlink(real_dir, os.path.join(vault, "skills", "linkdir"))
        d = os.path.join(vault, "skills", "linkfile")
        os.makedirs(d)
        secret = os.path.join(outside, "id_rsa.md")
        with open(secret, "w", encoding="utf-8") as fh:
            fh.write("# Key\nmaterial")
        os.symlink(secret, os.path.join(d, "SKILL.md"))
        self.assertEqual(load_vault_skill_catalog(vault), [])


# ---------------------------------------------------------------------------
# Agent Skills conformance, phase B — parser hardening (design 2026-08-31).
#
# The spec's escape hatch for non-standard properties is a `metadata:` mapping.
# Reading it costs nothing here, because this parser flattens indentation and
# an indented child already lands as a top-level key. That accident is load-
# bearing for the migration — and it is also the hazard: a LEGAL foreign skill
# whose metadata block happens to contain `name:` would silently overwrite the
# real one. A reserved key may only ever be set by a top-level line.
# ---------------------------------------------------------------------------
class TestFrontmatterHardening(unittest.TestCase):
    def _entry(self, raw, filename="x.md"):
        return _parse_skill_markdown(filename, raw)

    def test_metadata_children_still_flatten_to_top_level(self):
        """The accident the migration relies on. Passes today; pinned anyway."""
        e = self._entry(
            "---\n"
            "name: code-review\n"
            "description: reviews diffs\n"
            "metadata:\n"
            "  when_to_use: any diff over 5 lines\n"
            "---\n"
            "# Procedure\n"
        )
        self.assertEqual(e.name, "code-review")
        self.assertIn("any diff over 5 lines", e.triggers)

    def test_indented_line_can_never_set_a_reserved_key(self):
        """A legal foreign skill must not be able to hijack name/description."""
        e = self._entry(
            "---\n"
            "name: real-name\n"
            "description: the real one\n"
            "metadata:\n"
            "  name: HIJACKED\n"
            "  description: HIJACKED\n"
            "  allowed-tools: terminal\n"
            "---\n"
            "# Procedure\n"
        )
        self.assertEqual(e.name, "real-name")
        self.assertEqual(e.summary, "the real one")

    def test_quoted_values_are_unquoted(self):
        """YAML-quoted scalars are legal and common; today the quotes survive
        into the name, which silently breaks the verdict->library name join."""
        e = self._entry('---\nname: "code-review"\ndescription: \'reviews diffs\'\n---\n# P\n')
        self.assertEqual(e.name, "code-review")
        self.assertEqual(e.summary, "reviews diffs")

    def test_whentouse_alias_matches_the_client(self):
        """The client accepts `whenToUse`/`when-to-use`; the engine did not, so
        a file using it showed triggers in the UI and produced none at run."""
        e = self._entry("---\nname: n\nwhenToUse: cutting a release\n---\n# P\n")
        self.assertIn("cutting a release", e.triggers)

    def test_scprism_roles_alias(self):
        e = self._entry("---\nname: n\nmetadata:\n  scprism_roles: reviewer, planner\n---\n# P\n")
        self.assertEqual(sorted(e.roles), ["planner", "reviewer"])


if __name__ == "__main__":
    unittest.main()
