"""Tests for the OPT-IN LightRAG graph/dense backend
(engine/scprism_engine/lightrag_backend.py, ADR-025).

LightRAG is installed ONLY in engine/.venv-rag (opt-in), AND — even when
installed — it is not *runnable* on Python 3.9 (its default storage backends use
PEP 604 ``X | None`` unions at class-definition time, a 3.10+ feature). So under
the system python that runs `python3 -m unittest discover -s engine/tests` these
tests SKIP cleanly, keeping the suite green.

To run them you need BOTH lightrag installed AND Python >= 3.10:

    # 1. create the isolated venv (kept out of engine/.venv which holds deepeval):
    cd <repository root>
    python3 -m venv engine/.venv-rag
    engine/.venv-rag/bin/pip install "lightrag-hku"

    # 2. run just these tests through the venv python:
    engine/.venv-rag/bin/python -m unittest discover -s engine/tests -p "test_lightrag.py"

If that interpreter is still Python 3.9, the module SKIPS with a clear reason
(``lightrag_available()`` is False) — LightRAG cannot run there. On a >=3.10
interpreter with lightrag installed the tests execute for real: indexing a small
vault, retrieving results, and proving the LLM/embedding calls route through a
spy gateway (never a direct provider/network call).
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import lightrag_backend
from scprism_engine.gateway import Gateway
from scprism_engine.retrieval import (
    Cascade,
    RetrievalIndex,
    STAGE_GRAPH,
    STAGE_RERANK,
)
from scprism_engine.agentic_retrieval import RetrievalAgent


# ---------------------------------------------------------------------------
# Skip-agnostic tests: these run under EVERY interpreter (incl. system python
# without lightrag). They prove the opt-in seam and the default path.
# ---------------------------------------------------------------------------
class TestOptInSelection(unittest.TestCase):
    """Pure selection logic — no lightrag import required."""

    def test_env_flag_selects_lightrag(self):
        self.assertTrue(lightrag_backend.lightrag_enabled(env={"SCPRISM_LIGHTRAG": "1"}))
        self.assertFalse(lightrag_backend.lightrag_enabled(env={}))

    def test_backend_arg_precedence_over_env(self):
        # Explicit arg wins over the env flag (mirrors the deepeval backend).
        self.assertTrue(lightrag_backend.lightrag_selected("lightrag", env={}))
        self.assertFalse(
            lightrag_backend.lightrag_selected("stdlib", env={"SCPRISM_LIGHTRAG": "1"})
        )
        self.assertTrue(
            lightrag_backend.lightrag_selected(None, env={"SCPRISM_LIGHTRAG": "1"})
        )
        self.assertFalse(lightrag_backend.lightrag_selected(None, env={}))


def _write(vault, rel, content):
    path = os.path.join(vault, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def _build_vault():
    """The same small linked vault shape used by test_retrieval."""
    v = tempfile.mkdtemp()
    _write(v, "index.md", "# Index\nProgressive disclosure entry point.\n")
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
        "---\ntype: policy\ntitle: Token Budget\n---\n"
        "The token budget ceiling is fixed at five thousand zorblats uniquely here.\n",
    )
    return v


class TestDefaultPathUnchangedWhenLightRAGNotSelected(unittest.TestCase):
    """With no opt-in, the stdlib cascade must be used verbatim — even if the
    LightRAG backend happens to be runnable in this interpreter."""

    def test_cascade_default_is_stdlib(self):
        idx = RetrievalIndex.build(_build_vault())
        # No backend arg, no env flag -> stdlib cascade.
        res = Cascade(idx).run("token budget ceiling zorblats")
        self.assertIn(res.stage_reached, (STAGE_RERANK, "bm25"))
        self.assertNotEqual(
            res.reason, "lightrag backend (graph/dense stages served by LightRAG)"
        )

    def test_agent_default_is_stdlib(self):
        idx = RetrievalIndex.build(_build_vault())
        agent = RetrievalAgent(idx)
        res = agent.retrieve("token budget ceiling zorblats")
        # stdlib agent records adaptive decisions; the lightrag path records one.
        self.assertTrue(res.decisions)
        self.assertNotEqual(res.stages_run, [STAGE_GRAPH])  # dominant fact stops early


# ---------------------------------------------------------------------------
# Everything below needs lightrag importable AND runnable in THIS interpreter
# (Python >= 3.10 with lightrag installed). Each class is gated with
# ``skipUnless`` so it SKIPS cleanly under system python (keeping the suite
# green) while the interpreter-agnostic tests above always run.
# ---------------------------------------------------------------------------
_LR_REASON = (
    "LightRAG not runnable in this interpreter (needs Python >= 3.10 with "
    "lightrag-hku installed; run via engine/.venv-rag/bin/python). "
    f"import_error={lightrag_backend.import_error()!r} "
    f"runnable_error={lightrag_backend.runnable_error()!r}"
)
_requires_lightrag = unittest.skipUnless(
    lightrag_backend.lightrag_available(), _LR_REASON
)


class _SpyGateway(Gateway):
    """Records every model_call so we can prove LightRAG's LLM routes through
    the gateway (never a direct provider/SDK call)."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.calls = []

    def model_call(self, messages, route):
        self.calls.append(messages)
        return super().model_call(messages, route)


