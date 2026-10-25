"""Optional LightRAG graph/dense retrieval backend — OPT-IN, gateway-routed
(specs/04, ADR-004/018/025).

ADR-025 makes **LightRAG** the implementation of the graph layer (full GraphRAG
remains the fallback ceiling). This module wraps LightRAG behind the existing
retrieval interface (``retrieval.py``): it indexes the markdown vault and serves
graph/dense results in the SAME shape the stdlib cascade returns
(``retrieval.Hit`` / ``retrieval.CascadeResult`` / ``agentic_retrieval.AgenticResult``).

CORE INVARIANT — every model/embedding call LightRAG makes routes through OUR
gateway; no direct provider SDK call, no direct socket:

  * ``llm_model_func`` forwards to ``gateway.route`` + ``gateway.model_call``
    (offline it returns the gateway's deterministic stub — still audited/billed).
  * ``embedding_func`` uses a **gateway-owned** embedding path: if the gateway
    exposes ``embed()`` it is used, otherwise a deterministic offline hash
    embedding (stdlib) — never a provider embedding SDK.

Wiring is strictly OPT-IN and never changes the default (specs/04 §3 cascade):

  * Enabled when ``SCPRISM_LIGHTRAG`` is truthy **or** a caller passes
    ``backend="lightrag"`` to the cascade / agentic retriever — AND LightRAG is
    importable *and runnable* in the running interpreter.
  * Otherwise the stdlib BM25 -> rerank -> graph cascade runs unchanged.

Offline / hermetic: telemetry is disabled, all writes are confined under
``engine/`` (or an explicit ``working_dir``), and no network is required — the
gateway stub + deterministic embedding make an indexing/retrieval run fully
reproducible.

NOTE ON PYTHON 3.9: LightRAG declares ``Requires-Python >=3.9`` but its default
storage backends (JsonKVStorage / NanoVectorDBStorage / NetworkXStorage)
evaluate PEP 604 ``X | None`` unions at class-definition time, which only works
on Python >=3.10. So on 3.9 ``import lightrag`` succeeds but instantiation
raises. ``lightrag_available()`` therefore does a real runtime probe (not just
an import check) and returns False on 3.9 — the tests skip and the default
cascade is used. On Python >=3.10 the same code runs LightRAG for real.
"""

from __future__ import annotations

import json
import math
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .retrieval import (
    STAGE_GRAPH,
    STAGE_RERANK,
    CascadeResult,
    Doc,
    Hit,
    RetrievalIndex,
    is_relationship_query,
    route as _route,
    _parse_vault,
)

# --------------------------------------------------------------------------
# Hermetic / offline env — set BEFORE importing lightrag so it takes effect.
# LightRAG core does not phone home, but be explicit and quiet; confine any
# on-disk state to engine/.  ``setdefault`` respects an operator's own choice.
# --------------------------------------------------------------------------
_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_WORKING_DIR = os.path.join(_ENGINE_DIR, ".lightrag")

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# ascii_colors (LightRAG's logger) — keep it quiet by default.
os.environ.setdefault("LOG_LEVEL", os.environ.get("LIGHTRAG_LOG_LEVEL", "ERROR"))


try:  # LightRAG lives only in engine/.venv-rag (opt-in) — guard so system python is fine.
    from lightrag import LightRAG, QueryParam
    from lightrag.utils import EmbeddingFunc

    HAS_LIGHTRAG = True
    _IMPORT_ERROR: Optional[BaseException] = None
except Exception as exc:  # ImportError or any transitive failure
    LightRAG = QueryParam = EmbeddingFunc = None  # type: ignore[assignment]
    HAS_LIGHTRAG = False
    _IMPORT_ERROR = exc


# Cached result of the runtime-runnability probe (see lightrag_available()).
_RUNNABLE: Optional[bool] = None
_RUNNABLE_ERROR: Optional[BaseException] = None

# Default embedding dimensionality for the offline deterministic embedding.
DEFAULT_EMBED_DIM = 256


