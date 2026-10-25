"""Tests for OKF v0.1 bundle validation / emission (specs/04 §9, ADR-021)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

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
