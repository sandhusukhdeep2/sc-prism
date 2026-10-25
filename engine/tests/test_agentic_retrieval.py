"""Tests for the agentic retrieval sub-agent (specs/04 §8, ADR-018)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.retrieval import RetrievalIndex, STAGE_BM25, STAGE_RERANK, STAGE_GRAPH
from scprism_engine.agentic_retrieval import RetrievalAgent


def _write(vault, rel, content):
    path = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def _vault():
    v = tempfile.mkdtemp()
    _write(
        v, "adr/adr-004.md",
        "---\ntype: adr\ntitle: GraphRAG depth\n---\n"
        "ADR-004 chooses full GraphRAG. It relates to [[graphrag]].\n",
    )
    _write(
        v, "kb/graphrag.md",
        "---\ntype: concept\ntitle: GraphRAG\n---\n"
        "GraphRAG builds a knowledge graph. See [[cascade]].\n",
    )
    _write(
        v, "kb/cascade.md",
        "---\ntype: concept\ntitle: Retrieval Cascade\n---\n"
        "The retrieval cascade escalates bm25 rerank graph.\n",
    )
    _write(
        v, "policies/budget.md",
        "---\ntype: policy\ntitle: Token Budget\nmax_tokens: 5000\n---\n"
        "The token budget ceiling is fixed at five thousand zorblats uniquely.\n",
    )
    return v


class TestAgenticEscalation(unittest.TestCase):
    def setUp(self):
        self.idx = RetrievalIndex.build(_vault())
        self.agent = RetrievalAgent(self.idx)

    def test_stops_early_when_sufficient(self):
        """A dominant single-doc factual query stops at BM25 — no escalation."""
        res = self.agent.retrieve("zorblats ceiling uniquely")
        self.assertEqual(res.stage_reached, STAGE_BM25)
        self.assertEqual(res.stages_run, [STAGE_BM25])
        self.assertFalse(res.escalated)
        self.assertEqual(res.hits[0].doc_id, "policies/budget.md")
        # The sufficiency decision is recorded (the isolated audit trail).
        self.assertTrue(res.decisions[0].sufficient)

    def test_single_doc_factual_never_reaches_graph(self):
        """PROVABLE invariant: a factual query is never routed to the graph."""
        for q in [
            "zorblats ceiling uniquely",
            "graphrag knowledge graph",     # non-dominant factual
            "retrieval cascade bm25 rerank",
            "token budget policy",
        ]:
            res = self.agent.retrieve(q)
            self.assertFalse(
                res.reached_graph, f"factual query wrongly reached graph: {q!r}"
            )
            self.assertNotIn(STAGE_GRAPH, res.stages_run)
            self.assertEqual(res.route["max_stage"], STAGE_RERANK)

    def test_escalates_when_not_sufficient(self):
        """A factual query with no dominant winner escalates BM25 -> rerank."""
        res = self.agent.retrieve("graphrag cascade concept")
        self.assertEqual(res.stage_reached, STAGE_RERANK)
        self.assertIn(STAGE_RERANK, res.stages_run)
        self.assertNotIn(STAGE_GRAPH, res.stages_run)
        self.assertTrue(res.escalated)

    def test_relationship_query_escalates_to_graph_and_returns_linked_docs(self):
        res = self.agent.retrieve("how does adr-004 relate to graphrag and the cascade")
        self.assertEqual(res.stage_reached, STAGE_GRAPH)
        self.assertEqual(res.stages_run, [STAGE_BM25, STAGE_RERANK, STAGE_GRAPH])
        ids = set(res.doc_ids())
        # Linked docs reached only via 1-hop graph traversal from the seeds.
        self.assertIn("kb/graphrag.md", ids)
        self.assertIn("kb/cascade.md", ids)

    def test_main_loop_sees_only_assembled_context(self):
        """Isolation: the result exposes hits; routing stays internal."""
        res = self.agent.retrieve("how do these connect")
        # The hits are the assembled context handed up.
        self.assertTrue(hasattr(res, "hits"))
        # Decisions/route are recorded but are not part of the hit payload.
        for h in res.hits:
            self.assertFalse(hasattr(h, "decisions"))


class TestAgenticCache(unittest.TestCase):
    def test_cache_hit_rate_tracked(self):
        idx = RetrievalIndex.build(_vault())
        agent = RetrievalAgent(idx)
        r1 = agent.retrieve("token budget zorblats")
        self.assertEqual(r1.cache, "miss")
        r2 = agent.retrieve("token budget zorblats")
        self.assertEqual(r2.cache, "hit")
        # Same assembled context on the cached path.
        self.assertEqual(r1.doc_ids(), r2.doc_ids())
        self.assertGreater(agent.hit_rate, 0.0)
        self.assertEqual(agent.stats, {"hit": 1, "miss": 1})


if __name__ == "__main__":
    unittest.main()