# --------------------------------------------------------------------------
# Opt-in / availability
# --------------------------------------------------------------------------
def import_error() -> Optional[BaseException]:
    """The exception that made ``lightrag`` unimportable, or None."""
    return _IMPORT_ERROR


def lightrag_available() -> bool:
    """True iff LightRAG is importable **and actually runnable** here.

    ``import lightrag`` succeeding is not enough: on Python 3.9 the default
    storage backends fail to define (PEP 604 unions at class-body time), so we
    probe by importing those default-path storage modules. Result is cached.
    """
    global _RUNNABLE, _RUNNABLE_ERROR
    if _RUNNABLE is not None:
        return _RUNNABLE
    if not HAS_LIGHTRAG:
        _RUNNABLE = False
        _RUNNABLE_ERROR = _IMPORT_ERROR
        return False
    try:
        import importlib

        # The default LightRAG() config uses exactly these storage classes;
        # importing their modules exercises the class-definition-time code that
        # breaks on Python < 3.10.
        for mod in (
            "lightrag.kg.json_kv_impl",  # JsonKVStorage (kv_storage default)
            "lightrag.kg.nano_vector_db_impl",  # NanoVectorDBStorage (vector default)
            "lightrag.kg.networkx_impl",  # NetworkXStorage (graph default)
            "lightrag.kg.json_doc_status_impl",  # JsonDocStatusStorage (doc-status default)
        ):
            importlib.import_module(mod)
        _RUNNABLE = True
    except Exception as exc:  # noqa: BLE001 - any def-time failure => not runnable
        _RUNNABLE = False
        _RUNNABLE_ERROR = exc
    return _RUNNABLE


def runnable_error() -> Optional[BaseException]:
    """Why LightRAG is not runnable here (e.g. the Python 3.9 union failure)."""
    lightrag_available()
    return _RUNNABLE_ERROR


def lightrag_enabled(env: Optional[Dict[str, str]] = None) -> bool:
    """True iff the opt-in env flag ``SCPRISM_LIGHTRAG`` is truthy."""
    env = os.environ if env is None else env
    return str(env.get("SCPRISM_LIGHTRAG", "")).strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def lightrag_selected(
    backend: Optional[str], env: Optional[Dict[str, str]] = None
) -> bool:
    """Decide whether the OPT-IN LightRAG backend should handle retrieval.

    Precedence (mirrors ``evals._use_deepeval``): an explicit ``backend``
    argument wins; otherwise the env flag ``SCPRISM_LIGHTRAG`` decides. This is a
    pure decision — it does not import or require lightrag.
    """
    if backend is not None:
        return str(backend).strip().lower() == "lightrag"
    return lightrag_enabled(env)


