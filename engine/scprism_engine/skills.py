"""Vault skill-catalog loader (Task S1, roadmap #5).

``context.py`` already knows how to *serve* a skill catalog progressively
(``CatalogEntry`` + ``disclose()``) but nothing ever built one — every run
saw an empty catalog. This module is the loader: it turns
``<vault>/skills/*.md`` files into ``CatalogEntry`` objects. Wiring this into
the run loop (``loop.py``'s ``skill_catalog`` param) is a later task; this
module only loads and parses.

Frontmatter parsing deliberately mirrors the client's ``parseVaultSkill``
(``src/lib/skills.ts`` ~L274) so a skill authored or edited in the UI
round-trips identically on the engine side: an optional leading
``---\\n...\\n---\\n`` block, keys lowercased with hyphens turned to
underscores, values are the rest of the line, stripped.

Best-effort throughout (house rule for anything that runs ahead of every
turn): a missing vault, a missing/empty ``skills/`` dir, an unreadable file, a
decode failure, or an oversized file are all just "skip it" — this loader
never raises.
"""

from __future__ import annotations

import os
import re
from typing import List, Optional

from .capabilities import parse_allowed_tools
from .context import CatalogEntry

# Bounds (binding, see .superpowers/sdd task-S1-brief.md): non-recursive scan
# of <vault>/skills/*.md, sorted by filename, capped at 100 files; anything
# over 32 KB is skipped outright (never truncated, never read).
MAX_SKILL_FILES = 100
MAX_SKILL_FILE_BYTES = 32 * 1024
# Tier 3 (Agent Skills bundled resources): a folder skill's references/*.md,
# one level deep only ("Keep file references one level deep from SKILL.md").
# Capped in both count and size for the same reason the skill files are — this
# runs ahead of every turn.
MAX_SKILL_RESOURCES = 20
MAX_RESOURCE_BYTES = 32 * 1024

# Mirrors parseVaultSkill's three regexes exactly (skills.ts ~L274-285):
# a leading frontmatter block, a `key: value` line inside it, and the first
# markdown heading in the body.
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
_FM_LINE_RE = re.compile(r"^([A-Za-z_-]+)\s*:\s*(.+)$")
_HEADING_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)

# `when_to_use` phrases split on comma, semicolon, or newline.
_TRIGGER_SPLIT_RE = re.compile(r"[,;\n]+")

# `roles` / `agents` role names split on commas OR whitespace (P3-1): a
# frontmatter value like "planner developer" or "planner, developer" is one
# role list.
_ROLE_SPLIT_RE = re.compile(r"[,\s]+")


def load_vault_skill_catalog(vault: str) -> List[CatalogEntry]:
    """Scan ``<vault>/skills/*.md`` (non-recursive, sorted by filename) into a
    ``CatalogEntry`` list — the skill catalog ``context.disclose()`` reads
    from at plan time.

    A missing vault or missing/empty ``skills/`` dir returns ``[]`` — the
    exact behavior of today (no catalog at all), so wiring this in later is a
    no-op everywhere no vault skills exist. Never raises: a single bad file
    (unreadable, undecodable, oversized) is skipped, not fatal to the scan.
    """
    if not vault:
        return []
    skills_dir = os.path.join(vault, "skills")
    try:
        if not os.path.isdir(skills_dir):
            return []
        skills_root = os.path.realpath(skills_dir)
        listing = sorted(os.listdir(skills_dir))
    except OSError:
        return []

    # Two shapes, one catalog (agent-standard slice C): the ecosystem's folder
    # shape ``<slug>/SKILL.md`` and the original flat ``<slug>.md``. A folder
    # skill's parse filename is ``<slug>.md`` so the stem fallback names it by
    # its folder — never "SKILL". On a slug collision the folder wins (the
    # richer shape is the deliberate upgrade path). Nothing inside a skill
    # folder except its SKILL.md is ever scanned — references/ and scripts/
    # ride along for tools that want them, invisible to disclosure. Symlinked
    # folders are skipped here for the same reason _load_one skips symlinked
    # files: git preserves symlinks, and a committed link escaping the vault
    # must never be dereferenced.
    candidates: List[tuple] = []  # (sort_key, parse_filename, path)
    folder_slugs = set()
    for name in listing:
        path = os.path.join(skills_dir, name)
        try:
            if os.path.islink(path) or not os.path.isdir(path):
                continue
            skill_file = next(
                (
                    f
                    for f in ("SKILL.md", "skill.md")
                    if os.path.isfile(os.path.join(path, f))
                ),
                None,
            )
            if skill_file is None:
                continue
        except OSError:
            continue
        folder_slugs.add(name)
        # Case matters off APFS: a case-sensitive volume or Linux CI would list
        # the skill in the UI and hide it from every prompt, with no surface
        # reporting the gap. The reference parser accepts both spellings.
        candidates.append((name + ".md", name + ".md", os.path.join(path, skill_file)))
    for name in listing:
        if not name.lower().endswith(".md"):
            continue
        if os.path.splitext(name)[0] in folder_slugs:
            continue  # the folder shape shadows its flat twin
        candidates.append((name, name, os.path.join(skills_dir, name)))
    candidates.sort(key=lambda c: c[0])

    catalog: List[CatalogEntry] = []
    for _, parse_name, path in candidates[:MAX_SKILL_FILES]:  # excess ignored
        entry = _load_one(path, parse_name, skills_root)
        if entry is not None:
            catalog.append(entry)
    return catalog


