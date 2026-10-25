"""Agentic retrieval — the retrieval SUB-AGENT (specs/04 §8, ADR-018).

Naive RAG runs a fixed linear pipeline; **agentic RAG** lets a small, fast
sub-agent adapt the workflow per query: it inspects the current stage's results,
decides whether the evidence is *sufficient*, and escalates the cascade only
when it is not — stopping early when it is. Retrieval, not generation, is the
dominant failure point, so this is where the investment pays.

Two hard properties, both testable:

  * **Isolated from the main loop.** The orchestrator loop only ever sees the
    assembled context (``AgenticResult.hits``); it never sees the routing /
    escalation logic. This module imports nothing from ``loop``.
  * **The ADR-008 invariant is provable.** The graph stage is gated on the
    routing rule (``retrieval.route``): a non-relationship (single-doc factual)
    query can never be classified for graph, so it never reaches it. The graph
    branch additionally ``assert``s the routed ceiling is GRAPH.

Escalation policy (metric-driven, per specs/04 §3 routing rule):

  * **BM25 sufficient** — a *dominant* single-doc winner for a factual query
    (top score clears the next by a margin). Stop at BM25: one fact, one doc.
  * **Rerank sufficient** — a factual query with no dominant winner gathers its
    2–3 supporting docs at the dense-rerank precision pass and stops there.
  * **Graph** — only a relationship / multi-hop query is ever insufficient at
    BM25 and rerank; it escalates to 1-hop graph traversal and returns the
    linked docs.

Query transform reuses ``context.reformulate`` (specs/04 §4) before the rerank
pass. All model calls (only the optional transform) go through the gateway.
Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .context import ReformulatedQuery, VaultStructure, reformulate
from .retrieval import (
    STAGE_BM25,
    STAGE_GRAPH,
    STAGE_RERANK,
    Hit,
    RetrievalIndex,
    RoutePlan,
    route,
)

# A dominant BM25 winner: the top hit clears the runner-up by this factor. Above
# it, the query is "one fact in one doc" and the cascade stops at BM25.
DOMINANCE = 1.6


@dataclass
class Decision:
    """One sufficiency check the sub-agent made (the adaptive audit trail)."""

    stage: str
    sufficient: bool
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return {"stage": self.stage, "sufficient": self.sufficient, "reason": self.reason}


@dataclass
class AgenticResult:
    """What the sub-agent hands the main loop: assembled context + audit.

    The loop consumes ``hits``; ``decisions`` / ``stages_run`` are the isolated
    reasoning, recorded for the span but never fed back into the main prompt.
    """

    query: str
    stage_reached: str
    hits: List[Hit]
    stages_run: List[str]
    decisions: List[Decision] = field(default_factory=list)
    route: Optional[Dict[str, Any]] = None
    escalated: bool = False
    cache: str = "miss"  # 'miss' | 'hit'
    transformed_query: str = ""

    @property
    def hit_count(self) -> int:
        return len(self.hits)

    @property
    def reached_graph(self) -> bool:
        return STAGE_GRAPH in self.stages_run

    def doc_ids(self) -> List[str]:
        return [h.doc_id for h in self.hits]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "query": self.query,
            "stage_reached": self.stage_reached,
            "stages_run": list(self.stages_run),
            "hit_count": self.hit_count,
            "hits": [h.to_dict() for h in self.hits],
            "decisions": [d.to_dict() for d in self.decisions],
            "route": self.route,
            "escalated": self.escalated,
            "cache": self.cache,
            "reached_graph": self.reached_graph,
        }


def _dominant(hits: List[Hit]) -> bool:
    """A single clear winner: only one hit, or top >= DOMINANCE * runner-up."""
    if not hits:
        return False
    if len(hits) == 1:
        return True
    top, second = hits[0].score, hits[1].score
    if second <= 0.0:
        return True
    return top >= DOMINANCE * second


class RetrievalAgent:
    """The per-query retrieval sub-agent (ADR-018).

    ``retrieve`` drives the cascade adaptively and returns only the assembled
    context. A small in-process cache tracks the hit-rate (reused analogously to
    the gateway's cache stats); the optional ``gateway`` powers the query
    transform's model-assisted rewrite (offline-safe fallback otherwise).
    """

    def __init__(
        self,
        index: RetrievalIndex,
        *,
        gateway: Optional[Any] = None,
        k: int = 5,
        candidate_k: int = 20,
        backend: Optional[str] = None,
    ) -> None:
        self.index = index
        self.gateway = gateway
        self.k = k
        self.candidate_k = candidate_k
        # OPT-IN graph/dense backend selector (default None -> stdlib cascade,
        # unchanged). "lightrag" (or $SCPRISM_LIGHTRAG) routes graph/dense stages
        # through LightRAG when it is importable AND runnable — see
        # lightrag_backend.py. Lazily built on first use.
        self.backend = backend
        self._lightrag_be: Optional[Any] = None
        self._structure: Optional[VaultStructure] = None
        self._cache: Dict[str, AgenticResult] = {}
        self.stats = {"hit": 0, "miss": 0}

    # -- optional LightRAG backend (opt-in; degrades to stdlib) -------------
    def _lightrag(self) -> Optional[Any]:
        """Return an indexed LightRAG backend iff selected AND runnable, else None.

        Pure no-op on the default path: when neither ``backend="lightrag"`` nor
        ``$SCPRISM_LIGHTRAG`` is set, this returns None without importing lightrag.
        """
        from . import lightrag_backend as _lrb  # cheap, import-guarded module

        if not _lrb.lightrag_selected(self.backend) or not _lrb.lightrag_available():
            return None
        if self._lightrag_be is None:
            self._lightrag_be = _lrb.LightRAGBackend.from_index(
                self.gateway, self.index
            )
        return self._lightrag_be

    # -- cache hit-rate (mirrors the gateway's cache-warmth view) ----------
    @property
    def hit_rate(self) -> float:
        total = self.stats["hit"] + self.stats["miss"]
        return (self.stats["hit"] / total) if total else 0.0

    def _transform(self, query: str) -> ReformulatedQuery:
        if self._structure is None:
            self._structure = self.index.vault_structure()
        # Query transform (specs/04 §4) — reuse context.reformulate; the gateway
        # is passed through for the optional model-assisted rewrite.
        return reformulate(query, self._structure, gateway=self.gateway)

    def retrieve(
        self, query: str, *, k: Optional[int] = None
    ) -> AgenticResult:
        """Adaptively retrieve context for ``query`` and return only the hits.

        Escalates BM25 -> rerank -> graph, stopping the moment the current
        stage's evidence is sufficient. Graph is reachable only for relationship
        queries (ADR-008 invariant, asserted below).
        """
        k = k or self.k

        # OPT-IN: delegate graph/dense stages to LightRAG when selected+runnable.
        # No-op (returns None) on the default path, so the stdlib cascade below
        # is completely unchanged.
        be = self._lightrag()
        if be is not None:
            return be.agentic_result(query, k=k)

        cache_key = f"{k}:{query.strip().lower()}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            self.stats["hit"] += 1
            hit = AgenticResult(**{**cached.__dict__})
            hit.cache = "hit"
            return hit
        self.stats["miss"] += 1

        plan: RoutePlan = route(query, self.index)
        stages_run: List[str] = []
        decisions: List[Decision] = []

        # --- Stage 1: BM25 -------------------------------------------------
        bm25_hits = self.index.bm25(query, k=self.candidate_k)
        stages_run.append(STAGE_BM25)

        if not plan.is_relationship and _dominant(bm25_hits):
            decisions.append(
                Decision(STAGE_BM25, True, "dominant single-doc winner — one fact, one doc")
            )
            res = self._finish(
                query, STAGE_BM25, bm25_hits[:k], stages_run, decisions, plan,
                escalated=False, transformed="",
            )
            self._cache[cache_key] = res
            return res
        decisions.append(
            Decision(
                STAGE_BM25,
                False,
                "relationship query — needs the graph"
                if plan.is_relationship
                else "no dominant winner — need a precision pass over candidates",
            )
        )

        # --- Stage 2: dense rerank (+ query transform) --------------------
        tq = self._transform(query)
        candidate_ids = [h.doc_id for h in bm25_hits] or self.index.doc_ids
        rer_hits = self.index.rerank(tq.text or query, candidate_ids, k=self.candidate_k)
        stages_run.append(STAGE_RERANK)

        if not plan.is_relationship:
            # A factual query never escalates past rerank (ADR-008 invariant):
            # the 2–3 supporting docs are assembled here.
            decisions.append(
                Decision(STAGE_RERANK, True, "factual query — 2–3 docs gathered; graph forbidden")
            )
            res = self._finish(
                query, STAGE_RERANK, rer_hits[:k], stages_run, decisions, plan,
                escalated=True, transformed=tq.text,
            )
            self._cache[cache_key] = res
            return res
        decisions.append(
            Decision(STAGE_RERANK, False, "relationship query still unresolved — escalate to graph")
        )

        # --- Stage 3: graph traversal (relationship queries ONLY) ---------
        assert plan.is_relationship and plan.max_stage == STAGE_GRAPH, (
            "graph stage reached for a non-relationship query — ADR-008 violated"
        )
        seeds = [h.doc_id for h in rer_hits[:5]] or [h.doc_id for h in bm25_hits[:5]]
        graph_hits = self.index.graph_retrieve(seeds, tq.text or query, k=k)
        stages_run.append(STAGE_GRAPH)
        decisions.append(
            Decision(STAGE_GRAPH, True, "1-hop neighbour subgraph reranked — linked docs returned")
        )
        res = self._finish(
            query, STAGE_GRAPH, graph_hits, stages_run, decisions, plan,
            escalated=True, transformed=tq.text,
        )
        self._cache[cache_key] = res
        return res

    def _finish(
        self,
        query: str,
        stage_reached: str,
        hits: List[Hit],
        stages_run: List[str],
        decisions: List[Decision],
        plan: RoutePlan,
        *,
        escalated: bool,
        transformed: str,
    ) -> AgenticResult:
        return AgenticResult(
            query=query,
            stage_reached=stage_reached,
            hits=list(hits),
            stages_run=list(stages_run),
            decisions=list(decisions),
            route=plan.to_dict(),
            escalated=escalated,
            cache="miss",
            transformed_query=transformed,
        )