# --------------------------------------------------------------------------
# Gateway-owned embedding (deterministic, offline) — NEVER a provider SDK.
# --------------------------------------------------------------------------
def _deterministic_embed_one(text: str, dim: int) -> List[float]:
    """A stable, offline, L2-normalised bag-of-tokens hash embedding.

    Deterministic (seeded only by the text), stdlib-only, and reproducible so an
    offline index rebuild is identical. This is the offline default of the
    "gateway-owned embedding path" — it does not, and must not, reach a provider.
    """
    import hashlib

    vec = [0.0] * dim
    for tok in re.findall(r"[a-z0-9]+", (text or "").lower()):
        h = int(hashlib.sha1(tok.encode("utf-8")).hexdigest(), 16)
        vec[h % dim] += 1.0
        # a second, sign-bearing component spreads tokens across the space.
        vec[(h // dim) % dim] += 1.0 if (h & 1) else -1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


class GatewayEmbedding:
    """Embedding callable LightRAG uses; routes through a gateway-owned path.

    If the gateway exposes an ``embed(texts) -> vectors`` method it is used
    (still gateway-owned, no direct SDK); otherwise the deterministic offline
    embedding above. Records call/token counts so a test can prove routing.
    """

    def __init__(self, gateway: Any, dim: int = DEFAULT_EMBED_DIM) -> None:
        self.gateway = gateway
        self.dim = dim
        self.calls = 0
        self.texts_embedded = 0

    async def __call__(self, texts: Sequence[str]):
        import numpy as np  # pulled in transitively by lightrag

        self.calls += 1
        self.texts_embedded += len(texts)
        gw_embed = getattr(self.gateway, "embed", None)
        if callable(gw_embed):  # gateway owns a real embedding endpoint
            vectors = gw_embed(list(texts))
        else:  # offline deterministic gateway-owned fallback
            vectors = [_deterministic_embed_one(t, self.dim) for t in texts]
        return np.array(vectors, dtype=np.float32)


# --------------------------------------------------------------------------
# Gateway-routed LLM — LightRAG's every generate() goes THROUGH our gateway.
# --------------------------------------------------------------------------
_LIGHTRAG_SYSTEM = (
    "You are the SC Prism knowledge-layer extraction/generation model, invoked "
    "by LightRAG. Every call is routed through the SC Prism gateway."
)


class GatewayLLM:
    """An async LLM function object LightRAG calls for entity extraction, keyword
    extraction and generation. It forwards to ``gateway.model_call`` — no SDK,
    no direct socket — so the core invariant holds. Records usage for the spy
    test that proves routing.
    """

    def __init__(self, gateway: Any) -> None:
        self.gateway = gateway
        self.calls = 0
        self.tokens_in = 0
        self.tokens_out = 0
        self.saw_real = False

    async def __call__(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        history_messages: Optional[List[Dict[str, Any]]] = None,
        **kwargs: Any,
    ) -> str:
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt or _LIGHTRAG_SYSTEM}
        ]
        for m in history_messages or []:
            if isinstance(m, dict) and "role" in m and "content" in m:
                messages.append({"role": m["role"], "content": str(m["content"])})
        messages.append({"role": "user", "content": str(prompt)})

        decision = self.gateway.route(str(prompt))  # gateway is authoritative
        res = self.gateway.model_call(messages, decision)
        self.calls += 1
        self.tokens_in += int(getattr(res, "tokens_in", 0))
        self.tokens_out += int(getattr(res, "tokens_out", 0))
        if getattr(res, "is_real", False):
            self.saw_real = True
        return res.text


# --------------------------------------------------------------------------
# Context parsing — map LightRAG's context back to vault doc_ids (Hits).
# --------------------------------------------------------------------------
# LightRAG 1.5.x ``only_need_context=True`` output shape (verified against the
# installed 1.5.4 in engine/.venv-rag). It is NOT the guessed per-row
# ``file_path`` format: sources are carried in a single "Reference Document
# List" block that maps a reference id to a source *name*, already ordered by
# relevance (frequency, then first appearance). Example (naive/dense mode):
#
#     Document Chunks (...):
#
#     ```json
#     {"reference_id": "1", "content": "..."}
#     ```
#
#     Reference Document List (...):
#
#     ```
#     [1] budget.md
#     [2] graphrag.md
#     ```
#
# The graph modes (local/global/hybrid/mix) prepend "Knowledge Graph Data
# (Entity)/(Relationship)" json blocks but converge on the SAME Reference
# Document List, so parsing that one block covers every mode. On no context
# LightRAG returns a short "Sorry ...[no-context]" string with no such block.
#
# NOTE: LightRAG stores/echoes the source *basename* (e.g. ``budget.md``) even
# when a nested id like ``policies/budget.md`` was inserted, so we map that name
# back to the original vault doc_id via a basename index built at insert time.
_REF_LIST_HEADER = "Reference Document List"
_REF_LINE_RE = re.compile(r"^\s*\[(\d+)\]\s+(.+?)\s*$", re.MULTILINE)