def _read_guarded(path: str, skills_root: str, max_bytes: int) -> Optional[str]:
    """Read one file under the skills tree, or None to skip it.

    The check-then-open sequence is deliberately gapless — islink, then realpath
    containment, then getsize, then open. ``os.getsize`` and ``open`` both
    dereference, so both guards MUST precede them. Shared by the skill file and
    its bundled references so a reference can never be read on weaker terms
    than the skill itself.
    """
    try:
        if os.path.islink(path):
            return None
        real = os.path.realpath(path)
        if real != skills_root and not real.startswith(skills_root + os.sep):
            return None
        if os.path.getsize(path) > max_bytes:
            return None
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def _load_resources(skill_dir: str, skills_root: str) -> dict:
    """A folder skill's ``references/*.md``, as relpath -> content.

    Read EAGERLY. Storing paths for a later open would split the guard sequence
    above and reopen the TOCTOU it exists to close: swap a reference for a
    symlink to a private key between load and disclosure and the deferred open
    dereferences it into the doer's prompt, with a load-time-only test still
    green. Bounded memory buys that whole class away; the token saving was never
    in the read, it is in what reaches the prompt.
    """
    refs_dir = os.path.join(skill_dir, "references")
    out: dict = {}
    try:
        if os.path.islink(refs_dir) or not os.path.isdir(refs_dir):
            return out
        names = sorted(os.listdir(refs_dir))
    except OSError:
        return out
    for name in names:
        if len(out) >= MAX_SKILL_RESOURCES:
            break
        if not name.lower().endswith(".md"):
            continue  # one level deep only: a nested dir is not a .md
        text = _read_guarded(os.path.join(refs_dir, name), skills_root, MAX_RESOURCE_BYTES)
        if text is not None:
            out["references/" + name] = text
    return out


def _load_one(path: str, filename: str, skills_root: str) -> Optional[CatalogEntry]:
    """Read + parse one skill file, or return None to skip it."""
    # Containment guard (mirrors project.py's write boundary): a skills file is
    # shareable and git preserves symlinks, so a committed
    # ``skills/notes.md -> ~/.ssh/id_rsa`` would otherwise be read verbatim and
    # injected into the doer model's prompt (key-material exfiltration). Skip
    # ALL symlinks outright — the simplest correct rule — and belt-and-braces
    # reject anything whose real path escapes the resolved skills dir. os.getsize
    # and open() both dereference, so this MUST run before either.
    raw = _read_guarded(path, skills_root, MAX_SKILL_FILE_BYTES)
    if raw is None:
        return None

    try:
        entry = _parse_skill_markdown(filename, raw)
    except Exception:
        # Best-effort loader: a malformed file is skipped, never fatal.
        return None

    # Tier 3 belongs to the FOLDER shape only — a flat skill has nowhere to
    # put references, and its sibling .md files are other skills.
    if os.path.basename(path).lower() == "skill.md":
        entry.resources = _load_resources(os.path.dirname(path), skills_root)
    return entry


