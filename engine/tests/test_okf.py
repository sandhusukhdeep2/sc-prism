"""Tests for OKF v0.1 bundle validation / emission (specs/04 §9, ADR-021)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import okf
from scprism_engine.okf import (
    validate_bundle,
    emit_bundle,
    OKF_VERSION,
    MISSING_TYPE,
    NO_FRONTMATTER,
    BROKEN_LINK,
    EMPTY_BUNDLE,
)


def _write(vault, rel, content):
    path = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def _valid_bundle():
    v = tempfile.mkdtemp()
    _write(v, "index.md", "# Index\nEntry point for progressive disclosure.\n")
    _write(v, "log.md", "# Change log\n- 2026-07-04 created the bundle\n")
    _write(
        v, "adr/adr-004.md",
        "---\ntype: adr\ntitle: GraphRAG\n---\nRelates to [[graphrag]].\n",
    )
    _write(
        v, "kb/graphrag.md",
        "---\ntype: concept\ntitle: GraphRAG\ndescription: graph retrieval\n---\n"
        "GraphRAG concept body.\n",
    )
    return v


class TestValidateBundle(unittest.TestCase):
    def test_conformant_bundle_validates(self):
        res = validate_bundle(_valid_bundle())
        self.assertTrue(res["ok"], res["issues"])
        self.assertEqual(res["issues"], [])
        self.assertEqual(res["okf_version"], OKF_VERSION)
        self.assertEqual(res["doc_count"], 4)

    def test_missing_type_frontmatter_fails_with_issue(self):
        v = _valid_bundle()
        _write(v, "kb/bad.md", "no frontmatter at all here\n")
        res = validate_bundle(v)
        self.assertFalse(res["ok"])
        codes = {i["code"] for i in res["issues"]}
        self.assertIn(NO_FRONTMATTER, codes)

    def test_frontmatter_without_type_fails(self):
        v = _valid_bundle()
        _write(v, "kb/notype.md", "---\ntitle: Missing type\n---\nbody\n")
        res = validate_bundle(v)
        self.assertFalse(res["ok"])
        codes = {i["code"] for i in res["issues"]}
        self.assertIn(MISSING_TYPE, codes)

    def test_reserved_files_exempt_from_type_requirement(self):
        v = tempfile.mkdtemp()
        _write(v, "index.md", "# Index\n")
        _write(v, "log.md", "- 2026-07-04 note\n")
        _write(v, "kb/x.md", "---\ntype: concept\n---\nbody\n")
        res = validate_bundle(v)
        self.assertTrue(res["ok"], res["issues"])

    def test_broken_link_is_a_warning_not_a_failure(self):
        v = _valid_bundle()
        _write(
            v, "kb/dangling.md",
            "---\ntype: concept\n---\nPoints at [[does-not-exist]].\n",
        )
        res = validate_bundle(v)
        self.assertTrue(res["ok"], res["issues"])  # still conformant
        codes = {w["code"] for w in res["warnings"]}
        self.assertIn(BROKEN_LINK, codes)

    def test_empty_bundle_fails(self):
        res = validate_bundle(tempfile.mkdtemp())
        self.assertFalse(res["ok"])
        self.assertEqual(res["issues"][0]["code"], EMPTY_BUNDLE)

    def test_non_directory_fails(self):
        res = validate_bundle("/no/such/vault/path")
        self.assertFalse(res["ok"])


class TestEmitBundle(unittest.TestCase):
    def test_emit_produces_graph_and_types(self):
        bundle = emit_bundle(_valid_bundle())
        self.assertEqual(bundle.version, OKF_VERSION)
        self.assertIn("adr", bundle.types)
        self.assertIn("concept", bundle.types)
        self.assertTrue(bundle.has_index)
        self.assertTrue(bundle.has_log)
        # markdown-link graph edge resolved.
        self.assertIn(("adr/adr-004.md", "kb/graphrag.md"), bundle.edges)

    def test_emit_is_deterministic(self):
        v = _valid_bundle()
        self.assertEqual(emit_bundle(v).to_dict(), emit_bundle(v).to_dict())

    def test_manifest_serialises(self):
        d = emit_bundle(_valid_bundle()).to_dict()
        self.assertEqual(d["okf_version"], OKF_VERSION)
        self.assertEqual(d["doc_count"], 4)
        self.assertIn("docs", d)
        self.assertIn("edges", d)


if __name__ == "__main__":
    unittest.main()


class TestValidatorScope(unittest.TestCase):
    """What the check is FOR (2026-11-11).

    On a real vault the validator reported 81 problems across 79 notes, and
    almost none were knowledge notes: agent and skill definition files (which
    follow their own shared formats and carry no ``type``), deliverables that
    seats wrote into project folders, and the app's own records. The check is
    for knowledge notes. An app-owned folder has a known kind; a project folder
    holds work products.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        _write(self.vault, "notes/idea.md", "---\ntype: note\n---\n\nAn idea.\n")

    def tearDown(self):
        self._tmp.cleanup()

    def _codes(self, result):
        return sorted((i["path"], i["code"]) for i in result["issues"])

    def test_an_agent_definition_needs_no_type_its_folder_says_what_it_is(self):
        _write(self.vault, "agents/planner.md", "---\nname: planner\ndescription: plans\n---\n\nPlan first.\n")
        _write(self.vault, "agents/managers/ops.md", "---\nname: ops\n---\n\nRuns reports.\n")
        r = okf.validate_bundle(self.vault)
        self.assertTrue(r["ok"], r["issues"])

    def test_a_skill_file_keeps_its_own_format(self):
        _write(self.vault, "skills/code-review.md", "---\nname: code-review\ndescription: reviews diffs\n---\n\nRead the diff.\n")
        r = okf.validate_bundle(self.vault)
        self.assertTrue(r["ok"], r["issues"])

    def test_an_agent_file_with_no_frontmatter_or_no_body_is_still_a_problem(self):
        _write(self.vault, "agents/blank.md", "just text\n")
        _write(self.vault, "agents/empty.md", "---\nname: empty\n---\n")
        r = okf.validate_bundle(self.vault)
        self.assertEqual(
            self._codes(r),
            [("agents/blank.md", okf.NO_FRONTMATTER), ("agents/empty.md", okf.EMPTY_DOC)],
        )

    def test_files_in_a_project_folder_are_work_products_not_notes(self):
        _write(self.vault, "projects/site/LAUNCH-PLAN.md", "# Launch plan\n\nShip it.\n")
        _write(self.vault, "projects/site/docs/README.md", "")
        _write(self.vault, "projects/site/report.md", "---\nname: weekly\n---\n\nbody\n")
        r = okf.validate_bundle(self.vault)
        self.assertTrue(r["ok"], r["issues"])
        self.assertEqual(r["work_products"], 3)
        # Counted apart: the notes checked do not include them.
        self.assertEqual(r["doc_count"], 1)

    def test_a_note_may_link_to_a_projects_deliverable(self):
        _write(self.vault, "projects/site/LAUNCH-PLAN.md", "# Launch plan\n")
        _write(self.vault, "notes/pointer.md", "---\ntype: note\n---\n\nSee [[LAUNCH-PLAN]].\n")
        r = okf.validate_bundle(self.vault)
        self.assertEqual(r["warnings"], [])

    def test_the_apps_own_records_have_a_known_kind(self):
        _write(self.vault, "reports/ops/vault-health.md", "All fine.\n")
        _write(self.vault, "conversations/chat-log.md", "**you:** hi\n")
        _write(self.vault, "business/context.md", "# Business context\n")
        _write(self.vault, "governance/README.md", "Rules.\n")
        _write(self.vault, "tools/pdf/history.md", "- tried\n")
        r = okf.validate_bundle(self.vault)
        self.assertTrue(r["ok"], r["issues"])

    def test_a_knowledge_note_is_still_held_to_the_contract(self):
        _write(self.vault, "notes/loose.md", "no frontmatter here\n")
        _write(self.vault, "research/typed-wrong.md", "---\ntitle: x\n---\n\nbody\n")
        r = okf.validate_bundle(self.vault)
        self.assertEqual(
            self._codes(r),
            [("notes/loose.md", okf.NO_FRONTMATTER), ("research/typed-wrong.md", okf.MISSING_TYPE)],
        )

    def test_the_bundle_names_the_kind_a_folder_implies(self):
        _write(self.vault, "agents/planner.md", "---\nname: planner\n---\n\nPlan first.\n")
        _write(self.vault, "skills/code-review.md", "---\nname: code-review\n---\n\nRead the diff.\n")
        bundle = okf.emit_bundle(self.vault)
        types = {d.path: d.type for d in bundle.docs}
        self.assertEqual(types["agents/planner.md"], "agent")
        self.assertEqual(types["skills/code-review.md"], "skill")
        self.assertEqual(types["notes/idea.md"], "note")
