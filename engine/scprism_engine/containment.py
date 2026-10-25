"""Containment for shell commands: deny the secrets, deny self-approval.

This is a DENY-LIST, not a jail, and the distinction is the whole design.

A write-jail — "the command may only write under one root" — was the first
draft, and attacking it killed it twice over. Confining writes to the vault
would have made containment the *escalation*: the vault holds
``mcp-approvals.json``, and approval is granted by tool NAME and is permanent,
so a command able to write that file could grant itself every future tool. And
confining writes to the project would break the tool's actual job, since the
commands this product exists to run — ``npm test``, ``cargo build``, ``pip
install`` — legitimately write to caches, temp dirs and lockfiles all over the
filesystem. A containment that blocks ``npm test`` teaches the user to switch
it off, which leaves them with nothing.

So this closes the two paths that are real, verified, and have no legitimate
use inside a coding task:

1.  READING THE CREDENTIAL STORES. Measured on this machine: the app's own
    ``settings.json`` holds a live 53-character provider API key, and a plain
    shell command reads it in full. Scrubbing environment variables — the
    obvious move — is theatre while that file is readable, because the key was
    never in the environment to begin with. The same applies to ``~/.ssh``,
    ``~/.aws`` and friends.

2.  WRITING THE GOVERNANCE FILES. A command that can rewrite
    ``mcp-approvals.json`` can approve itself, permanently, for everything.

Everything else is allowed, deliberately and out loud. See CONTAINMENT_LIMITS
for what this does not do.
"""

from __future__ import annotations

import os
import shutil
from typing import Dict, List, Optional, Sequence

SANDBOX_EXEC = "/usr/bin/sandbox-exec"

# Directories whose contents are credentials. Denied for READ.
_SECRET_DIRS = (
    "~/Library/Application Support/com.slashcreative.scprism",
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/gh",
    "~/.docker",
    "~/.kube",
    "~/Library/Keychains",
)

# Environment variables that carry credentials. Removed from the child's env.
# This is belt-and-braces: the file denies above are what actually matter,
# because a key in a file is not in the environment.
_SECRET_ENV_PREFIXES = (
    "ANTHROPIC", "CLAUDE", "OPENAI", "GEMINI", "GOOGLE_API", "AWS_", "AZURE",
    "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "HF_", "SLACK_", "STRIPE",
)
_SECRET_ENV_SUBSTRINGS = ("_KEY", "_SECRET", "_TOKEN", "PASSWORD", "PASSWD")

# Said plainly wherever this is described, so nobody reads "contained" as
# "sandboxed". Every clause here was verified by measurement, not assumed.
CONTAINMENT_LIMITS = (
    "This is a deny-list, not a sandbox. The command still runs as your user "
    "and can read and write your files, reach the network, and use your "
    "installed tools. What it cannot do is read your saved credentials or "
    "rewrite SC Prism's own approval file. Tier-1 verification commands run "
    "outside this containment."
)


def _expand(path: str) -> str:
    return os.path.realpath(os.path.expanduser(path))


def secret_paths() -> List[str]:
    """The credential directories that exist on this machine."""
    out = []
    for raw in _SECRET_DIRS:
        p = _expand(raw)
        if os.path.exists(p):
            out.append(p)
    return out


def scrub_env(env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """A copy of `env` with credential-shaped variables removed.

    Belt-and-braces only — the file denies are what close the real path. A key
    that lives in a JSON file was never in the environment.
    """
    src = dict(os.environ if env is None else env)
    out = {}
    for key, value in src.items():
        upper = key.upper()
        if any(upper.startswith(p) for p in _SECRET_ENV_PREFIXES):
            continue
        if any(s in upper for s in _SECRET_ENV_SUBSTRINGS):
            continue
        out[key] = value
    return out


def build_profile(vault: str = "") -> str:
    """The sandbox-exec profile: allow by default, deny the two real paths.

    Written inline (passed with ``-p``) rather than to a file on purpose: a
    profile file inside a directory the command can write is a profile the
    command can rewrite.
    """
    clauses = ["(version 1)", "(allow default)"]
    for path in secret_paths():
        clauses.append(f'(deny file-read* (subpath "{path}"))')
    if vault:
        v = _expand(vault)
        # Only the governance surface is write-denied — not the whole vault.
        # An agent writing notes and verdicts into the vault is the product
        # working; an agent rewriting its own approvals is the product failing.
        for name in ("mcp-approvals.json", "approvals", "governance"):
            clauses.append(f'(deny file-write* (subpath "{os.path.join(v, name)}"))')
            clauses.append(f'(deny file-write* (literal "{os.path.join(v, name)}"))')
    return "".join(clauses)


def available() -> bool:
    """Whether containment can be applied on this machine."""
    return bool(shutil.which(SANDBOX_EXEC) or os.path.exists(SANDBOX_EXEC))


def contain(argv: Sequence[str], vault: str = "") -> List[str]:
    """Wrap `argv` in sandbox-exec, or return it unchanged if unavailable.

    Degrading to the uncontained command is deliberate: the alternative is
    refusing to run at all on a machine without sandbox-exec, which would break
    the tool for a containment that machine cannot provide anyway. The caller
    reports which happened, so the span never claims containment that was not
    applied.
    """
    if not available():
        return list(argv)
    return [SANDBOX_EXEC, "-p", build_profile(vault), *argv]