def _parse_context_hits(
    context: str,
    stage: str,
    k: int,
    docid_by_name: Optional[Dict[str, str]] = None,
) -> List[Hit]:
    """Turn a LightRAG ``only_need_context`` string into ordered ``Hit`` objects.

    Parses the "Reference Document List" block (the single source-of-truth for
    provenance across all LightRAG modes), maps each source name back to the
    vault doc_id it was inserted as, and emits ``retrieval.Hit`` objects with a
    descending, deterministic score — the same shape the stdlib cascade returns.
    """
    if not context:
        return []
    name_map = docid_by_name or {}
    # Isolate the reference-list section so the ``[N] name`` pattern can't be
    # confused by anything upstream (entity/relationship/chunk json).
    pos = context.find(_REF_LIST_HEADER)
    section = context[pos:] if pos != -1 else context
    ordered: List[str] = []
    seen = set()
    for m in _REF_LINE_RE.finditer(section):
        name = m.group(2).strip()
        if not name or name == "unknown_source":
            continue
        # A single reference may pack several joined sources (GRAPH_FIELD_SEP).
        for part in re.split(r"<\s*SEP\s*>|[<|>]{2,}", name):
            part = part.strip()
            if not part or part == "unknown_source":
                continue
            doc_id = (
                name_map.get(part)
                or name_map.get(os.path.basename(part))
                or part
            )
            if doc_id in seen:
                continue
            seen.add(doc_id)
            ordered.append(doc_id)
    n = len(ordered)
    hits: List[Hit] = []
    for i, doc_id in enumerate(ordered[:k]):
        score = round((n - i) / n, 6) if n else 0.0
        hits.append(Hit(doc_id=doc_id, score=score, stage=stage, title=doc_id))
    return hits


