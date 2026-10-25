"""Tests for the retrieval cascade (knowledge layer, specs/04, ADR-008)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.retrieval import (
    Cascade,
    RetrievalIndex,
    default_index_path,
    is_relationship_query,
    route,
    STAGE_BM25,
    STAGE_RERANK,
    STAGE_GRAPH,
)


def _write(vault, rel, content):
    path = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def _build_vault():
    """A small linked vault: three concepts + a policy with a unique fact."""
    v = tempfile.mkdtemp()
    _write(v, "index.md", "# Index\nProgressive disclosure entry point.\n")
    _write(v, "log.md", "# Log\n- 2026-07-04 initial bundle\n")
    _write(
        v,
        "adr/adr-004.md",
        "---\ntype: adr\ntitle: GraphRAG depth\n---\n"
        "ADR-004 chooses full GraphRAG. It relates to [[graphrag]].\n",
    )
    _write(
        v,
        "kb/graphrag.md",
        "---\ntype: concept\ntitle: GraphRAG\n---\n"
        "GraphRAG builds a knowledge graph from documents. See [[cascade]].\n",
    )
    _write(
        v,
        "kb/cascade.md",
        "---\ntype: concept\ntitle: Retrieval Cascade\n---\n"
        "The retrieval cascade escalates bm25 rerank graph across stages.\n",
    )
    _write(
        v,
        "policies/budget.md",
        "---\ntype: policy\ntitle: Token Budget\nmax_tokens: 5000\n---\n"
        "The token budget ceiling is fixed at five thousand zorblats uniquely here.\n",
    )
    return v


class TestBM25(unittest.TestCase):
    def test_bm25_ranks_the_right_doc_first(self):
        idx = RetrievalIndex.build(_build_vault())
        hits = idx.bm25("token budget ceiling zorblats")
        self.assertTrue(hits)
        self.assertEqual(hits[0].doc_id, "policies/budget.md")

    def test_bm25_ranks_concept_query(self):
        idx = RetrievalIndex.build(_build_vault())
        hits = idx.bm25("knowledge graph documents")
        self.assertEqual(hits[0].doc_id, "kb/graphrag.md")

    def test_bm25_empty_query_returns_nothing(self):
        idx = RetrievalIndex.build(_build_vault())
        self.assertEqual(idx.bm25("the and of"), [])


class TestRerank(unittest.TestCase):
    def test_rerank_scores_are_cosine_bounded(self):
        idx = RetrievalIndex.build(_build_vault())
        hits = idx.rerank("retrieval cascade stages", idx.doc_ids)
        self.assertTrue(hits)
        for h in hits:
            self.assertGreaterEqual(h.score, 0.0)
            self.assertLessEqual(h.score, 1.0 + 1e-9)
            self.assertEqual(h.stage, STAGE_RERANK)
        self.assertEqual(hits[0].doc_id, "kb/cascade.md")


class TestGraph(unittest.TestCase):
    def test_graph_built_from_markdown_links(self):
        idx = RetrievalIndex.build(_build_vault())
        # [[graphrag]] link from adr-004 resolved to kb/graphrag.md.
        self.assertIn("kb/graphrag.md", idx.out_edges["adr/adr-004.md"])
        # back-link recorded.
        self.assertIn("adr/adr-004.md", idx.in_edges["kb/graphrag.md"])

    def test_neighbors_are_1_hop_both_directions(self):
        idx = RetrievalIndex.build(_build_vault())
        nb = idx.neighbors("kb/graphrag.md")
        self.assertIn("adr/adr-004.md", nb)  # back-link
        self.assertIn("kb/cascade.md", nb)   # out-link

    def test_graph_retrieve_returns_linked_docs(self):
        idx = RetrievalIndex.build(_build_vault())
        hits = idx.graph_retrieve(["adr/adr-004.md"], "graphrag cascade")
        ids = {h.doc_id for h in hits}
        self.assertIn("kb/graphrag.md", ids)  # 1-hop neighbour surfaced
        for h in hits:
            self.assertEqual(h.stage, STAGE_GRAPH)


class TestRouting(unittest.TestCase):
    def test_relationship_query_detected(self):
        self.assertTrue(is_relationship_query("how does X relate to Y"))
        self.assertTrue(is_relationship_query("trace the dependency chain"))
        self.assertFalse(is_relationship_query("what is the token budget"))

    def test_route_gates_graph_on_relationship(self):
        self.assertEqual(route("what is the budget").max_stage, STAGE_RERANK)
        self.assertEqual(route("how are these connected").max_stage, STAGE_GRAPH)

    def test_single_doc_factual_never_reaches_graph_via_cascade(self):
        idx = RetrievalIndex.build(_build_vault())
        res = Cascade(idx).run("token budget ceiling zorblats")
        self.assertNotIn(STAGE_GRAPH, res.stages_run)
        self.assertNotEqual(res.stage_reached, STAGE_GRAPH)

    def test_relationship_query_reaches_graph_via_cascade(self):
        idx = RetrievalIndex.build(_build_vault())
        res = Cascade(idx).run("how does adr-004 relate to graphrag")
        self.assertEqual(res.stage_reached, STAGE_GRAPH)
        self.assertIn(STAGE_GRAPH, res.stages_run)


class TestRebuildable(unittest.TestCase):
    """The vault is the source of truth; the index is disposable + rebuildable."""

    def test_delete_index_rebuild_same_results(self):
        v = _build_vault()
        idx1 = RetrievalIndex.open(v)  # builds + caches
        path = default_index_path(v)
        self.assertTrue(os.path.isfile(path))
        r1 = [h.doc_id for h in idx1.bm25("graphrag cascade budget")]

        os.remove(path)  # delete the derived index
        self.assertFalse(os.path.isfile(path))

        idx2 = RetrievalIndex.open(v, rebuild=True)  # rebuild from the vault
        self.assertTrue(os.path.isfile(path))
        r2 = [h.doc_id for h in idx2.bm25("graphrag cascade budget")]
        self.assertEqual(r1, r2)

    def test_loaded_index_matches_built_index(self):
        v = _build_vault()
        built = RetrievalIndex.build(v)
        path = built.save(default_index_path(v))
        loaded = RetrievalIndex.load(path)
        self.assertEqual(built.doc_ids, loaded.doc_ids)
        q = "retrieval cascade graph"
        self.assertEqual(
            [h.doc_id for h in built.bm25(q)],
            [h.doc_id for h in loaded.bm25(q)],
        )
        self.assertEqual(built.out_edges, loaded.out_edges)


if __name__ == "__main__":
    unittest.main()
