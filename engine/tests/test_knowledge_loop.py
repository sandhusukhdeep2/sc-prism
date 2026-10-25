"""Integration: the retrieval cascade wired into the Orchestrator loop (E4)."""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.retrieval import RetrievalIndex, STAGE_BM25, STAGE_GRAPH
from scprism_engine.agentic_retrieval import RetrievalAgent
from scprism_engine.telemetry import read_spans


def _write(vault, rel, content):
    path = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


class TestKnowledgeLoopWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        _write(
            self.vault, "adr/adr-004.md",
            "---\ntype: adr\ntitle: GraphRAG\n---\nRelates to [[graphrag]].\n",
        )
        _write(
            self.vault, "kb/graphrag.md",
            "---\ntype: concept\ntitle: GraphRAG\n---\nGraph over docs. See [[cascade]].\n",
        )
        _write(
            self.vault, "kb/cascade.md",
            "---\ntype: concept\ntitle: Cascade\n---\nThe retrieval cascade escalates stages.\n",
        )
        _write(
            self.vault, "policies/budget.md",
            "---\ntype: policy\ntitle: Budget\nmax_tokens: 5000\n---\n"
            "The token budget ceiling is five thousand zorblats uniquely.\n",
        )
        self.idx = RetrievalIndex.build(self.vault)

    def tearDown(self):
        self._tmp.cleanup()

    def _spans(self):
        return read_spans(os.path.join(self.vault, "spans.jsonl"))

    def test_loop_emits_retrieval_span_with_stage_and_hits(self):
        agent = RetrievalAgent(self.idx)
        contract = parse("summarize the token budget ceiling", task_id="t-know")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            retriever=agent,
        )
        self.assertTrue(verdict.passed)
        spans = self._spans()
        retr = [s for s in spans if s["name"] == "retrieval"]
        self.assertEqual(len(retr), 1)
        attrs = retr[0]["attrs"]
        self.assertIn("stage_reached", attrs)
        self.assertIn("hits", attrs)
        self.assertIn("cache", attrs)
        self.assertIn("hit_rate", attrs)
        # A factual query never graphs, even wired into the loop.
        self.assertFalse(attrs["reached_graph"])

    def test_loop_without_retriever_is_unchanged(self):
        contract = parse("summarize the config", task_id="t-none")
        verdict = run(contract, vault=self.vault, tier1_commands=["true"])
        self.assertTrue(verdict.passed)
        spans = self._spans()
        self.assertEqual([s for s in spans if s["name"] == "retrieval"], [])

    def test_relationship_query_graphs_in_loop(self):
        agent = RetrievalAgent(self.idx)
        contract = parse(
            "explain how adr-004 relates to graphrag and the cascade", task_id="t-rel"
        )
        run(contract, vault=self.vault, tier1_commands=["true"], retriever=agent)
        retr = [s for s in self._spans() if s["name"] == "retrieval"]
        self.assertEqual(retr[0]["attrs"]["stage_reached"], STAGE_GRAPH)
        self.assertTrue(retr[0]["attrs"]["reached_graph"])

    def test_retrieved_context_respects_budget(self):
        agent = RetrievalAgent(self.idx)
        contract = parse("token budget ceiling zorblats", task_id="t-budget")
        # A tiny budget must still never be exceeded (assert lives in the loop).
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            retriever=agent,
            memory_budget=5,
        )
        self.assertTrue(verdict.passed)


if __name__ == "__main__":
    unittest.main()
