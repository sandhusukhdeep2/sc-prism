"""Governed vault tool source (Mission Control Part 1, 2026-08-05) — stdlib only.

Gives the companion EYES on its own machine. Before this, the only tool source
the engine shipped was ``webtools.py`` (web_fetch / web_search) plus whatever MCP
servers the user registered — so the companion's charter ("look at the real
project statuses and the knowledge vault") was unreachable and its own beat log
said so: *"I can't inspect the vault through my available tools (web_fetch
only)"*. It rested honestly instead of working. This module is the fix:

  * ``vault_list(subdir?)``  — names + sizes, NEVER contents.
  * ``vault_read(path)``     — one note, path-confined, size-capped.
  * ``vault_search(query)``  — filename + content matches, capped.
  * ``project_status()``     — read-only view of the app's projects store.

Shape is copied from ``webtools.WebToolProvider`` deliberately: this is a tool
SOURCE, MCPClient-SHAPED (``list_tools()`` + ``call_tool(name, args)`` +
``parent_span_id`` + ``telemetry``), so the v2b tool-use loop consumes it
unchanged, ``CompositeToolClient`` fans it alongside web/MCP sources, and
``ApprovalGate`` wraps it identically — a vault tool can never skip a hold the
approval posture requires. Every call emits a real ``tool_exec`` span
(``provider="vault"``); a blocked call RAISES ``MCPBlockedError`` and still emits
a ``blocked=True`` span so the block is auditable.

**Read-only in v1.** No tool here writes, renames or deletes anything; the
engine's own verified write path stays the only way bytes enter the vault.

**The security boundary is path confinement.** Every model-supplied path is
joined onto the vault root and then ``os.path.realpath``-ed; the REAL resolved
path must be the root itself or live under ``root + os.sep``. Because the check
is on the RESOLVED path, all three escapes die together: ``../../etc/passwd``,
an absolute ``/etc/passwd`` (``os.path.join`` discards the root, realpath lands
outside), and a symlink INSIDE the vault pointing out of it (realpath follows
it). A refusal is an honest ``isError`` the model sees — never a silent empty
success. HIDDEN paths (any component starting with ``.``) are refused by that
same function, so ``.env`` / ``.ssh/id_rsa`` / ``.git/config`` cannot be read
through a door the walk never shows: list, search and read now agree.

**Sensitivity.** Unlike ``webtools``, there is NO ``SENSITIVE_KEYWORDS`` gate on
the ARGUMENTS here, and that is deliberate, not an oversight: a vault tool
performs zero egress — it reads local files the user already owns — so blocking
``vault_read("notes/prod-runbook.md")`` would only re-blind the companion
without protecting anything. What protects the CONTENT is the loop's vault
egress floor (``loop.VAULT_LOCAL_REASON``): once one of these tools returns
content, the rest of that run routes LOCAL, and where no local model exists the
content is withheld from the cloud turn rather than sent. This module used to
claim the F1 keyword guard was that floor; an audit proved it was not — an
18-word denylist cannot recognise a diagnosis, a salary or a settlement, and
walked all three onto a cloud POST. The categorical rule replaces it; the
keyword guard remains as a backstop for the other tool sources.

Honesty is the invariant throughout: a failure is an honest ``isError`` the
model sees, a truncation says it truncated, a capped listing says how many
entries it did not show, an empty search says it found nothing, and a missing
projects store says "no project data available" — never a fabricated file, hit,
or project.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from .mcp import MCPBlockedError, MCPTool

# The app's bundle identifier (src-tauri/tauri.conf.json) — the projects store
# lives under this app-data directory as `store/projects.json`.
APP_IDENTIFIER = "com.slashcreative.scprism"

# Defaults, all honest caps (each is reported when it bites).
MAX_LIST_ENTRIES = 200
# One read must FIT the caller's budget. 40k chars is ~10-13k tokens: a single
# vault_read blew the heartbeat's 20k token budget and overflowed a small local
# model's context — the tool's own cap has to be smaller than the smallest
# consumer. 8k chars (~2-2.7k tokens) leaves room for the loop to keep working,
# and the truncation note still says exactly what was cut.
MAX_READ_CHARS = 8_000
MAX_SEARCH_HITS = 20
# Project rows in one project_status view (same "… N more" honesty as a listing).
MAX_PROJECT_ENTRIES = 50
# Per-file byte cap while SEARCHING (a huge spans.jsonl must not stall a run).
MAX_SEARCH_FILE_BYTES = 400_000
# File-count bound for one search, so a vast vault can never stall a run. When
# it bites, the result SAYS the scan stopped early (a partial answer that admits
# it is partial, never a confident "nothing found").
MAX_SEARCH_FILES = 2_000

# Directory/file names never walked: dotfiles (".git", ".obsidian", ...) are
# skipped by the leading-dot rule; these are the noisy non-vault trees.
_SKIP_NAMES = frozenset({"node_modules", "__pycache__"})


def _error(message: str) -> Dict[str, Any]:
    """An honest MCP-style error result the model sees (never raises out)."""
    return {"isError": True, "content": [{"type": "text", "text": message}]}


def _text(text: str, **extra: Any) -> Dict[str, Any]:
    """An MCP-style success result carrying ``text`` plus structured extras."""
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    result.update(extra)
    return result


# -- path confinement (the security boundary) --------------------------------


def _vault_root(vault: str) -> str:
    """The vault root as a REAL path (symlinks resolved), so the confinement
    check compares like with like — e.g. macOS ``/tmp`` -> ``/private/tmp``
    must not make every path look like an escape."""
    return os.path.realpath(os.path.abspath(str(vault)))


def _is_inside(root: str, real: str) -> bool:
    """True when ``real`` IS ``root`` or lives beneath it. Both must already be
    real paths. ``root`` is right-stripped of separators so a root of ``/``
    (pathological, but must not silently reject everything) still works."""
    if real == root:
        return True
    prefix = root.rstrip(os.sep) + os.sep
    return real.startswith(prefix)


def resolve_in_vault(vault: str, path: Any) -> Tuple[Optional[str], Optional[str]]:
    """Resolve a model-supplied ``path`` INSIDE the vault.

    Returns ``(real_path, None)`` when the path is confined, else
    ``(None, reason)``. This is the security boundary: the returned path is the
    ``os.path.realpath`` of the join, so ``..`` traversal, an absolute path
    outside the vault, and a symlink escape are all rejected by the same check
    (the vetted path IS the path a caller would open). NEVER raises.

    HIDDEN paths are refused too. ``_walk_files`` has always skipped any name
    starting with ``.``, so list and search never show a dotfile — but read had
    no such rule, which made ``vault_read(".env")``, ``.ssh/id_rsa`` and
    ``.git/config`` fully readable while INVISIBLE to every other tool. One
    surface must not be quieter than another about the same file: the leading-dot
    rule lives HERE, where every path already passes, so all four tools agree.
    """
    if not isinstance(path, str) or not path.strip():
        return None, "path must be a non-empty string"
    root = _vault_root(vault)
    try:
        # os.path.join drops `root` when `path` is absolute — that is exactly
        # what we want: the absolute path is then realpath-ed and vetted below.
        real = os.path.realpath(os.path.join(root, path))
    except (OSError, ValueError) as exc:  # pathological input (NUL byte, ...)
        return None, "path %r could not be resolved (%s)" % (path, exc)
    if not _is_inside(root, real):
        return None, "path %r escapes the vault (refused)" % path
    # Checked on the RESOLVED path (relative to the root), so ".", ".." and any
    # symlink spelling collapse before the rule runs. The root ITSELF resolves to
    # os.curdir and is not hidden.
    rel = os.path.relpath(real, root)
    if rel != os.curdir and any(
        part.startswith(".") for part in rel.split(os.sep) if part
    ):
        return None, (
            "path %r is hidden (a name starting with '.') — hidden files are "
            "never listed, searched or read (refused)" % path
        )
    return real, None


def _open_regular(real: str) -> Tuple[Optional[int], int, Optional[str]]:
    """Open ``real`` read-only as a REGULAR file. Returns ``(fd, size, None)``
    or ``(None, 0, reason)``; the caller owns the fd. NEVER raises, never blocks.

    Three things a plain ``open()`` did not give us:

      * ``O_NOFOLLOW`` closes the TOCTOU window between ``resolve_in_vault``'s
        ``realpath`` and this open — the vetted path cannot be swapped for a
        symlink pointing out of the vault in between.
      * ``O_NONBLOCK`` plus the ``S_ISREG`` check on the OPENED descriptor means
        a FIFO or device node in the vault can never hang a run forever waiting
        for a writer (``open()`` on a FIFO blocks until one appears).
      * the ``fstat`` describes the descriptor we are about to read, so the size
        we report belongs to the bytes we actually read.
    """
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(real, flags)
    except OSError as exc:
        return None, 0, str(exc)
    try:
        st = os.fstat(fd)
    except OSError as exc:  # pragma: no cover - fstat on a fresh fd
        os.close(fd)
        return None, 0, str(exc)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        return None, 0, "not a regular file"
    return fd, int(st.st_size), None


# -- walking -----------------------------------------------------------------


def _walk_files(root: str, start: str) -> Iterator[Tuple[str, str]]:
    """Yield ``(relpath_from_root, abspath)`` for every file under ``start``,
    skipping dotfiles/dot-directories, ``_SKIP_NAMES`` and symlinks that leave
    the vault. Sorted for determinism; unreadable directories are skipped, never
    raised."""
    for dirpath, dirnames, filenames in os.walk(start, onerror=lambda _e: None):
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d not in _SKIP_NAMES
        )
        for name in sorted(filenames):
            if name.startswith(".") or name in _SKIP_NAMES:
                continue
            abspath = os.path.join(dirpath, name)
            # A symlink whose TARGET lives outside the vault is not vault data.
            # Listing it reported the OUT-OF-VAULT file's size (metadata about a
            # file the confinement rule refuses to read) — the same
            # ``_is_inside`` check that governs reads governs the walk, so list
            # and search stop describing things read cannot open. os.walk does
            # not follow symlinked DIRECTORIES (followlinks=False), so only file
            # links can reach here.
            if os.path.islink(abspath) and not _is_inside(
                root, os.path.realpath(abspath)
            ):
                continue
            yield os.path.relpath(abspath, root), abspath


def _human_size(n: int) -> str:
    """A short honest size string: bytes, KB, or MB (never rounded to zero)."""
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024.0)
    return "%.1f MB" % (n / (1024.0 * 1024.0))


# -- vault_list --------------------------------------------------------------


def vault_list(
    vault: str,
    subdir: Optional[str] = None,
    *,
    max_entries: int = MAX_LIST_ENTRIES,
) -> Dict[str, Any]:
    """List the vault's files as NAMES + SIZES only. NEVER returns contents.

    ``subdir`` (optional) narrows the walk and is path-confined like every other
    argument. Entries are relative to the vault root, sorted, capped at
    ``max_entries`` with an honest "N more" note. A missing vault/subdir, or a
    subdir that is really a file, is an honest ``isError``.
    """
    root = _vault_root(vault)
    start = root
    if subdir is not None and str(subdir).strip():
        start, reason = resolve_in_vault(vault, subdir)
        if start is None:
            return _error("vault_list refused: %s" % reason)
    if not os.path.isdir(start):
        if start == root:
            return _error("vault_list failed: no vault directory at %s" % root)
        return _error(
            "vault_list failed: %r is not a directory in the vault"
            % os.path.relpath(start, root)
        )
    entries: List[Dict[str, Any]] = []
    total = 0
    cap = max(0, int(max_entries))
    for rel, abspath in _walk_files(root, start):
        total += 1
        if len(entries) >= cap:
            continue
        try:
            size = os.path.getsize(abspath)
        except OSError:
            size = -1  # honest "unknown", never a made-up number
        entries.append({"path": rel, "bytes": size})
    where = "the vault" if start == root else "%s/" % os.path.relpath(start, root)
    if total == 0:
        return _text(
            "No files in %s (nothing to list)." % where,
            entries=[],
            total=0,
            truncated=False,
        )
    lines = ["%d file(s) in %s (names + sizes only, no contents):" % (total, where), ""]
    for e in entries:
        size = e["bytes"]
        lines.append(
            "- %s (%s)" % (e["path"], "size unknown" if size < 0 else _human_size(size))
        )
    truncated = total > len(entries)
    if truncated:
        lines.append("")
        lines.append(
            "… %d more file(s) not shown (cap %d) — narrow with the 'subdir' "
            "argument." % (total - len(entries), cap)
        )
    return _text(
        "\n".join(lines), entries=entries, total=total, truncated=truncated
    )


# -- vault_read --------------------------------------------------------------


def vault_read(
    vault: str, path: Any, *, max_chars: int = MAX_READ_CHARS
) -> Dict[str, Any]:
    """Read ONE note's text out of the vault. NEVER raises.

    The path is confined to the vault (``resolve_in_vault`` — traversal,
    absolute-outside, symlink escape and hidden paths all refused). The read is
    BOUNDED at the source: at most ``max_chars + 1`` characters ever enter the
    process, so a huge file (``spans.jsonl`` lives in the vault root and grows
    without bound) costs a page, not its whole size — reading it all and then
    slicing turned a 300 MB file into ~600 MB of RSS. The one extra character is
    all it takes to know the note was cut, and the truncation note says so, with
    the file's REAL size from the descriptor's own ``fstat``. A missing /
    directory / non-regular / unreadable target is an honest ``isError``, never
    an empty success.
    """
    real, reason = resolve_in_vault(vault, path)
    if real is None:
        return _error("vault_read refused: %s" % reason)
    root = _vault_root(vault)
    rel = os.path.relpath(real, root)
    if os.path.isdir(real):
        return _error(
            "vault_read failed: %r is a directory, not a note (use vault_list)" % rel
        )
    if not os.path.exists(real):
        return _error("vault_read failed: no such file in the vault: %r" % rel)
    cap = max(0, int(max_chars))
    fd, size, why = _open_regular(real)
    if fd is None:
        return _error("vault_read failed for %r: %s" % (rel, why))
    try:
        fh = os.fdopen(fd, "r", encoding="utf-8", errors="replace")
    except OSError as exc:  # pragma: no cover - fdopen on a fresh fd
        os.close(fd)
        return _error("vault_read failed for %r: %s" % (rel, exc))
    try:
        with fh:
            body = fh.read(cap + 1)
    except (OSError, ValueError) as exc:
        return _error("vault_read failed for %r: %s" % (rel, exc))
    truncated = len(body) > cap
    shown = cap if truncated else len(body)
    if truncated:
        body = body[:cap] + (
            "\n\n[truncated — showed the first %d characters of %s (%s on disk); "
            "read a narrower note or ask for a specific section]"
            % (cap, rel, _human_size(size))
        )
    # `chars` is what was RETURNED. The whole-file character count is deliberately
    # not reported: knowing it would mean reading the whole file, which is the
    # bug. `bytes` is the real size on disk, straight from the fstat.
    return _text(body, path=rel, bytes=size, chars=shown, truncated=truncated)


# -- vault_search ------------------------------------------------------------


def _snippet(text: str, index: int, width: int = 70) -> str:
    """A short, whitespace-collapsed excerpt of ``text`` around ``index``."""
    start = max(0, index - width)
    end = min(len(text), index + width)
    piece = " ".join(text[start:end].split())
    if start > 0:
        piece = "…" + piece
    if end < len(text):
        piece = piece + "…"
    return piece


def _searchable_text(abspath: str) -> Optional[str]:
    """Read up to ``MAX_SEARCH_FILE_BYTES`` of ``abspath`` as text, or None when
    it is unreadable, is not a REGULAR file, or looks BINARY (a NUL byte in the
    head) — a binary blob must not produce a garbage "match", and a FIFO must not
    hang the scan (``_open_regular`` refuses both)."""
    fd, _size, _why = _open_regular(abspath)
    if fd is None:
        return None
    try:
        fh = os.fdopen(fd, "rb")
    except OSError:  # pragma: no cover - fdopen on a fresh fd
        os.close(fd)
        return None
    try:
        with fh:
            raw = fh.read(MAX_SEARCH_FILE_BYTES)
    except (OSError, ValueError):
        return None
    if b"\x00" in raw[:1024]:
        return None
    return raw.decode("utf-8", errors="replace")


def vault_search(
    vault: str,
    query: Any,
    *,
    max_hits: int = MAX_SEARCH_HITS,
    max_files: int = MAX_SEARCH_FILES,
) -> Dict[str, Any]:
    """Case-insensitive search over vault FILENAMES and CONTENTS.

    Each hit carries its vault-relative path, why it matched (``filename`` /
    ``content``) and a short real snippet — never a summary the model could
    mistake for the file. Capped at ``max_hits`` with an honest "N more" note,
    and bounded at ``max_files`` scanned (which the result admits when it bites).
    Zero hits is an honest SUCCESS ("No vault matches for …"), never an error;
    a missing vault IS an error (the difference matters: "nothing found" and "I
    could not look" are not the same claim).
    """
    if not isinstance(query, str) or not query.strip():
        return _error("vault_search requires a non-empty string 'query' argument")
    root = _vault_root(vault)
    if not os.path.isdir(root):
        return _error("vault_search failed: no vault directory at %s" % root)
    needle = query.lower()
    hits: List[Dict[str, str]] = []
    total = 0
    scanned = 0
    scan_capped = False
    cap = max(0, int(max_hits))
    file_cap = max(1, int(max_files))
    for rel, abspath in _walk_files(root, root):
        if scanned >= file_cap:
            scan_capped = True
            break
        scanned += 1
        matched_name = needle in rel.lower()
        body = _searchable_text(abspath)
        idx = body.lower().find(needle) if body is not None else -1
        if not matched_name and idx < 0:
            continue
        total += 1
        if len(hits) >= cap:
            continue
        if idx >= 0:
            hits.append(
                {
                    "path": rel,
                    "match": "filename+content" if matched_name else "content",
                    "snippet": _snippet(body or "", idx),
                }
            )
        else:
            head = " ".join((body or "")[:140].split())
            hits.append({"path": rel, "match": "filename", "snippet": head})
    partial = (
        " (search stopped after scanning %d files — this answer is partial)"
        % scanned
        if scan_capped
        else ""
    )
    if total == 0:
        return _text(
            "No vault matches for %r.%s" % (query, partial),
            query=query,
            hits=[],
            total=0,
            scanned=scanned,
            scan_capped=scan_capped,
        )
    lines = ["Vault matches for %r (%d)%s:" % (query, total, partial), ""]
    for i, hit in enumerate(hits, 1):
        lines.append("%d. %s — %s match" % (i, hit["path"], hit["match"]))
        if hit["snippet"]:
            lines.append("   %s" % hit["snippet"])
    if total > len(hits):
        lines.append("")
        lines.append(
            "… %d more match(es) not shown (cap %d) — narrow the query."
            % (total - len(hits), cap)
        )
    return _text(
        "\n".join(lines),
        query=query,
        hits=hits,
        total=total,
        scanned=scanned,
        scan_capped=scan_capped,
    )


# -- project_status ----------------------------------------------------------


def app_data_dir() -> Optional[str]:
    """The app's platform data directory (where Tauri's ``store_set`` writes),
    or None when it cannot be determined. macOS ``~/Library/Application
    Support/<id>``, Windows ``%APPDATA%\\<id>``, else XDG ``~/.local/share/<id>``.
    """
    try:
        home = os.path.expanduser("~")
        if sys.platform == "darwin":
            return os.path.join(home, "Library", "Application Support", APP_IDENTIFIER)
        if os.name == "nt":
            base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
            return os.path.join(base, APP_IDENTIFIER)
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
        return os.path.join(base, APP_IDENTIFIER)
    except Exception:  # noqa: BLE001 — discovery must never break a run
        return None


def projects_store_candidates(vault: Optional[str] = None) -> List[str]:
    """Where the app's projects store might live, best guess first.

    The app persists it via the Tauri ``store_set('projects', ...)`` command ->
    ``<appData>/store/projects.json``. ``SCPRISM_PROJECTS_STORE`` overrides
    (tests + odd installs). The ``<vault>/../store/projects.json`` guess only
    helps the DEFAULT vault (``<appData>/vault``); a user-chosen vault path
    lands elsewhere, which is exactly why the app-data path is tried first.
    """
    out: List[str] = []
    override = os.environ.get("SCPRISM_PROJECTS_STORE")
    if override:
        out.append(override)
    base = app_data_dir()
    if base:
        out.append(os.path.join(base, "store", "projects.json"))
    if vault:
        parent = os.path.dirname(os.path.abspath(str(vault)))
        out.append(os.path.join(parent, "store", "projects.json"))
    seen: set = set()
    unique: List[str] = []
    for path in out:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def _summarize_project(raw: Any) -> Optional[Dict[str, Any]]:
    """Name / status / step summary for ONE stored project, defensively.

    Deliberately narrow: the store also holds the goal, the full plan text and
    the whole interview transcript — none of that belongs in a status view, so
    only the name, the status, the step position and the app's own one-line
    note come back. A non-dict entry yields None (skipped, never guessed at).
    """
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "(unnamed project)"
    # Bounded exactly like `note` below: a project name is a label, and a stored
    # one can be arbitrarily long (nothing validates it on the way in).
    name = name.strip()[:160]
    status = raw.get("status")
    if not isinstance(status, str) or not status.strip():
        status = "unknown"
    plan = raw.get("plan")
    steps = len(plan) if isinstance(plan, list) else 0
    step = raw.get("stepIndex")
    step = step if isinstance(step, int) and step >= 0 else 0
    note = raw.get("lastNote")
    note = note.strip()[:160] if isinstance(note, str) else ""
    return {
        "name": name,
        "status": status.strip(),
        "step": step,
        "steps": steps,
        "note": note,
    }


def project_status(
    *, store_path: Optional[str] = None, vault: Optional[str] = None
) -> Dict[str, Any]:
    """Read-only view of the app's projects store: name / status / step only.

    Defensive by construction — a missing store is an honest SUCCESS saying "no
    project data available" (the app simply has no projects yet), and a
    malformed/unreadable store is an honest ``isError`` saying the same thing
    with the reason. Neither ever raises, and neither ever invents a project.

    Every model-facing message names the store by its BASENAME. The full path is
    ``/Users/<name>/Library/Application Support/...`` — the user's real name and
    home directory, which the model has no use for and which would ride into any
    reply that quotes the error. The structured ``store_path`` still carries the
    real path for the app's own use (extras never reach the model).
    """
    candidates = [store_path] if store_path else projects_store_candidates(vault)
    found = next((p for p in candidates if p and os.path.isfile(p)), None)
    if found is None:
        looked = ", ".join(
            sorted({os.path.basename(p) for p in candidates if p}) or ["projects.json"]
        )
        return _text(
            "No project data available — no projects store (%s) in the app's data "
            "folder. The app writes it once projects exist." % looked,
            projects=[],
            total=0,
            store_path=None,
        )
    label = os.path.basename(found)
    try:
        with open(found, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return _error(
            "no project data available: the projects store %s could not be read "
            "(%s)" % (label, exc)
        )
    raw_projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(raw_projects, list):
        return _error(
            "no project data available: the projects store %s is malformed "
            "(no 'projects' list)" % label
        )
    projects = [p for p in (_summarize_project(r) for r in raw_projects) if p]
    if not projects:
        return _text(
            "No project data available — the projects store %s holds no "
            "projects." % label,
            projects=[],
            total=0,
            store_path=found,
        )
    # Capped like a listing, with the same honest "… N more" note: a status view
    # of 400 projects is not a status view, it is the whole store.
    shown = projects[:MAX_PROJECT_ENTRIES]
    lines = ["%d project(s):" % len(projects), ""]
    for i, p in enumerate(shown, 1):
        line = "%d. %s — %s" % (i, p["name"], p["status"])
        if p["steps"]:
            line += " · step %d/%d" % (min(p["step"] + 1, p["steps"]), p["steps"])
        lines.append(line)
        if p["note"]:
            lines.append("   note: %s" % p["note"])
    if len(projects) > len(shown):
        lines.append("")
        lines.append(
            "… %d more project(s) not shown (cap %d)."
            % (len(projects) - len(shown), MAX_PROJECT_ENTRIES)
        )
    return _text(
        "\n".join(lines),
        projects=shown,
        total=len(projects),
        store_path=found,
    )


# -- the governed provider ---------------------------------------------------


class VaultToolProvider:
    """MCPClient-SHAPED vault tool source — governed exactly like the web/MCP
    sources (``list_tools`` + ``call_tool`` + ``parent_span_id`` + ``telemetry``).

    ``call_tool`` runs the allowlist, emits a truthful ``tool_exec`` span
    (``provider="vault"``) and dispatches to the module functions above. A
    blocked call raises ``mcp.MCPBlockedError`` after emitting a ``blocked=True``
    span, exactly like ``WebToolProvider`` — so an ``ApprovalGate`` wrapping this
    source holds a vault call the same way it holds any other.
    """

    def __init__(
        self,
        vault: str,
        *,
        telemetry: Optional[Any] = None,
        server_name: str = "vault",
        allowed_tools: Optional[Sequence[str]] = None,
        max_read_chars: int = MAX_READ_CHARS,
        max_list_entries: int = MAX_LIST_ENTRIES,
        max_search_hits: int = MAX_SEARCH_HITS,
        projects_store: Optional[str] = None,
    ) -> None:
        self.vault = str(vault)
        self.telemetry = telemetry
        self.parent_span_id: Optional[str] = None
        # The audit provider tag for THIS source's spans (incl. a withheld-result
        # governance span emitted by the loop) — a vault tool is honestly "vault".
        self.provider = "vault"
        self.server_name = server_name
        self.allowed_tools: Optional[set] = (
            None if allowed_tools is None else set(allowed_tools)
        )
        self.max_read_chars = int(max_read_chars)
        self.max_list_entries = int(max_list_entries)
        self.max_search_hits = int(max_search_hits)
        # None -> discover the app's store at call time (projects_store_candidates).
        self.projects_store = projects_store

    def list_tools(self) -> List[MCPTool]:
        return [
            MCPTool(
                name="vault_list",
                description=(
                    "List files in the user's knowledge vault — names and sizes "
                    "ONLY, never contents. Optional argument: subdir (string) to "
                    "narrow the listing."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"subdir": {"type": "string"}},
                },
            ),
            MCPTool(
                name="vault_read",
                description=(
                    "Read one note from the vault and return its real text "
                    "(size-capped; a truncation is stated). Argument: path "
                    "(string), relative to the vault root."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            ),
            MCPTool(
                name="vault_search",
                description=(
                    "Search the vault by filename and file contents "
                    "(case-insensitive) and return matching paths with short "
                    "real snippets. Argument: query (string)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            ),
            MCPTool(
                name="project_status",
                description=(
                    "Read-only status of the user's projects (name, status, step "
                    "position) from the app's own store. No arguments."
                ),
                input_schema={"type": "object", "properties": {}},
            ),
        ]

    def _blocked_reason(self, name: str, arguments: Dict[str, Any]) -> Optional[str]:
        """Return why the call is blocked, or None. Mirrors ``MCPClient`` /
        ``WebToolProvider`` for the ALLOWLIST. There is deliberately no
        ``SENSITIVE_KEYWORDS`` gate on the arguments: a vault tool egresses
        nothing (it reads local files the user owns), so an argument gate would
        only re-blind the companion on its own notes. The floor that matters —
        vault CONTENT never reaching a cloud POST — is the loop's vault egress
        floor: reading the vault forces the rest of the run local (and withholds
        the content outright when there is no local model to route to).
        """
        if self.allowed_tools is not None and name not in self.allowed_tools:
            return "tool '%s' is not allowed" % name
        return None

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Governed dispatch. Blocks (raises ``MCPBlockedError``) before any read."""
        arguments = arguments or {}
        blocked_reason = self._blocked_reason(name, arguments)
        if blocked_reason is not None:
            if self.telemetry is not None:
                with self.telemetry.span(
                    "tool_exec",
                    span_type="tool_exec",
                    parent=self.parent_span_id,
                    provider="vault",
                    server=self.server_name,
                    tool=name,
                    blocked=True,
                ) as sp:
                    sp.set(reason=blocked_reason)
                    sp.set_status("error")
            raise MCPBlockedError(blocked_reason)

        if self.telemetry is not None:
            with self.telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=self.parent_span_id,
                provider="vault",
                server=self.server_name,
                tool=name,
            ) as sp:
                result = self._dispatch(name, arguments)
                sp.set(is_error=bool(result.get("isError")))
                # WHICH note was opened, so the run stream and the Console can
                # disclose "read your vault · notes/health.md" rather than a bare
                # "a tool ran". Taken from the RESULT (vault-relative, confined,
                # only ever set on a successful read) — never the model-supplied
                # argument, which may be a refused escape attempt.
                #
                # And never the ARGUMENTS, full stop. A vault tool egresses
                # nothing, so its arguments may name material that has never
                # left this machine; recording them would make spans.jsonl the
                # first place that material goes. `webtools.py` may record a URL
                # or a query only because those ALREADY egressed — see THE
                # PRIVACY LINE there. This module is on the other side of it.
                rel = result.get("path")
                if isinstance(rel, str) and rel:
                    sp.set(path=rel)
                return result
        return self._dispatch(name, arguments)

    def _dispatch(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if name == "vault_list":
            subdir = arguments.get("subdir")
            if subdir is not None and not isinstance(subdir, str):
                return _error("vault_list 'subdir' must be a string when given")
            return vault_list(
                self.vault, subdir, max_entries=self.max_list_entries
            )
        if name == "vault_read":
            return vault_read(
                self.vault, arguments.get("path"), max_chars=self.max_read_chars
            )
        if name == "vault_search":
            return vault_search(
                self.vault, arguments.get("query"), max_hits=self.max_search_hits
            )
        if name == "project_status":
            return project_status(store_path=self.projects_store, vault=self.vault)
        return _error("unknown tool %r" % name)