def _offline_spy_gateway():
    # Unreachable endpoint + empty env -> deterministic offline stub only.
    return _SpyGateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


@_requires_lightrag
class TestLightRAGIndexesAndRetrieves(unittest.TestCase):
    def setUp(self):
        self._wd = tempfile.mkdtemp()
        self.vault = _build_vault()

    def _backend(self, gw):
        be = lightrag_backend.LightRAGBackend(gw, working_dir=self._wd)
        # Guarantee teardown even if an assertion fails mid-test, so no LightRAG
        # loop/worker survives to raise pending-task errors at interpreter exit.
        self.addCleanup(be.close)
        return be

    def test_requires_a_gateway(self):
        with self.assertRaises(ValueError):
            lightrag_backend.LightRAGBackend(None, working_dir=self._wd)

    def test_index_and_retrieve_returns_hits(self):
        gw = _offline_spy_gateway()
        be = self._backend(gw).index_vault(self.vault)
        hits = be.retrieve("token budget zorblats", k=5)
        # Same Hit shape as the stdlib cascade.
        self.assertTrue(hits, "LightRAG must return at least one hit")
        for h in hits:
            self.assertTrue(h.doc_id.endswith(".md"))
            self.assertGreaterEqual(h.score, 0.0)
        be.close()

    def test_all_calls_route_through_the_gateway_no_direct_network(self):
        gw = _offline_spy_gateway()
        be = self._backend(gw).index_vault(self.vault)
        be.retrieve("how does adr-004 relate to graphrag", k=5)
        # LightRAG's LLM reached a model ONLY through the gateway.
        self.assertTrue(gw.calls, "LightRAG LLM must call gateway.model_call")
        self.assertGreater(be.llm.calls, 0)
        # Offline stub -> no real provider was hit (proves no direct network).
        self.assertFalse(be.llm.saw_real)
        # Embedding also went through the gateway-owned embedding path.
        self.assertGreater(be.embedding.calls, 0)
        be.close()

    def test_shape_matches_cascade_result(self):
        gw = _offline_spy_gateway()
        be = self._backend(gw).index_vault(self.vault)
        res = be.cascade_result("token budget zorblats", k=5)
        d = res.to_dict()
        # Identical shape to retrieval.CascadeResult.to_dict().
        for key in ("query", "stage_reached", "stages_run", "hits", "route"):
            self.assertIn(key, d)
        be.close()

    def test_factual_query_never_labelled_graph(self):
        """ADR-008 invariant preserved: a factual query uses dense (naive) mode
        and is never labelled GRAPH."""
        gw = _offline_spy_gateway()
        be = self._backend(gw).index_vault(self.vault)
        mode, stage = be._mode_and_stage("what is the token budget", None)
        self.assertEqual(mode, "naive")
        self.assertEqual(stage, STAGE_RERANK)
        mode2, stage2 = be._mode_and_stage("how does adr-004 relate to graphrag", None)
        self.assertEqual(mode2, "hybrid")
        self.assertEqual(stage2, STAGE_GRAPH)
        be.close()


@_requires_lightrag
class TestOptInWiringWithLightRAG(unittest.TestCase):
    def setUp(self):
        # The Cascade / RetrievalAgent build their LightRAGBackend via
        # ``from_index`` (no working_dir override), so it lands in the shared
        # default dir. Start each test from a clean one: otherwise LightRAG's
        # doc-status dedup sees the identical vault already indexed by a prior
        # test and skips extraction entirely — so no LLM call reaches the spy
        # gateway and ``gw.calls`` is empty.
        import shutil

        shutil.rmtree(lightrag_backend._DEFAULT_WORKING_DIR, ignore_errors=True)
        self.addCleanup(
            shutil.rmtree, lightrag_backend._DEFAULT_WORKING_DIR, ignore_errors=True
        )

    def _close_lightrag(self, holder):
        # The Cascade / RetrievalAgent build (and cache) a LightRAGBackend on
        # first use but never close it — close it here so its persistent loop and
        # worker tasks are torn down cleanly (no pending-task noise at exit).
        be = getattr(holder, "_lightrag_be", None)
        if be is not None:
            be.close()

    def test_cascade_backend_arg_uses_lightrag(self):
        idx = RetrievalIndex.build(_build_vault())
        gw = _offline_spy_gateway()
        cas = Cascade(idx, gateway=gw, backend="lightrag")
        self.addCleanup(self._close_lightrag, cas)
        res = cas.run("token budget zorblats")
        self.assertEqual(
            res.reason, "lightrag backend (graph/dense stages served by LightRAG)"
        )
        self.assertTrue(gw.calls)

    def test_agent_backend_arg_uses_lightrag(self):
        idx = RetrievalIndex.build(_build_vault())
        gw = _offline_spy_gateway()
        agent = RetrievalAgent(idx, gateway=gw, backend="lightrag")
        self.addCleanup(self._close_lightrag, agent)
        res = agent.retrieve("token budget zorblats")
        self.assertEqual(len(res.decisions), 1)
        self.assertIn("lightrag", res.decisions[0].reason)
        self.assertTrue(gw.calls)


if __name__ == "__main__":
    unittest.main()
