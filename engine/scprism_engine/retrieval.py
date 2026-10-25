"""Knowledge layer — the retrieval CASCADE over the markdown vault (specs/04,
ADR-004/008/021).

The vault is the single source of truth; every index here is **derived and
fully rebuildable** from it (delete the index, rebuild, identical results). The
cascade is three stages, escalating only when the routing rule demands it
(ADR-008) — most queries never reach the graph:

  1. **grep + BM25** — real BM25 ranking over vault docs (tokenize, IDF, term
     saturation ``k1``/length norm ``b``). Lexical recall; the cheap common case.
  2. **dense rerank** — a real TF-IDF cosine reranker over the BM25 candidate
     set (stdlib). ``DenseBackend`` is the seam a real embedding model plugs into
     later (ADR-025); the TF-IDF backend is the offline default.
  3. **graph traversal** — build the graph from the vault's **markdown-link
     structure** (``[[wikilinks]]``, ``[](links.md)``, frontmatter refs); for
     multi-hop / relationship queries ONLY: 1-hop neighbour subgraph → rerank.
     Incremental / rebuildable. LightRAG/GraphRAG are pluggable graph backends.

**Routing rule (ADR-008), enforced + provable here:** a relationship / multi-hop
query may escalate to the graph; any other query tops out at rerank. Therefore a
**single-doc factual query NEVER reaches the graph** — ``route`` gates the graph
stage strictly on ``is_relationship_query`` and ``Cascade.run`` asserts it.

Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from typing import (
    Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple,
)

from .context import VaultStructure

# ---------------------------------------------------------------------------
# Cascade stages (ordered).
# ---------------------------------------------------------------------------
STAGE_BM25 = "bm25"
STAGE_RERANK = "rerank"
STAGE_GRAPH = "graph"
STAGES = (STAGE_BM25, STAGE_RERANK, STAGE_GRAPH)
_STAGE_RANK = {s: i for i, s in enumerate(STAGES)}


# Machine-written trees that are NOT part of the knowledge bundle.
_SKIP_DIRS = ("verdicts", ".scprism", ".git")

_INDEX_REL = os.path.join(".scprism", "retrieval.json")

# BM25 hyper-parameters (standard Okapi defaults).
BM25_K1 = 1.5
BM25_B = 0.75

# Query terms shorter than this or in the stoplist add lexical noise, not recall.
_STOPWORDS = {
    "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "is", "are",
    "how", "what", "does", "do", "with", "that", "this", "it", "its", "as",
    "at", "by", "be", "from", "into", "across", "between",  # (relationship
    # signals are detected separately from raw text, so dropping them here is safe)
}


def tokenize(text: str) -> List[str]:
    """Lowercase alphanumeric tokenizer, stopwords dropped (shared by every
    stage so query and document tokens are directly comparable)."""
    return [
        t
        for t in re.findall(r"[a-z0-9]+", (text or "").lower())
        if t not in _STOPWORDS and len(t) > 1
    ]


# ---------------------------------------------------------------------------
# Relationship / multi-hop detection — the graph gate (ADR-008).
# ---------------------------------------------------------------------------
# A query that asks how things RELATE / CONNECT / DEPEND spans documents and
# their links; only these may reach the graph stage. Everything else is a fact
# lookup and tops out at rerank. This list is the whole basis of the invariant
# "a single-doc factual query never reaches the graph".
_RELATIONSHIP_SIGNALS = (
    "relate", "related", "relationship", "relationships",
    "connect", "connected", "connection",
    "depend", "depends", "depended", "dependency", "dependencies",
    "link", "linked", "links",
    "trace", "chain", "path",
    "impact", "impacts", "affect", "affects", "affected",
    "supersede", "supersedes", "superseded",
    "reference", "references", "referenced",
    "between", "across", "flow", "lineage", "downstream", "upstream",
    "how are", "how do", "what links", "what connects",
)


def is_relationship_query(query: str) -> bool:
    """True iff the query asks about relationships / multi-hop reasoning across
    documents (the only class permitted to escalate to graph traversal)."""
    low = (query or "").lower()
    return any(sig in low for sig in _RELATIONSHIP_SIGNALS)


# ---------------------------------------------------------------------------
# Documents & hits.
# ---------------------------------------------------------------------------
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
_MDLINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_LINK_FM_KEYS = ("resource", "refs", "related", "see_also", "links", "supersedes")


@dataclass
class Doc:
    """One vault concept file (the file path IS the concept identity, OKF §9)."""

    doc_id: str          # vault-relative path, e.g. "adr/adr-004.md"
    type: str
    title: str
    body: str
    links: List[str] = field(default_factory=list)       # resolved out-edges
    raw_links: List[str] = field(default_factory=list)   # unresolved targets

    def to_dict(self) -> Dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "type": self.type,
            "title": self.title,
            "body": self.body,
            "links": list(self.links),
            "raw_links": list(self.raw_links),
        }


@dataclass
class Hit:
    """One retrieval result with the stage that produced its score."""

    doc_id: str
    score: float
    stage: str
    title: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "score": round(self.score, 6),
            "stage": self.stage,
            "title": self.title,
        }


# ---------------------------------------------------------------------------
# Dense backend seam (TF-IDF now; embeddings later — ADR-025).
# ---------------------------------------------------------------------------
class DenseBackend:
    """Interface a real dense/embedding reranker plugs into later.

    The default implementation is stdlib TF-IDF cosine (below). A production
    embedding model implements the same two methods and drops in unchanged.
    """

    def vectorize(self, terms: Sequence[str]) -> Dict[str, float]:  # pragma: no cover
        raise NotImplementedError

    @staticmethod
    def cosine(a: Mapping[str, float], b: Mapping[str, float]) -> float:  # pragma: no cover
        raise NotImplementedError


def _cosine(a: Mapping[str, float], b: Mapping[str, float]) -> float:
    if not a or not b:
        return 0.0
    # iterate the smaller vector.
    if len(a) > len(b):
        a, b = b, a
    dot = sum(w * b.get(t, 0.0) for t, w in a.items())
    if dot == 0.0:
        return 0.0
    na = math.sqrt(sum(w * w for w in a.values()))
    nb = math.sqrt(sum(w * w for w in b.values()))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# The rebuildable index.
# ---------------------------------------------------------------------------
class RetrievalIndex:
    """A derived, fully-rebuildable index over the markdown vault.

    Holds the parsed docs, the BM25 statistics (df / idf / per-doc term
    frequencies / lengths), and the markdown-link graph. Everything is a pure
    function of the vault on disk, so ``build`` is deterministic and the on-disk
    cache (``save``/``load``) can be deleted and regenerated identically.
    """

    def __init__(self, docs: Sequence[Doc]) -> None:
        self.docs: Dict[str, Doc] = {d.doc_id: d for d in docs}
        self.doc_ids: List[str] = sorted(self.docs)

        # -- BM25 statistics ------------------------------------------------
        self.tf: Dict[str, Dict[str, int]] = {}
        self.doc_len: Dict[str, int] = {}
        df: Dict[str, int] = {}
        for doc_id in self.doc_ids:
            toks = tokenize(self.docs[doc_id].title + " " + self.docs[doc_id].body)
            counts: Dict[str, int] = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            self.tf[doc_id] = counts
            self.doc_len[doc_id] = len(toks)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        self.df = df
        n = max(1, len(self.doc_ids))
        self.n_docs = len(self.doc_ids)
        self.avgdl = (sum(self.doc_len.values()) / n) if self.doc_ids else 0.0
        # Okapi BM25 idf, floored at 0 (never negative for very common terms).
        self.idf: Dict[str, float] = {
            t: max(0.0, math.log(1.0 + (n - d + 0.5) / (d + 0.5)))
            for t, d in df.items()
        }
        # Cache of per-doc TF-IDF vectors for the dense reranker.
        self._tfidf_cache: Dict[str, Dict[str, float]] = {}

        # -- markdown-link graph -------------------------------------------
        self.out_edges: Dict[str, Set[str]] = {i: set() for i in self.doc_ids}
        self.in_edges: Dict[str, Set[str]] = {i: set() for i in self.doc_ids}
        for doc_id in self.doc_ids:
            for tgt in self.docs[doc_id].links:
                if tgt in self.docs and tgt != doc_id:
                    self.out_edges[doc_id].add(tgt)
                    self.in_edges[tgt].add(doc_id)

    # -- construction -------------------------------------------------------
    @classmethod
    def build(cls, vault: str) -> "RetrievalIndex":
        """Parse the vault into a fresh index (deterministic, source-of-truth)."""
        docs = _parse_vault(vault)
        return cls(docs)

    @classmethod
    def open(cls, vault: str, *, rebuild: bool = False) -> "RetrievalIndex":
        """Load the on-disk cache if present and current, else build + save.

        With ``rebuild=True`` the cache is ignored and regenerated — the
        "delete the index, rebuild, same results" path.
        """
        path = default_index_path(vault)
        if not rebuild and os.path.isfile(path):
            try:
                return cls.load(path)
            except Exception:
                pass  # stale/corrupt cache -> rebuild from the source of truth
        idx = cls.build(vault)
        try:
            idx.save(path)
        except OSError:
            pass
        return idx

    # -- persistence (the cache is disposable) -----------------------------
    def save(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        blob = {"version": 1, "docs": [self.docs[i].to_dict() for i in self.doc_ids]}
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(blob, fh, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, path)
        return path

    @classmethod
    def load(cls, path: str) -> "RetrievalIndex":
        with open(path, "r", encoding="utf-8") as fh:
            blob = json.load(fh)
        docs = [
            Doc(
                doc_id=d["doc_id"],
                type=d.get("type", ""),
                title=d.get("title", ""),
                body=d.get("body", ""),
                links=list(d.get("links", [])),
                raw_links=list(d.get("raw_links", [])),
            )
            for d in blob.get("docs", [])
        ]
        return cls(docs)

    # -- vault structure (for query transform) -----------------------------
    def vault_structure(self) -> VaultStructure:
        entities: List[str] = []
        sections: Set[str] = set()
        for doc_id in self.doc_ids:
            base = os.path.basename(doc_id)
            if base.endswith(".md"):
                entities.append(base[:-3])
            d = os.path.dirname(doc_id)
            if d:
                sections.add(d.split(os.sep)[0])
        return VaultStructure(
            entities=sorted(set(entities)), sections=sorted(sections)
        )

    # -- Stage 1: BM25 ------------------------------------------------------
    def bm25(
        self,
        query: str,
        k: int = 10,
        candidates: Optional[Iterable[str]] = None,
    ) -> List[Hit]:
        """Rank docs by Okapi BM25 (real IDF + term saturation + length norm)."""
        terms = tokenize(query)
        ids = list(candidates) if candidates is not None else self.doc_ids
        scored: List[Hit] = []
        for doc_id in ids:
            tf = self.tf.get(doc_id, {})
            dl = self.doc_len.get(doc_id, 0)
            s = 0.0
            for t in terms:
                f = tf.get(t, 0)
                if not f:
                    continue
                idf = self.idf.get(t, 0.0)
                if idf <= 0.0:
                    continue
                denom = f + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / (self.avgdl or 1.0))
                s += idf * (f * (BM25_K1 + 1.0)) / denom
            if s > 0.0:
                scored.append(Hit(doc_id, s, STAGE_BM25, self.docs[doc_id].title))
        scored.sort(key=lambda h: (-h.score, h.doc_id))
        return scored[:k]

    # -- Stage 2: dense (TF-IDF cosine) rerank -----------------------------
    def _tfidf(self, doc_id: str) -> Dict[str, float]:
        vec = self._tfidf_cache.get(doc_id)
        if vec is None:
            tf = self.tf.get(doc_id, {})
            vec = {
                t: (1.0 + math.log(f)) * self.idf.get(t, 0.0)
                for t, f in tf.items()
                if self.idf.get(t, 0.0) > 0.0
            }
            self._tfidf_cache[doc_id] = vec
        return vec

    def _query_tfidf(self, query: str) -> Dict[str, float]:
        counts: Dict[str, int] = {}
        for t in tokenize(query):
            counts[t] = counts.get(t, 0) + 1
        return {
            t: (1.0 + math.log(f)) * self.idf.get(t, 0.0)
            for t, f in counts.items()
            if self.idf.get(t, 0.0) > 0.0
        }

    def rerank(
        self, query: str, candidate_ids: Iterable[str], k: int = 10
    ) -> List[Hit]:
        """Precision pass: TF-IDF cosine over the BM25 candidate set.

        A real embedding backend implements the same cosine-over-vectors shape;
        this stdlib TF-IDF reranker is the offline default (DenseBackend seam).
        """
        qvec = self._query_tfidf(query)
        scored: List[Hit] = []
        for doc_id in candidate_ids:
            if doc_id not in self.docs:
                continue
            sim = _cosine(qvec, self._tfidf(doc_id))
            scored.append(Hit(doc_id, sim, STAGE_RERANK, self.docs[doc_id].title))
        scored.sort(key=lambda h: (-h.score, h.doc_id))
        return scored[:k]

    # -- Stage 3: graph traversal (markdown-link structure) ----------------
    def neighbors(self, doc_id: str) -> Set[str]:
        """1-hop neighbours (out-links + back-links) — undirected traversal."""
        return set(self.out_edges.get(doc_id, set())) | set(
            self.in_edges.get(doc_id, set())
        )

    def graph_retrieve(
        self, seed_ids: Sequence[str], query: str, k: int = 10
    ) -> List[Hit]:
        """1-hop neighbour subgraph of the seeds, reranked (ADR-008 stage 3).

        Seeds are the top lexical/dense hits; we expand to their 1-hop
        neighbours (high recall, tractable), then rerank the union so linked
        documents surface. Returns linked docs the seeds alone would miss.
        """
        candidate: Set[str] = set()
        for s in seed_ids:
            if s in self.docs:
                candidate.add(s)
                candidate |= self.neighbors(s)
        hits = self.rerank(query, sorted(candidate), k=k)
        for h in hits:
            h.stage = STAGE_GRAPH
        return hits


# ---------------------------------------------------------------------------
# Vault parsing.
# ---------------------------------------------------------------------------
def _parse_frontmatter(content: str) -> Tuple[Dict[str, str], str]:
    """Return (frontmatter dict, body-after-frontmatter)."""
    m = _FRONTMATTER_RE.match(content or "")
    if not m:
        return {}, content or ""
    fm: Dict[str, str] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip().strip("'\"")
    return fm, (content or "")[m.end():]


def _extract_link_targets(content: str, fm: Mapping[str, str]) -> List[str]:
    """All outgoing link targets: body wikilinks/markdown-links + frontmatter
    ref keys."""
    targets: List[str] = []
    targets += _WIKILINK_RE.findall(content)
    for tgt in _MDLINK_RE.findall(content):
        targets.append(tgt)
    for key in _LINK_FM_KEYS:
        val = fm.get(key)
        if not val:
            continue
        # frontmatter refs may be `[[a]], [[b]]` or `a.md, b.md`.
        wl = _WIKILINK_RE.findall(val)
        if wl:
            targets += wl
        else:
            targets += [p.strip() for p in re.split(r"[,\s]+", val) if p.strip()]
    return targets


def _resolve_target(target: str, by_relpath: Mapping[str, str],
                    by_basename: Mapping[str, str]) -> Optional[str]:
    t = (target or "").strip().split("#")[0].strip()
    if not t or t.startswith(("http://", "https://", "mailto:")):
        return None
    t = t.lstrip("./").replace("\\", "/")
    cand = t if t.endswith(".md") else t + ".md"
    if cand in by_relpath:
        return by_relpath[cand]
    base = os.path.basename(cand)[:-3].lower()
    return by_basename.get(base)


def _parse_vault(vault: str) -> List[Doc]:
    """Walk the vault, parse every markdown file into a Doc, resolve links."""
    if not vault or not os.path.isdir(vault):
        return []

    raw: List[Tuple[str, Dict[str, str], str, List[str]]] = []
    by_relpath: Dict[str, str] = {}
    by_basename: Dict[str, str] = {}

    for root, dirs, files in sorted(os.walk(vault)):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, vault).replace(os.sep, "/")
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    content = fh.read()
            except OSError:
                continue
            fm, body = _parse_frontmatter(content)
            targets = _extract_link_targets(content, fm)
            raw.append((rel, fm, body, targets))
            by_relpath[rel] = rel
            base = name[:-3].lower()
            by_basename.setdefault(base, rel)  # deterministic: first sorted wins

    docs: List[Doc] = []
    for rel, fm, body, targets in raw:
        resolved: List[str] = []
        seen: Set[str] = set()
        for tgt in targets:
            r = _resolve_target(tgt, by_relpath, by_basename)
            if r and r != rel and r not in seen:
                seen.add(r)
                resolved.append(r)
        title = fm.get("title") or os.path.basename(rel)[:-3]
        docs.append(
            Doc(
                doc_id=rel,
                type=fm.get("type", ""),
                title=title,
                body=body,
                links=resolved,
                raw_links=[t for t in targets],
            )
        )
    return docs


def default_index_path(vault: str) -> str:
    return os.path.join(vault, _INDEX_REL)


# ---------------------------------------------------------------------------
# Routing rule (ADR-008) — the graph gate.
# ---------------------------------------------------------------------------
@dataclass
class RoutePlan:
    """The routing decision for a query: how far up the cascade it may go.

    ``max_stage`` is GRAPH **iff** the query is a relationship / multi-hop query
    — that is the whole enforcement of "a single-doc factual query never reaches
    the graph".
    """

    query: str
    max_stage: str
    is_relationship: bool
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "max_stage": self.max_stage,
            "is_relationship": self.is_relationship,
            "reason": self.reason,
        }


def route(query: str, index: Optional[RetrievalIndex] = None) -> RoutePlan:
    """Apply the ADR-008 routing rule.

    - relationship / multi-hop query  -> may escalate to GRAPH.
    - any other (fact) query          -> tops out at RERANK; graph forbidden.
    """
    rel = is_relationship_query(query)
    if rel:
        return RoutePlan(
            query=query,
            max_stage=STAGE_GRAPH,
            is_relationship=True,
            reason="relationship/multi-hop query -> graph traversal permitted",
        )
    return RoutePlan(
        query=query,
        max_stage=STAGE_RERANK,
        is_relationship=False,
        reason="single/few-doc factual query -> BM25(+rerank); graph forbidden",
    )


# ---------------------------------------------------------------------------
# The cascade (deterministic, linear up to the routed ceiling).
# ---------------------------------------------------------------------------
@dataclass
class CascadeResult:
    query: str
    stage_reached: str
    hits: List[Hit]
    stages_run: List[str]
    route: Dict[str, Any]
    reason: str = ""

    @property
    def hit_count(self) -> int:
        return len(self.hits)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "query": self.query,
            "stage_reached": self.stage_reached,
            "stages_run": list(self.stages_run),
            "hits": [h.to_dict() for h in self.hits],
            "hit_count": self.hit_count,
            "route": self.route,
            "reason": self.reason,
        }


class Cascade:
    """Runs the three-stage cascade up to the routed ceiling.

    This is the deterministic pipeline; the *adaptive* early-stop lives in
    ``agentic_retrieval.RetrievalAgent`` (ADR-018), which reuses these stages.
    The graph stage is asserted to run only for relationship queries — the
    provable form of the ADR-008 invariant.
    """

    def __init__(
        self,
        index: RetrievalIndex,
        *,
        transform: Optional[Callable[[str], str]] = None,
        gateway: Optional[Any] = None,
        backend: Optional[str] = None,
    ) -> None:
        self.index = index
        self.transform = transform
        # OPT-IN graph/dense backend (default None -> the stdlib cascade below,
        # unchanged). "lightrag" (or $SCPRISM_LIGHTRAG) serves the graph/dense
        # stages via LightRAG when importable AND runnable (see lightrag_backend).
        self.gateway = gateway
        self.backend = backend
        self._lightrag_be: Optional[Any] = None

    def _lightrag(self) -> Optional[Any]:
        """Indexed LightRAG backend iff selected AND runnable, else None (no-op
        on the default path — does not import lightrag when not selected)."""
        from . import lightrag_backend as _lrb

        if not _lrb.lightrag_selected(self.backend) or not _lrb.lightrag_available():
            return None
        if self._lightrag_be is None:
            self._lightrag_be = _lrb.LightRAGBackend.from_index(
                self.gateway, self.index
            )
        return self._lightrag_be

    def run(self, query: str, *, k: int = 5, candidate_k: int = 20) -> CascadeResult:
        # OPT-IN: LightRAG serves graph/dense when selected+runnable; otherwise
        # (the default) the deterministic stdlib cascade below runs unchanged.
        be = self._lightrag()
        if be is not None:
            return be.cascade_result(query, k=k)

        plan = route(query, self.index)
        stages_run: List[str] = []

        # Stage 1 — BM25.
        bm25_hits = self.index.bm25(query, k=candidate_k)
        stages_run.append(STAGE_BM25)
        result_hits = bm25_hits[:k]
        stage_reached = STAGE_BM25

        # Stage 2 — dense rerank (with optional query transform).
        if _STAGE_RANK[plan.max_stage] >= _STAGE_RANK[STAGE_RERANK]:
            tq = self.transform(query) if self.transform else query
            candidate_ids = [h.doc_id for h in bm25_hits] or self.index.doc_ids
            rer = self.index.rerank(tq, candidate_ids, k=candidate_k)
            stages_run.append(STAGE_RERANK)
            result_hits = rer[:k]
            stage_reached = STAGE_RERANK

            # Stage 3 — graph (relationship queries only; invariant asserted).
            if _STAGE_RANK[plan.max_stage] >= _STAGE_RANK[STAGE_GRAPH]:
                assert plan.is_relationship, (
                    "graph stage reached for a non-relationship query — "
                    "ADR-008 invariant violated"
                )
                seeds = [h.doc_id for h in rer[:5]] or [h.doc_id for h in bm25_hits[:5]]
                graph_hits = self.index.graph_retrieve(seeds, query, k=k)
                stages_run.append(STAGE_GRAPH)
                result_hits = graph_hits
                stage_reached = STAGE_GRAPH

        return CascadeResult(
            query=query,
            stage_reached=stage_reached,
            hits=result_hits,
            stages_run=stages_run,
            route=plan.to_dict(),
            reason=plan.reason,
        )
