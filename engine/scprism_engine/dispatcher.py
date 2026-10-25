"""Dispatcher — executes planned Steps.

Read-only steps may run concurrently (threads). Write steps run strictly
serial, in plan order, never overlapping each other or a read. `model_call`
is pluggable; the default is a deterministic stub that spends no real tokens
and makes no network calls.

If OPENAI_BASE_URL is set we note where a *real* call would go, but we still
use the stub — this skeleton has zero third-party / network dependencies.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .planner import Step

# A model_call takes (prompt, route) and returns (text, tokens_spent).
ModelCall = Callable[[str, str], "ModelResult"]


@dataclass
class ModelResult:
    text: str
    tokens: int
    route: str
    cache: str = "miss"  # 'miss' | 'prompt' | 'semantic' (gateway cache outcome)
    tokens_in: int = 0
    tokens_out: int = 0
    # The gateway's HONEST route reason (RouteDecision.reason) for this call —
    # e.g. "learned route policy v3: bucket 'docs' -> cloud (p=0.61)" or
    # "reasoning keyword 'design' -> cloud". Carried to the Verdict so the client
    # can label the route from the REAL reason instead of a fabricated one
    # (LF-fix E). "" for an injected/composite doer that routes itself.
    reason: str = ""
    # The distinct `provider · model` labels a COMPOSITE doer (e.g. the P1-2
    # role board) actually used to produce `text`. Default None = a plain
    # single-model call that carries no sub-models — the loop then derives
    # models_used from the gateway route exactly as before (backward-compatible;
    # dispatch/finalize only merge this when it is non-None).
    models_used: Optional[List[str]] = None
    # The skill NAMES a COMPOSITE doer disclosed per-agent (P3-1 role board):
    # since such a doer bypasses loop.run's own disclosure, it carries its own
    # attribution out this same pipe. Default None = a plain doer that discloses
    # nothing here (loop.run's block, if any, is attributed the usual way);
    # dispatch/loop merge this only when it is non-None (backward-compatible).
    disclosed: Optional[List[str]] = None
    # The provider cut this completion off at its output cap, so `text` is
    # INCOMPLETE (gateway ModelCallResult.truncated). False = a clean finish.
    truncated: bool = False


@dataclass
class StepResult:
    index: int
    description: str
    kind: str
    route: str
    output: str
    tokens: int
    cache: str = "miss"
    # The gateway's honest route reason for this step (see ModelResult.reason);
    # "" for a stub/composite doer. Carried up so the Verdict can name the real
    # routing cause (LF-fix E).
    reason: str = ""
    # Carried up from a composite doer's ModelResult (see above); empty for an
    # ordinary single-model step.
    models_used: List[str] = field(default_factory=list)
    # Skill names a composite doer disclosed per-agent (see above); empty for an
    # ordinary single-model step.
    disclosed: List[str] = field(default_factory=list)
    # This step's output was CUT OFF at the model's output cap (see
    # ModelResult.truncated) — the judge is told, so it never grades an
    # unfinished answer as a finished-but-poor one.
    truncated: bool = False


@dataclass
class DispatchResult:
    step_results: List[StepResult] = field(default_factory=list)
    tokens_spent: int = 0
    # Order in which WRITE steps actually executed — used to prove seriality.
    write_order: List[int] = field(default_factory=list)
    model_routes: List[str] = field(default_factory=list)
    # The DISTINCT honest route reasons seen across steps, in record order
    # (deduped like models_used). Empty for a run whose doer supplies no reason
    # (composite doers / the plain stub) — the client then falls back to its
    # built-in route labels, byte-identical (LF-fix E).
    model_route_reasons: List[str] = field(default_factory=list)
    # Distinct `provider · model` labels a composite doer reported across steps,
    # deduped in plan/record order. Empty for every ordinary run — the loop
    # merges it into the Verdict's models_used only when a step's doer supplied
    # it (byte-identical otherwise).
    models_used: List[str] = field(default_factory=list)
    # Skill names a composite doer disclosed per-agent, deduped in record order.
    # Empty for every ordinary run — the loop merges it into the Verdict's
    # disclosed only when a step's doer supplied it (byte-identical otherwise).
    disclosed: List[str] = field(default_factory=list)
    # Cache attribution (specs/07 §5 cache warmth).
    cache_hits: int = 0
    cache_misses: int = 0


def model_call(prompt: str, route: str) -> ModelResult:
    """Default deterministic model stub. Zero network, deterministic tokens.

    Token cost is a stable function of prompt length so tests are
    reproducible. If OPENAI_BASE_URL is set, this is where a real client
    call would be wired — we deliberately keep the stub to stay dependency-
    and network-free.
    """
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url:
        note = f" [would call real endpoint at {base_url}; stubbed]"
    else:
        note = ""

    text = f"[stub:{route}] handled: {prompt}{note}"
    # Deterministic, non-zero token estimate (~4 chars/token).
    tokens = max(1, len(prompt) // 4)
    return ModelResult(text=text, tokens=tokens, route=route)


def dispatch(
    steps: List[Step],
    *,
    model: Optional[ModelCall] = None,
    max_workers: int = 4,
    token_budget: Optional[int] = None,
) -> DispatchResult:
    """Execute steps: reads concurrently, writes strictly serial.

    Steps are processed in plan order. A run of consecutive read steps is
    executed together in a thread pool; each write step is executed alone,
    flushing any pending reads first, so no write overlaps anything.
    """
    model = model or model_call
    result = DispatchResult()

    write_lock = threading.Lock()  # guards serial write execution + ordering

    def run_one(step: Step) -> StepResult:
        mr = model(step.description, step.route)
        return StepResult(
            index=step.index,
            description=step.description,
            kind=step.kind,
            route=getattr(mr, "route", step.route),
            output=mr.text,
            tokens=mr.tokens,
            cache=getattr(mr, "cache", "miss"),
            reason=getattr(mr, "reason", "") or "",
            # A composite doer (the role board) reports the sub-models it used;
            # ordinary steps carry None -> []. Captured per-step in the worker
            # thread and merged serially in `record`, so this stays thread-safe.
            models_used=list(getattr(mr, "models_used", None) or []),
            # Likewise for the skills a composite doer disclosed per-agent.
            disclosed=list(getattr(mr, "disclosed", None) or []),
            truncated=bool(getattr(mr, "truncated", False)),
        )

    def record(sr: StepResult) -> None:
        result.step_results.append(sr)
        result.tokens_spent += sr.tokens
        result.model_routes.append(sr.route)
        # Collect the DISTINCT honest route reasons in record order. Skip empties
        # (stub/composite doers) so an ordinary reasonless run leaves this [] —
        # byte-identical downstream.
        if sr.reason and sr.reason not in result.model_route_reasons:
            result.model_route_reasons.append(sr.reason)
        # Merge any composite-doer sub-models, deduped in record order. A no-op
        # for every ordinary step (empty list), so DispatchResult.models_used
        # stays [] unless a doer actually supplied labels.
        for label in sr.models_used:
            if label not in result.models_used:
                result.models_used.append(label)
        # Same merge for the composite doer's per-agent disclosed skill names.
        for name in sr.disclosed:
            if name not in result.disclosed:
                result.disclosed.append(name)
        if sr.cache != "miss":
            result.cache_hits += 1
        else:
            result.cache_misses += 1

    pending_reads: List[Step] = []

    def flush_reads() -> None:
        if not pending_reads:
            return
        batch = list(pending_reads)
        pending_reads.clear()
        if len(batch) == 1:
            record(run_one(batch[0]))
            return
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            srs = list(pool.map(run_one, batch))
        # Deterministic ordering of recorded results by plan index.
        for sr in sorted(srs, key=lambda s: s.index):
            record(sr)

    for step in steps:
        if step.is_write:
            flush_reads()
            with write_lock:  # strictly serial; no concurrent writers
                sr = run_one(step)
                record(sr)
                result.write_order.append(step.index)
        else:
            pending_reads.append(step)

    flush_reads()

    # Sort recorded results back into plan order for a stable trace.
    result.step_results.sort(key=lambda s: s.index)
    return result
