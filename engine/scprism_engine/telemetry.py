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
        sp = Span(
            span_id=uuid.uuid4().hex,
            parent_id=parent,
            name=name,
            span_type=span_type,
            run_id=self.run_id,
            start=time.time(),
            attrs=dict(attrs),
        )
        try:
            yield sp
        except BaseException as exc:  # emit even on failure, then re-raise
            sp.set_status("error")
            sp.attrs.setdefault("error", repr(exc))
            self._emit(sp, time.time())
            raise
        else:
            self._emit(sp, time.time())

    def _emit(self, sp: Span, end: float) -> None:
        record = {
            "run_id": sp.run_id,
            "span_id": sp.span_id,
            "parent_id": sp.parent_id,
            "name": sp.name,
            "type": sp.span_type,
            "start": sp.start,
            "end": end,
            "duration_ms": round((end - sp.start) * 1000.0, 3),
            "status": sp.status,
            "attrs": sp.attrs,
        }
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            with open(self.spans_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")


def read_spans(path: str) -> List[Dict[str, Any]]:
    """Read a spans.jsonl file back into a list of dicts (for reconstruction)."""
    out: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out
