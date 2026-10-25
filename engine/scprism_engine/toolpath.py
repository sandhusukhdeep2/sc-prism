"""Where command-line tools actually live (the GUI-PATH problem).

A GUI-launched app inherits a MINIMAL PATH (``/usr/bin:/bin:/usr/sbin:/sbin``),
so anything installed by Homebrew, npm, bun, volta or **nvm** is invisible —
to the engine AND to every subprocess the engine spawns, including Tier-1's
verify shell. That is why the user's `npm test` gate failed 51 runs in a row
with ``/bin/sh: npm: command not found``: not a failing test, a missing PATH.

This module is the single source of truth for the extra install directories.
``gateway.py`` uses it to find the subscription CLIs (``claude`` / ``gemini`` /
``codex``); ``verifier.py`` uses it to give the deterministic gate a PATH that
really contains the verify command. The Tauri shell mirrors the same list in
``src-tauri/src/lib.rs`` so the engine process is born with a real PATH too.

nvm is handled specially: it installs per-version under
``~/.nvm/versions/node/<version>/bin`` with NO stable symlink, so the directory
list is globbed and sorted newest-version-first.
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Sequence, Tuple

# Static install dirs, highest priority first. Mirrors `check_cli` in lib.rs.
STATIC_DIRS: Tuple[str, ...] = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.local/bin",
    "~/.npm-global/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "~/bin",
)

DEFAULT_NVM_ROOT = "~/.nvm/versions/node"


def _version_key(name: str) -> Tuple[int, ...]:
    """Sort key for an nvm directory name (``v22.14.0`` -> ``(22, 14, 0)``).

    Non-numeric fragments sort as 0 so a weird name can never crash discovery.
    """
    cleaned = name[1:] if name.startswith("v") else name
    parts: List[int] = []
    for frag in cleaned.split(".")[:4]:
        digits = "".join(c for c in frag if c.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def nvm_bin_dirs(nvm_root: Optional[str] = None) -> List[str]:
    """Every installed nvm node ``bin`` dir, NEWEST VERSION FIRST.

    Empty when nvm is not installed — never raises.
    """
    root = os.path.expanduser(nvm_root or DEFAULT_NVM_ROOT)
    try:
        names = os.listdir(root)
    except OSError:
        return []
    versions = [n for n in names if os.path.isdir(os.path.join(root, n, "bin"))]
    versions.sort(key=_version_key, reverse=True)
    return [os.path.join(root, n, "bin") for n in versions]


def search_dirs(nvm_root: Optional[str] = None) -> List[str]:
    """The extra dirs to search, in priority order (static, then nvm)."""
    return [os.path.expanduser(d) for d in STATIC_DIRS] + nvm_bin_dirs(nvm_root)


def enriched_path(base: Optional[str] = None, nvm_root: Optional[str] = None) -> str:
    """``base`` PATH with the install dirs appended (order kept, no duplicates).

    The inherited PATH keeps priority — we only ADD places to look, so a user
    who deliberately shims a tool still wins.
    """
    if base is None:
        base = os.environ.get("PATH", "")
    parts: List[str] = [p for p in base.split(os.pathsep) if p]
    seen = set(parts)
    for d in search_dirs(nvm_root):
        if d not in seen:
            parts.append(d)
            seen.add(d)
    return os.pathsep.join(parts)


def env_with_path(
    env: Optional[Dict[str, str]] = None, nvm_root: Optional[str] = None
) -> Dict[str, str]:
    """A copy of ``env`` (default ``os.environ``) whose PATH can find tools."""
    out = dict(os.environ if env is None else env)
    out["PATH"] = enriched_path(out.get("PATH"), nvm_root)
    return out


def which(bin_name: str, extra_dirs: Optional[Sequence[str]] = None) -> Optional[str]:
    """Absolute path of ``bin_name``: PATH first, then the install dirs."""
    import shutil

    found = shutil.which(bin_name)
    if found:
        return found
    dirs = list(extra_dirs) if extra_dirs is not None else search_dirs()
    for d in dirs:
        cand = os.path.join(os.path.expanduser(d), bin_name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None
