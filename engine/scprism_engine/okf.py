"""OKF v0.1 conformance — validate/emit the vault as an Open Knowledge Format
bundle (specs/04 §9, ADR-021).

OKF (Google Cloud, 2026-06-12) standardises exactly SC Prism's markdown-vault
pattern, so conformance is nearly free — it is mostly naming conventions on top
of what the vault already is. SC Prism is the **producer**; any OKF consumer can
read the bundle without a custom integration. OKF is the interchange *container*,
not the knowledge *engine* — the retrieval cascade / graph stay the authoritative
layer on top (retrieval.py).

The v0.1 bundle contract enforced here:

  * **Bundle = directory of markdown files**, one concept per file; the file path
    is the concept's identity.
  * **YAML frontmatter:** required ``type``; optional ``title``/``description``/
    ``resource``/``tags``/``timestamp``.
  * **Cross-links** are plain markdown links; the directory becomes a graph.
  * **Reserved files:** ``index.md`` (progressive disclosure) and ``log.md``
    (chronological change history, ISO 8601). Both are structural and exempt
    from the ``type`` requirement.

``validate_bundle(vault) -> {ok, issues, warnings}``: ``ok`` is False iff any
**issue** (a hard conformance failure) is present; broken cross-links surface as
**warnings** (soft — the graph tolerates a dangling ref) so a real vault is not
failed for one stale link. Stdlib only, deterministic, offline-safe.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .retrieval import (
    _SKIP_DIRS,
    _extract_link_targets,
    _parse_frontmatter,
    _resolve_target,
)

OKF_VERSION = "0.1"

# Required + reserved (specs/04 §9).
REQUIRED_KEYS = ("type",)
OPTIONAL_KEYS = ("title", "description", "resource", "tags", "timestamp")
RESERVED_FILES = ("index.md", "log.md")

# Issue codes.
NOT_A_DIRECTORY = "not-a-directory"
EMPTY_BUNDLE = "empty-bundle"
NO_FRONTMATTER = "no-frontmatter"
MISSING_TYPE = "missing-type"
EMPTY_DOC = "empty-doc"
LOG_NOT_ISO = "log-not-iso"
# Warning codes.
BROKEN_LINK = "broken-link"

_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass
class Issue:
    path: str
    code: str
    detail: str
    level: str = "error"  # 'error' | 'warning'

    def to_dict(self) -> Dict[str, Any]:
        return {"path": self.path, "code": self.code, "detail": self.detail, "level": self.level}


@dataclass
class BundleDoc:
    """One concept in the emitted OKF bundle."""

    path: str            # concept identity (bundle-relative)
    type: str
    title: str
    description: str = ""
    links: List[str] = field(default_factory=list)  # resolved neighbour paths
    reserved: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "type": self.type,
            "title": self.title,
            "description": self.description,
            "links": list(self.links),
            "reserved": self.reserved,
        }


@dataclass
class OKFBundle:
    """An emitted OKF v0.1 bundle manifest (the portable interchange view)."""

    version: str
    docs: List[BundleDoc]
    edges: List[Tuple[str, str]]
    has_index: bool
    has_log: bool

    @property
    def types(self) -> List[str]:
        return sorted({d.type for d in self.docs if d.type})

    def to_dict(self) -> Dict[str, Any]:
        return {
            "okf_version": self.version,
            "doc_count": len(self.docs),
            "types": self.types,
            "has_index": self.has_index,
            "has_log": self.has_log,
            "docs": [d.to_dict() for d in self.docs],
            "edges": [list(e) for e in self.edges],
        }


def _iter_markdown(vault: str) -> List[str]:
    """Bundle-relative paths of every markdown concept file (machine trees
    skipped)."""
    out: List[str] = []
    for root, dirs, files in sorted(os.walk(vault)):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.endswith(".md"):
                rel = os.path.relpath(os.path.join(root, name), vault).replace(os.sep, "/")
                out.append(rel)
    return out


def _is_reserved(rel: str) -> bool:
    return os.path.basename(rel) in RESERVED_FILES


def validate_bundle(vault: str) -> Dict[str, Any]:
    """Validate the vault against the OKF v0.1 contract.

    Returns ``{"ok": bool, "issues": [...], "warnings": [...], "doc_count": int}``.
    ``ok`` is True iff there are **no error-level issues**. Checks:

      1. the bundle is a directory with at least one markdown concept;
      2. every non-reserved concept has YAML frontmatter with a non-empty
         required ``type`` and a non-empty body;
      3. ``log.md`` (if present) carries ISO-8601 dates (chronological history);
      4. cross-links resolve — an unresolved link is a **warning**, not a failure.
    """
    issues: List[Issue] = []
    warnings: List[Issue] = []

    if not vault or not os.path.isdir(vault):
        issues.append(Issue(vault or "", NOT_A_DIRECTORY, "bundle path is not a directory"))
        return _result(issues, warnings, 0)

    rels = _iter_markdown(vault)
    if not rels:
        issues.append(Issue(vault, EMPTY_BUNDLE, "bundle contains no markdown concepts"))
        return _result(issues, warnings, 0)

    # Build the resolver maps for link checking (mirrors retrieval parsing).
    by_relpath = {r: r for r in rels}
    by_basename: Dict[str, str] = {}
    for r in rels:
        by_basename.setdefault(os.path.basename(r)[:-3].lower(), r)

    for rel in rels:
        path = os.path.join(vault, rel)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                content = fh.read()
        except OSError as exc:
            issues.append(Issue(rel, EMPTY_DOC, f"unreadable: {exc}"))
            continue

        fm, body = _parse_frontmatter(content)
        reserved = _is_reserved(rel)

        if not reserved:
            if not fm:
                issues.append(Issue(rel, NO_FRONTMATTER, "no YAML frontmatter block"))
            else:
                for key in REQUIRED_KEYS:
                    if not fm.get(key):
                        issues.append(
                            Issue(rel, MISSING_TYPE, f"required frontmatter '{key}' missing/empty")
                        )
            if not body.strip():
                issues.append(Issue(rel, EMPTY_DOC, "concept has no body", level="error"))

        # log.md — chronological history in ISO 8601.
        if os.path.basename(rel) == "log.md":
            content_lines = [ln for ln in content.splitlines() if ln.strip()]
            if content_lines and not any(_ISO_RE.search(ln) for ln in content_lines):
                issues.append(
                    Issue(rel, LOG_NOT_ISO, "log.md has no ISO-8601 (YYYY-MM-DD) dated entries")
                )

        # Cross-link resolution -> warnings.
        for tgt in _extract_link_targets(content, fm):
            resolved = _resolve_target(tgt, by_relpath, by_basename)
            if resolved is None and _looks_like_internal(tgt):
                warnings.append(
                    Issue(rel, BROKEN_LINK, f"unresolved cross-link '{tgt}'", level="warning")
                )

    return _result(issues, warnings, len(rels))


def _looks_like_internal(target: str) -> bool:
    """A link that should resolve inside the bundle (skip external URLs)."""
    t = (target or "").strip()
    return bool(t) and not t.startswith(("http://", "https://", "mailto:", "#"))


def _result(issues: List[Issue], warnings: List[Issue], doc_count: int) -> Dict[str, Any]:
    return {
        "ok": not issues,
        "issues": [i.to_dict() for i in issues],
        "warnings": [w.to_dict() for w in warnings],
        "doc_count": doc_count,
        "okf_version": OKF_VERSION,
    }


def emit_bundle(vault: str) -> OKFBundle:
    """Emit the vault as an OKF v0.1 bundle manifest (the producer view).

    The bundle IS the vault's markdown directory; this produces the portable
    manifest (concepts, their types, and the resolved markdown-link graph) an
    OKF consumer reads. Deterministic; does not mutate the vault.
    """
    rels = _iter_markdown(vault) if vault and os.path.isdir(vault) else []
    by_relpath = {r: r for r in rels}
    by_basename: Dict[str, str] = {}
    for r in rels:
        by_basename.setdefault(os.path.basename(r)[:-3].lower(), r)

    docs: List[BundleDoc] = []
    edges: List[Tuple[str, str]] = []
    has_index = has_log = False

    for rel in rels:
        base = os.path.basename(rel)
        if base == "index.md":
            has_index = True
        if base == "log.md":
            has_log = True
        try:
            with open(os.path.join(vault, rel), "r", encoding="utf-8") as fh:
                content = fh.read()
        except OSError:
            continue
        fm, _body = _parse_frontmatter(content)
        resolved: List[str] = []
        seen = set()
        for tgt in _extract_link_targets(content, fm):
            r = _resolve_target(tgt, by_relpath, by_basename)
            if r and r != rel and r not in seen:
                seen.add(r)
                resolved.append(r)
                edges.append((rel, r))
        docs.append(
            BundleDoc(
                path=rel,
                type=fm.get("type", ""),
                title=fm.get("title") or base[:-3],
                description=fm.get("description", ""),
                links=resolved,
                reserved=_is_reserved(rel),
            )
        )

    return OKFBundle(
        version=OKF_VERSION,
        docs=docs,
        edges=sorted(edges),
        has_index=has_index,
        has_log=has_log,
    )