# --------------------------------------------------------------------------
# The backend
# --------------------------------------------------------------------------
class LightRAGBackend:
    """LightRAG wrapped behind the SC Prism retrieval interface.

    Lifecycle: construct with a gateway, ``index_vault``/``index_docs`` to build
    the LightRAG index over the markdown vault, then ``retrieve`` (or the
    shape-preserving ``cascade_result`` / ``agentic_result``). Every LLM and
    embedding call routes through the gateway (see GatewayLLM / GatewayEmbedding).
    """

    def __init__(
        self,
        gateway: Any,
        *,
        working_dir: Optional[str] = None,
        embedding_dim: int = DEFAULT_EMBED_DIM,
        env: Optional[Dict[str, str]] = None,
    ) -> None:
        if not lightrag_available():
            raise RuntimeError(
                "LightRAG is not runnable in this interpreter: "
                f"{runnable_error()!r} (needs Python >= 3.10)"
            )
        if gateway is None:  # never let the backend bypass the gateway
            raise ValueError(
                "LightRAGBackend requires a gateway — LLM/embedding calls must "
                "route through it (core invariant)."
            )
        self.gateway = gateway
        self.working_dir = working_dir or _DEFAULT_WORKING_DIR
        self.embedding_dim = int(embedding_dim)
        self.llm = GatewayLLM(gateway)
        self.embedding = GatewayEmbedding(gateway, dim=self.embedding_dim)
        self._rag: Optional[Any] = None
        self._indexed = False
        # A SINGLE persistent event loop drives this instance's whole lifecycle
        # (build -> insert -> query -> finalize). LightRAG 1.5.x binds its
        # storages, shared-storage locks and priority-queue workers to the loop
        # that first runs them and guards against being driven from another loop
        # (``_owning_loop``); a fresh loop per op therefore breaks it and leaks
        # pending worker/health-check tasks. See close() for teardown.
        self._loop: Optional[Any] = None
        # basename/id -> original vault doc_id, so retrieved reference names map
        # back to the id we inserted (LightRAG echoes the source basename).
        self._docid_by_name: Dict[str, str] = {}

    # -- async plumbing -------------------------------------------------
    def _get_loop(self) -> Any:
        """Return this instance's persistent event loop (create on first use)."""
        import asyncio

        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
        return self._loop

    def _run(self, coro: Any) -> Any:
        """Drive ``coro`` on this instance's ONE persistent loop.

        The loop is deliberately kept open between operations so LightRAG's
        loop-bound storages/locks/workers stay valid across index -> retrieve
        (a new loop per op trips LightRAG's cross-loop guard). It is drained and
        closed exactly once, in close()/teardown.
        """
        import asyncio

        loop = self._get_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            asyncio.set_event_loop(None)

    async def _build(self) -> Any:
        from lightrag.kg.shared_storage import initialize_pipeline_status

        os.makedirs(self.working_dir, exist_ok=True)
        rag = LightRAG(
            working_dir=self.working_dir,
            embedding_func=EmbeddingFunc(
                embedding_dim=self.embedding_dim,
                max_token_size=8192,
                func=self.embedding,
            ),
            llm_model_func=self.llm,
            embedding_batch_num=8,
            embedding_func_max_async=2,
            llm_model_max_async=2,
            enable_llm_cache=True,
        )
        await rag.initialize_storages()
        await initialize_pipeline_status()
        return rag

    # -- indexing (the vault is the source of truth) --------------------
    def index_docs(self, docs: Sequence[Doc]) -> "LightRAGBackend":
        """Index already-parsed vault ``Doc`` objects (doc_id == file_path)."""
        docs = list(docs)
        # Index the doc_ids under both their full id and basename: LightRAG
        # echoes the source basename in the reference list, so this lets the
        # parser recover the original (possibly nested) vault doc_id.
        for d in docs:
            self._docid_by_name[d.doc_id] = d.doc_id
            self._docid_by_name.setdefault(os.path.basename(d.doc_id), d.doc_id)

        async def _go() -> None:
            self._rag = await self._build()
            if not docs:
                return
            contents = [
                (d.title + "\n\n" + d.body).strip() or d.title or d.doc_id
                for d in docs
            ]
            ids = [d.doc_id for d in docs]
            # file_paths == doc_ids so retrieved context maps straight back.
            await self._rag.ainsert(contents, ids=ids, file_paths=ids)

        self._run(_go())
        self._indexed = True
        return self

    def index_vault(self, vault: str) -> "LightRAGBackend":
        """Parse the markdown vault and index it (reuses the cascade parser)."""
        return self.index_docs(_parse_vault(vault))

    @classmethod
    def from_index(
        cls, gateway: Any, index: RetrievalIndex, **kwargs: Any
    ) -> "LightRAGBackend":
        """Build a backend from an already-parsed ``RetrievalIndex`` (no re-read)."""
        be = cls(gateway, **kwargs)
        return be.index_docs(list(index.docs.values()))

    # -- retrieval ------------------------------------------------------
    def _mode_and_stage(self, query: str, relationship: Optional[bool]) -> Tuple[str, str]:
        """Map the query class to a LightRAG mode + our stage label.

        Preserves the ADR-008 invariant: a non-relationship (factual) query uses
        the dense ``naive`` mode and is labelled RERANK — it never touches the
        graph; a relationship query uses graph-aware ``hybrid`` mode -> GRAPH.
        """
        rel = is_relationship_query(query) if relationship is None else relationship
        return ("hybrid", STAGE_GRAPH) if rel else ("naive", STAGE_RERANK)

    def retrieve(
        self, query: str, *, k: int = 5, relationship: Optional[bool] = None
    ) -> List[Hit]:
        """Retrieve ``k`` hits for ``query`` via LightRAG, in cascade Hit shape."""
        if not self._indexed or self._rag is None:
            raise RuntimeError("index_vault()/index_docs() must run before retrieve()")
        mode, stage = self._mode_and_stage(query, relationship)

        async def _go() -> str:
            param = QueryParam(
                mode=mode,
                only_need_context=True,
                top_k=max(k * 4, 20),
            )
            out = await self._rag.aquery(query, param=param)
            return out if isinstance(out, str) else ""

        context = self._run(_go())
        return _parse_context_hits(context, stage, k, self._docid_by_name)

    # -- shape-preserving results (same objects the stdlib cascade returns) --
    def cascade_result(self, query: str, *, k: int = 5) -> CascadeResult:
        """Return a ``retrieval.CascadeResult`` — identical shape to Cascade.run."""
        plan = _route(query)
        hits = self.retrieve(query, k=k, relationship=plan.is_relationship)
        stage_reached = hits[0].stage if hits else STAGE_RERANK
        return CascadeResult(
            query=query,
            stage_reached=stage_reached,
            hits=hits,
            stages_run=[stage_reached],
            route=plan.to_dict(),
            reason="lightrag backend (graph/dense stages served by LightRAG)",
        )

    def agentic_result(self, query: str, *, k: int = 5) -> Any:
        """Return an ``agentic_retrieval.AgenticResult`` — same shape as the agent."""
        from .agentic_retrieval import AgenticResult, Decision

        plan = _route(query)
        hits = self.retrieve(query, k=k, relationship=plan.is_relationship)
        stage_reached = hits[0].stage if hits else STAGE_RERANK
        decision = Decision(
            stage_reached, True, "lightrag backend served graph/dense retrieval"
        )
        return AgenticResult(
            query=query,
            stage_reached=stage_reached,
            hits=hits,
            stages_run=[stage_reached],
            decisions=[decision],
            route=plan.to_dict(),
            escalated=stage_reached == STAGE_GRAPH,
            cache="miss",
            transformed_query="",
        )

    # -- routing-proof accessors (for tests / observability) ------------
    @property
    def gateway_calls(self) -> int:
        return self.llm.calls

    async def _shutdown_workers(self) -> None:
        """Stop every LightRAG priority-queue worker + its health-check task.

        LightRAG wraps the embedding, rerank and per-role LLM callables in
        ``priority_limit_async_func_call``, which lazily spawns background worker
        coroutines and a periodic health-check coroutine on the running loop.
        Each wrapper exposes ``.shutdown()`` — calling it sets the shutdown event
        and cancels those tasks, which is what silences the "no running event
        loop" / "Task was destroyed but it is pending" teardown noise.
        """
        rag = self._rag
        wrappers: List[Any] = []
        ef = getattr(rag, "embedding_func", None)
        inner = getattr(ef, "func", None)
        if inner is not None:
            wrappers.append(inner)
        rr = getattr(rag, "rerank_model_func", None)
        if rr is not None:
            wrappers.append(rr)
        states = getattr(rag, "_role_llm_states", None) or {}
        for st in getattr(states, "values", lambda: [])():
            w = getattr(st, "wrapped", None)
            if w is not None:
                wrappers.append(w)
        for w in wrappers:
            sd = getattr(w, "shutdown", None)
            if callable(sd):
                try:
                    await sd(graceful=False)
                except Exception:  # noqa: BLE001 - best-effort teardown
                    pass

    async def _teardown(self) -> None:
        # Order matters: stop workers, flush/close storages, THEN reset the
        # process-global shared state so the next instance re-initialises fresh
        # on its own loop (no cross-loop lock reuse).
        await self._shutdown_workers()
        try:
            await self._rag.finalize_storages()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        try:
            from lightrag.kg.shared_storage import finalize_share_data

            finalize_share_data()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass

    def close(self) -> None:
        """Tear the backend down completely — no dangling loop or pending tasks.

        Idempotent. Drains the persistent loop (finalize storages, shut down
        workers, cancel any residual tasks) and closes it, so nothing survives to
        raise "event loop is closed" / pending-task errors at interpreter exit.
        """
        import asyncio

        loop = self._loop
        if loop is not None and not loop.is_closed():
            asyncio.set_event_loop(loop)
            try:
                if self._rag is not None:
                    loop.run_until_complete(self._teardown())
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
            finally:
                # Safety net: cancel and await anything still pending on the loop
                # (residual workers/health-check) before closing it.
                try:
                    pending = asyncio.all_tasks(loop)
                except Exception:  # noqa: BLE001
                    pending = set()
                for t in pending:
                    t.cancel()
                if pending:
                    try:
                        loop.run_until_complete(
                            asyncio.gather(*pending, return_exceptions=True)
                        )
                    except Exception:  # noqa: BLE001
                        pass
                asyncio.set_event_loop(None)
                loop.close()
        self._loop = None
        self._rag = None
        self._indexed = False
