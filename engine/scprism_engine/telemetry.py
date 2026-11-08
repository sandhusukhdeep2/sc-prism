"""Telemetry — a minimal OTel-style span emitter (ADR-012, specs/07).

Tracing, not logs: every loop step emits a typed span. ``span(name, ...)`` is a
context manager that records start / end / duration_ms / status / attrs and
appends exactly ONE JSON line to ``<vault>/spans.jsonl``. The Console is a
*reader* of this file; it never hooks the loop.

Span types (specs/07 table): ``run`` (root), ``model_call``, ``tool_exec``,
``retrieval``, ``hook``, ``verdict``. A run is fully reconstructable from its
spans alone — child spans carry ``parent_id``; the root ``run`` span ties them
together. Appends are lock-guarded so parallel read steps can emit concurrently
without corrupting the file, and tracing adds no ordering constraint to the
loop.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

SPAN_TYPES = ("run", "model_call", "tool_exec", "retrieval", "hook", "verdict")
# The two kinds a board watches in flight (spec 2026-11-08, engine gap 1).
LIVE_SPAN_TYPES = ("model_call", "tool_exec")


class TelemetryError(ValueError):
    """Raised on an unknown span type."""


@dataclass
class Span:
    """A live span. Mutate attrs/status inside the ``with`` block."""

    span_id: str
    parent_id: Optional[str]
    name: str
    span_type: str
    run_id: str
    start: float
    attrs: Dict[str, Any] = field(default_factory=dict)
    status: str = "ok"

    def set(self, **kw: Any) -> "Span":
        self.attrs.update(kw)
        return self

    def set_status(self, status: str) -> "Span":
        self.status = status
        return self


class Telemetry:
    """Emits typed spans as JSON lines to ``spans_path`` (thread-safe)."""

    def __init__(self, spans_path: str, run_id: Optional[str] = None) -> None:
        self.spans_path = spans_path
        self.run_id = run_id or uuid.uuid4().hex
        self._lock = threading.Lock()
        directory = os.path.dirname(os.path.abspath(spans_path)) or "."
        os.makedirs(directory, exist_ok=True)
        # The seat whose turn it is (see acting_as); empty = unnamed.
        self._actor: Dict[str, Any] = {}

    @contextmanager
    def acting_as(self, agent: str, stage: str = "") -> Iterator[None]:
        """The SEAT whose turn this is. Every span written inside the block —
        the model turns and, above all, the tool calls the vault / web / MCP
        clients write themselves — carries ``agent`` (and ``round`` for the
        stage) unless it names one explicitly. Without this a tool span says
        what ran but never WHO used it, so no board, live tail or dossier can
        attribute it (spec 2026-11-08, engine gap 2). Blank names claim
        nothing: an absent attr and an empty one are different statements.
        Nests: the inner seat wins, the outer one is restored on exit."""
        outer = self._actor
        who: Dict[str, Any] = {}
        if agent.strip():
            who["agent"] = agent.strip()
        if stage.strip():
            who["round"] = stage.strip()
        self._actor = who or outer
        try:
            yield
        finally:
            self._actor = outer

    @contextmanager
    def span(
        self,
        name: str,
        span_type: str = "run",
        parent: Optional[str] = None,
        **attrs: Any,
    ) -> Iterator[Span]:
        if span_type not in SPAN_TYPES:
            raise TelemetryError(
                f"span_type must be one of {SPAN_TYPES}, got {span_type!r}"
            )
        merged = dict(attrs)
        for key, value in self._actor.items():
            merged.setdefault(key, value)
        sp = Span(
            span_id=uuid.uuid4().hex,
            parent_id=parent,
            name=name,
            span_type=span_type,
            run_id=self.run_id,
            start=time.time(),
            attrs=merged,
        )
        # A model call or a tool call ANNOUNCES itself when it opens — the
        # same span_id, status "open", no end — so a board can show the seat
        # thinking / reading / searching while it happens. The close below
        # rewrites the span; read_spans keeps the last record per span_id.
        # Other types stay close-only: nothing watches a hook in flight.
        if span_type in LIVE_SPAN_TYPES:
            self._emit(sp, None)
        try:
            yield sp
        except BaseException as exc:  # emit even on failure, then re-raise
            sp.set_status("error")
            sp.attrs.setdefault("error", repr(exc))
            self._emit(sp, time.time())
            raise
        else:
            self._emit(sp, time.time())

    def _emit(self, sp: Span, end: Optional[float]) -> None:
        record = {
            "run_id": sp.run_id,
            "span_id": sp.span_id,
            "parent_id": sp.parent_id,
            "name": sp.name,
            "type": sp.span_type,
            "start": sp.start,
            "end": end,
            "duration_ms": None if end is None else round((end - sp.start) * 1000.0, 3),
            "status": "open" if end is None else sp.status,
            "attrs": dict(sp.attrs),
        }
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            with open(self.spans_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")


def read_spans(path: str) -> List[Dict[str, Any]]:
    """Read a spans.jsonl file back into a list of dicts (for reconstruction)."""
    # One record per span: a live span wrote an "open" line first and its
    # close rewrote the same span_id, so the LAST line for a span_id is the
    # truth and it keeps the slot where the span first appeared. A line with
    # no span_id (an older writer) is kept as it is.
    out: List[Dict[str, Any]] = []
    slot: Dict[str, int] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            sid = rec.get("span_id")
            if isinstance(sid, str) and sid in slot:
                out[slot[sid]] = rec
                continue
            if isinstance(sid, str):
                slot[sid] = len(out)
            out.append(rec)
    return out