# Keys a `metadata:` child may never set — the spec's own required fields plus
# the experimental capability declaration. Everything else flattens freely.
_RESERVED_FM_KEYS = frozenset({"name", "description", "allowed_tools"})


def _unquote(value: str) -> str:
    """Strip ONE matched surrounding quote pair, YAML-style.

    `name: "code-review"` is a legal quoted scalar. Keeping the quotes put them
    in the entry name, which silently breaks the verdict->library join that
    matches disclosed skills by name string.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        inner = value[1:-1]
        return inner.replace('\\"', '"') if value[0] == '"' else inner
    return value


def _parse_skill_markdown(filename: str, raw: str) -> CatalogEntry:
    """Parse one skill file's text into a ``CatalogEntry``.

    ``name`` = fm ``name`` | first ``# heading`` in the body | filename stem.
    ``summary`` = fm ``description`` | ``""``.
    ``instructions`` = the body with any frontmatter block removed, stripped.
    ``triggers`` = the fm ``when_to_use`` value split into phrases, plus the
    name itself (so a skill is always disclosable by its own name, even with
    no ``when_to_use`` at all — existing ``CatalogEntry.matches`` word-subset
    logic then applies; no new matching code here).
    """
    body = (raw or "").strip()
    fm: dict = {}
    m = _FRONTMATTER_RE.match(body)
    if m:
        body = body[m.end():].strip()
        for line in m.group(1).split("\n"):
            # Indentation is captured BEFORE the strip. Flattening an indented
            # `metadata:` child into a top-level key is what lets SC Prism's own
            # extra properties ride in the spec's escape hatch at zero parser
            # cost — but it must never let a LEGAL foreign skill whose metadata
            # block happens to carry `name:` overwrite the real one.
            indented = line[:1].isspace()
            kv = _FM_LINE_RE.match(line.strip())
            if kv:
                key = kv.group(1).lower().replace("-", "_")
                if indented and key in _RESERVED_FM_KEYS:
                    continue
                fm[key] = _unquote(kv.group(2).strip())

    heading_m = _HEADING_RE.search(body)
    heading = heading_m.group(1).strip() if heading_m else ""
    stem = os.path.splitext(filename)[0]
    # `scprism_display_name` carries the human title when the spec-legal
    # `name` had to be slugged to satisfy its charset (mirrors the client).
    name = fm.get("scprism_display_name") or fm.get("name") or heading or stem

    triggers = _split_when_to_use(
        fm.get("when_to_use")
        or fm.get("whentouse")
        or fm.get("scprism_when_to_use")
        or ""
    )
    triggers.append(name)

    # Role scoping (P3-1): `roles:` OR `agents:` (alias) -> the role list. No
    # key ⇒ [] ⇒ GLOBAL, byte-identical to a pre-P3-1 skill.
    roles = _split_roles(
        fm.get("scprism_roles") or fm.get("roles") or fm.get("agents") or ""
    )

    # `allowed-tools` is the spec's own (experimental) field; the metadata
    # alias is what SC Prism writes, since emitting our capability vocabulary
    # into a spec field would be non-conformant in the other direction.
    allowed_raw = str(fm.get("allowed_tools") or fm.get("scprism_capabilities") or "")
    allowed = parse_allowed_tools(allowed_raw)

    return CatalogEntry(
        name=name,
        triggers=triggers,
        instructions=body,
        summary=fm.get("description", ""),
        roles=roles,
        allowed_tools=allowed,
        allowed_tools_raw=allowed_raw,
    )


def _split_when_to_use(value: str) -> List[str]:
    """Split a ``when_to_use`` value into individual trigger phrases on
    commas, semicolons, or newlines; each phrase stripped, empties dropped."""
    return [p.strip() for p in _TRIGGER_SPLIT_RE.split(value or "") if p.strip()]


def _split_roles(value: str) -> List[str]:
    """Split a ``roles:`` / ``agents:`` value into role names on commas or
    whitespace; each stripped, empties dropped. Empty value ⇒ [] (global)."""
    return [p.strip() for p in _ROLE_SPLIT_RE.split(value or "") if p.strip()]
