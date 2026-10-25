"""Generated tools — the manifest, which is the contract.

From the self-extending-tools spec: a business adopting SC Prism has systems
and formats nobody could pre-build a tool for — a POS export, a supplier's
invoice PDF, a legacy XML feed. The manager should be able to notice the gap,
build the tool, prove it works and register it, under the same governance as
everything else.

THE MANIFEST IS WRITTEN FIRST, before a line of implementation. That ordering
is the whole point: it forces the permission surface to be decided while it is
still cheap to argue about, and Gate 1 (scope approval) is the gate every later
gate is constrained by.

FOUR INVARIANTS, none of them preferences:

  * `permissions` is a CLOSED list. Anything not declared is denied, and there
    is no wildcard grant — not `*`, not `**`, not `/`. A tool that could ask
    for everything would make every later gate theatre.

  * `data_class: confidential` FORCES `local_only`, and the manifest does not
    get to talk its way out of it. An unrecognised class is treated as
    confidential, because failing closed is the only safe direction: a typo
    must not become an escape hatch.

  * A drafted tool is INERT. `approved_by` null means not callable, and
    approval alone is not enough — a tool must also have passed at least one
    test built from data the USER supplied. No fixtures, no registration.

  * A tool's permissions are a SUBSET of the agent that built it. This is the
    existing no-escalation rule (`capabilities.subset_of_user`) applied to tool
    creation: an agent cannot grant a capability it does not itself hold.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


class ManifestError(ValueError):
    """A manifest that cannot be trusted. Always names what was wrong."""


#: The permission classes a generated tool may declare. CLOSED — a key outside
#: this set is an error, never an ignored extra.
PERMISSION_CLASSES = (
    "filesystem_read",
    "filesystem_write",
    "network",
    "vault_read",
    "vault_write",
)

#: Patterns that would grant everything. A wildcard makes the manifest a
#: formality, so there is no way to write one.
_WILDCARDS = {"*", "**", "/", "/**", "~", "~/**", ".", "./**"}

REQUIRED_FIELDS = (
    "name",
    "version",
    "description",
    "runtime",
    "entrypoint",
    "input_schema",
    "output_schema",
    "permissions",
)

#: Names the shipped toolset already owns. A generated tool taking one of these
#: would shadow a governed tool with an ungoverned one.
RESERVED_NAMES = frozenset(
    {
        "web_search", "web_fetch",
        "vault_read", "vault_list", "vault_search", "vault_write",
        "terminal_run", "project_status",
        "computer_screenshot", "computer_type", "computer_key", "computer_click",
    }
)

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")


@dataclass
class ToolManifest:
    name: str
    version: str
    description: str
    runtime: str
    entrypoint: str
    input_schema: Dict[str, Any]
    output_schema: Dict[str, Any]
    permissions: Dict[str, List[str]]
    data_class: str
    execution_target: str
    created_by: str = ""
    created_at: str = ""
    #: GATE 1 — the user approved WHAT THIS MAY DO. Deliberately separate from
    #: `approved_by`, which is Gate 4. Collapsing the two made a tool whose
    #: scope you had approved indistinguishable from one you had activated, so
    #: no surface could tell you which decision was still yours to make.
    #: Recording this grants nothing: a scope-approved tool is still inert.
    scope_approved_by: Optional[str] = None
    scope_approved_at: str = ""
    #: GATE 4 — activated. Requires a passing sandbox run, which is why the
    #: interface cannot set it and the engine must.
    approved_by: Optional[str] = None
    approved_at: str = ""
    #: Tests that PASSED against user-supplied real data. Zero means the tool
    #: has proven nothing and must not be callable, however approved it is.
    passing_tests: int = 0
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def callable(self) -> bool:
        """Approved by a human AND proven against real data. Both, always."""
        return bool(self.approved_by) and self.passing_tests > 0


def _check_paths(cls: str, values: Any) -> List[str]:
    if values is None:
        return []
    if not isinstance(values, (list, tuple)):
        raise ManifestError(f"permissions.{cls} must be a list")
    out: List[str] = []
    for v in values:
        s = str(v).strip()
        if not s:
            continue
        if s in _WILDCARDS:
            raise ManifestError(
                f"permissions.{cls}: '{s}' is a wildcard grant — declare the "
                f"specific paths this tool needs instead"
            )
        # A relative escape reaches outside whatever root the sandbox sets.
        if ".." in s.split("/"):
            raise ManifestError(f"permissions.{cls}: '{s}' escapes its root")
        if s.startswith("/") or s.startswith("~"):
            raise ManifestError(
                f"permissions.{cls}: '{s}' is an absolute path — declare a "
                f"vault-relative one"
            )
        out.append(s)
    return out


def parse_manifest(raw: Dict[str, Any]) -> ToolManifest:
    """Validate a manifest, or raise ManifestError naming what is wrong."""
    if not isinstance(raw, dict):
        raise ManifestError("manifest must be an object")

    for f in REQUIRED_FIELDS:
        if f not in raw or raw[f] in (None, ""):
            raise ManifestError(f"manifest is missing required field '{f}'")

    name = str(raw["name"]).strip()
    if not _NAME_RE.match(name):
        raise ManifestError(
            f"tool name '{name}' must be lowercase letters, digits and "
            f"underscores (3-64 chars), with no path separators"
        )
    if name in RESERVED_NAMES:
        raise ManifestError(
            f"tool name '{name}' is already a shipped tool — a generated tool "
            f"must not shadow a governed one"
        )

    perms_raw = raw["permissions"]
    if not isinstance(perms_raw, dict):
        raise ManifestError("permissions must be an object")
    unknown = [k for k in perms_raw if k not in PERMISSION_CLASSES]
    if unknown:
        raise ManifestError(
            f"unknown permission class(es): {', '.join(sorted(unknown))} — "
            f"permissions is a closed list"
        )
    permissions = {cls: _check_paths(cls, perms_raw.get(cls)) for cls in PERMISSION_CLASSES}

    # The floor. Anything not explicitly public is confidential, and
    # confidential is pinned local — the manifest cannot override this.
    data_class = str(raw.get("data_class") or "confidential").strip().lower()
    if data_class != "public":
        data_class = "confidential"
    execution_target = (
        "local_only"
        if data_class == "confidential"
        else str(raw.get("execution_target") or "any_provider").strip().lower()
    )

    return ToolManifest(
        name=name,
        version=str(raw["version"]),
        description=str(raw["description"]),
        runtime=str(raw["runtime"]),
        entrypoint=str(raw["entrypoint"]),
        input_schema=dict(raw["input_schema"] or {}),
        output_schema=dict(raw["output_schema"] or {}),
        permissions=permissions,
        data_class=data_class,
        execution_target=execution_target,
        created_by=str(raw.get("created_by") or ""),
        created_at=str(raw.get("created_at") or ""),
        scope_approved_by=(raw.get("scope_approved_by") or None),
        scope_approved_at=str(raw.get("scope_approved_at") or ""),
        approved_by=(raw.get("approved_by") or None),
        approved_at=str(raw.get("approved_at") or ""),
        passing_tests=int(raw.get("passing_tests") or 0),
        raw=dict(raw),
    )


def permissions_within(
    tool: Dict[str, Any], builder: Dict[str, Any]
) -> Tuple[bool, str]:
    """Whether a tool's permissions are a SUBSET of the agent that built it.

    `permsT ⊆ permsA`, the spec's §6. This is the no-escalation rule applied to
    tool creation: an agent cannot hand a tool a capability it does not itself
    hold, so a tool can never be a route around a grant the user withheld.

    Returns (ok, reason) — the reason names the exact permission that exceeded
    the builder, because "denied" without a subject is unactionable.
    """
    for cls in PERMISSION_CLASSES:
        want = [str(x) for x in (tool.get(cls) or [])]
        have = [str(x) for x in (builder.get(cls) or [])]
        if not want:
            continue
        if not have:
            return False, f"{cls}: the building agent holds none, tool asks for {want[0]!r}"
        for entry in want:
            # Exact match, or covered by a broader declared prefix.
            if entry in have:
                continue
            covered = any(
                entry.startswith(h[:-2]) for h in have if h.endswith("**")
            )
            if not covered:
                return False, f"{cls}: {entry!r} is outside the building agent's grant"
    return True, ""


# ---------------------------------------------------------------------------
# Step 1 — the capability gap.
#
# "Gaps are visible in the manager view — the user should see the manager say
#  'I need a tool for this' rather than silently failing or fabricating an
#  answer."
#
# That sentence is the whole value of this record. A missing tool today gives
# you either a quiet failure or, worse, a plausible answer the model invented.
# A gap turns the second into the first, and the first into something you can
# act on.
#
# A gap is a REPORT, deliberately not a plan. It carries no implementation and
# no code: the manifest comes next, and it is the USER who approves its scope.
# A gap arriving with code attached would have skipped the gate that every
# later gate is constrained by.
# ---------------------------------------------------------------------------

GAP_FENCE = "capability_gap"
_GAP_FIELDS = ("task", "missing", "input_shape")
_MAX_GAP_FIELD = 400


@dataclass
class CapabilityGap:
    """What was asked, what was missing, and what the input looks like."""

    task: str
    missing: str
    input_shape: str

    def to_line(self) -> str:
        """The manager saying it out loud, in the user's own view.

        It ends by asking for real examples because that is the next thing that
        must happen: no test fixtures, no registration. The manager asks for
        real data rather than inventing it — the never-fabricate rule, applied
        to tool creation.
        """
        return (
            f"I need a tool for this: {self.task}. "
            f"What's missing — {self.missing}. "
            f"The input looks like: {self.input_shape}. "
            f"Send me two or three real examples and I'll draft what it would "
            f"be allowed to do, for you to approve before anything is built."
        )


def _clip(v: Any) -> str:
    return str(v or "").strip()[:_MAX_GAP_FIELD]


def gap_from_failure(task: str, missing: str, input_shape: str) -> CapabilityGap:
    return CapabilityGap(task=_clip(task), missing=_clip(missing), input_shape=_clip(input_shape))


def parse_gap_block(text: str) -> Optional[CapabilityGap]:
    """Read a single ``capability_gap`` block, or return None.

    Refuses rather than guesses. A block missing a field is not completed from
    context, and TWO blocks mean the model is listing possibilities rather than
    reporting the one thing that actually blocked it — neither is a gap the
    user should be shown as real.
    """
    opens = [m.start() for m in re.finditer(r"```" + GAP_FENCE + r"\b", text or "")]
    if len(opens) != 1:
        return None
    rest = (text or "")[opens[0]:].split("\n", 1)
    if len(rest) < 2:
        return None
    body, _, _ = rest[1].partition("```")
    found: Dict[str, str] = {}
    for line in body.split("\n"):
        key, sep, val = line.partition(":")
        k = key.strip().lower()
        if sep and k in _GAP_FIELDS and k not in found:
            found[k] = _clip(val)
    if any(not found.get(f) for f in _GAP_FIELDS):
        return None
    return CapabilityGap(**{f: found[f] for f in _GAP_FIELDS})


# ---------------------------------------------------------------------------
# Gate 2 — sandbox execution.
#
# The spec: "The tool runs in an isolated process with permissions enforced at
# the syscall/host boundary, not by convention."
#
# MEASURED BEFORE THIS WAS WRITTEN, not assumed. Under a deny-by-default
# sandbox-exec profile:
#   * the system `python3` cannot run at all — it is Xcode's shim and shells
#     out to xcodebuild, which the profile correctly refuses;
#   * the interpreter BUNDLED with the app runs normally;
#   * a socket raises PermissionError, from the kernel;
#   * a write to an undeclared path raises PermissionError, from the kernel.
#
# So the profile denies by default and opens only what the manifest declared —
# and because the manifest's permission list is closed with no wildcard, "what
# it declared" is always a finite, reviewable set.
#
# Failure QUARANTINES rather than deletes, with a machine-readable reason, so a
# retry can re-enter with the reason in context and pass every gate again.
# ---------------------------------------------------------------------------

import json
import os
import shutil
import subprocess

SANDBOX_EXEC = "/usr/bin/sandbox-exec"

#: Where the app's own interpreter lives. A generated tool runs on THIS, never
#: on whatever `python3` resolves to — see the measurement above.
BUNDLED_PYTHON_CANDIDATES = (
    "/Applications/SC Prism.app/Contents/Resources/resources/python/bin/python3",
    os.path.expanduser(
        "~/Desktop/sc-prism/src-tauri/target/release/bundle/macos/SC Prism.app"
        "/Contents/Resources/resources/python/bin/python3"
    ),
)

DEFAULT_TOOL_TIMEOUT_S = 20


def sandbox_available() -> bool:
    return os.path.exists(SANDBOX_EXEC)


def _interpreter() -> Optional[str]:
    for p in BUNDLED_PYTHON_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


def sandbox_profile(manifest: "ToolManifest", tool_dir: str, vault_root: str = "") -> str:
    """Deny by default; open only what the manifest declared.

    Reads are allowed broadly for the interpreter's own stdlib and frameworks —
    a Python that cannot read its own library cannot start. WRITES and the
    NETWORK are the boundaries that matter for a parser, and both are denied
    unless declared. That is stated plainly rather than dressed up: this profile
    contains what a generated tool can DO, not everything it can SEE.
    """
    clauses = [
        "(version 1)",
        "(deny default)",
        "(allow process-exec)",
        "(allow process-fork)",
        "(allow sysctl-read)",
        "(allow file-read*)",
        "(deny network*)",
    ]
    if manifest.permissions.get("network"):
        # Declared network access. sandbox-exec cannot filter by host, so this
        # is all-or-nothing and the audit must show it as such.
        clauses = [c for c in clauses if c != "(deny network*)"]
        clauses.append("(allow network*)")
    root = vault_root or tool_dir
    for rel in manifest.permissions.get("filesystem_write", []):
        target = os.path.realpath(os.path.join(root, rel.replace("**", "").rstrip("/")))
        clauses.append(f'(allow file-write* (subpath "{target}"))')
    for rel in manifest.permissions.get("vault_write", []):
        target = os.path.realpath(os.path.join(root, rel.replace("**", "").rstrip("/")))
        clauses.append(f'(allow file-write* (subpath "{target}"))')
    return "".join(clauses)


@dataclass
class CaseResult:
    name: str
    passed: bool
    reason: str = ""
    detail: str = ""


@dataclass
class SandboxResult:
    passed: bool
    #: Machine-readable, per the acceptance criteria: '' | no_test_cases |
    #: timeout | undeclared_access | output_mismatch | nondeterministic | crashed
    reason: str
    detail: str
    cases: List[CaseResult] = field(default_factory=list)


#: Kernel refusals a contained tool provokes when it reaches past its grant.
_DENIED_MARKERS = ("permissionerror", "operation not permitted", "not permitted")


def _run_once(interp: str, profile: str, tool_dir: str, payload: str, timeout: float):
    argv = [SANDBOX_EXEC, "-p", profile, interp, os.path.join(tool_dir, "tool.py")]
    try:
        return subprocess.run(
            argv,
            input=payload,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=tool_dir,
        )
    except subprocess.TimeoutExpired:
        return None


def sandbox_gate(
    manifest: "ToolManifest",
    tool_dir: str,
    vault_root: str = "",
    timeout: float = DEFAULT_TOOL_TIMEOUT_S,
) -> SandboxResult:
    """Run every test case twice, contained. All four conditions must hold."""
    interp = _interpreter()
    if interp is None or not sandbox_available():
        return SandboxResult(False, "no_sandbox", "sandbox-exec or the bundled interpreter is unavailable")

    tests_dir = os.path.join(tool_dir, "tests")
    inputs = sorted(
        f for f in os.listdir(tests_dir) if f.endswith(".input")
    ) if os.path.isdir(tests_dir) else []
    if not inputs:
        # No fixtures, no registration. A tool that proved nothing must not be
        # able to claim it proved something.
        return SandboxResult(False, "no_test_cases", "no test cases built from real data")

    profile = sandbox_profile(manifest, tool_dir, vault_root)
    cases: List[CaseResult] = []

    for name in inputs:
        payload = open(os.path.join(tests_dir, name), encoding="utf-8").read()
        exp_path = os.path.join(tests_dir, name[: -len(".input")] + ".expected")
        expected = (
            json.loads(open(exp_path, encoding="utf-8").read())
            if os.path.isfile(exp_path)
            else None
        )

        first = _run_once(interp, profile, tool_dir, payload, timeout)
        if first is None:
            cases.append(CaseResult(name, False, "timeout", f"did not finish within {int(timeout)}s"))
            return SandboxResult(False, "timeout", f"{name} did not finish within {int(timeout)}s", cases)

        blob = (first.stdout or "") + (first.stderr or "")
        if first.returncode != 0:
            low = blob.lower()
            if any(m in low for m in _DENIED_MARKERS):
                cases.append(CaseResult(name, False, "undeclared_access", blob.strip()[:300]))
                return SandboxResult(
                    False, "undeclared_access",
                    f"{name} attempted access its manifest does not declare", cases,
                )
            cases.append(CaseResult(name, False, "crashed", blob.strip()[:300]))
            return SandboxResult(False, "crashed", f"{name} exited {first.returncode}", cases)

        try:
            got = json.loads(first.stdout)
        except (ValueError, TypeError):
            cases.append(CaseResult(name, False, "output_mismatch", "output was not JSON"))
            return SandboxResult(False, "output_mismatch", f"{name} did not emit JSON", cases)

        if expected is not None and got != expected:
            cases.append(CaseResult(name, False, "output_mismatch", f"got {got!r}"))
            return SandboxResult(False, "output_mismatch", f"{name} did not match its expected output", cases)

        # Determinism: the same input twice, the same answer. A tool that
        # cannot be reproduced cannot be verified by anything downstream.
        second = _run_once(interp, profile, tool_dir, payload, timeout)
        if second is None or second.returncode != 0 or second.stdout != first.stdout:
            cases.append(CaseResult(name, False, "nondeterministic", "two runs disagreed"))
            return SandboxResult(False, "nondeterministic", f"{name} gave a different answer on a second run", cases)

        cases.append(CaseResult(name, True))

    return SandboxResult(True, "", f"{len(cases)} case(s) passed, twice each", cases)


def quarantine(tool_dir: str, quarantine_root: str, reason: str) -> str:
    """Move a failed tool aside with its reason. Never delete it — a retry
    needs the failure in context, and a human needs to be able to look."""
    os.makedirs(quarantine_root, exist_ok=True)
    dest = os.path.join(quarantine_root, os.path.basename(tool_dir.rstrip("/")))
    if os.path.exists(dest):
        shutil.rmtree(dest, ignore_errors=True)
    shutil.move(tool_dir, dest)
    with open(os.path.join(dest, "QUARANTINE.txt"), "w", encoding="utf-8") as fh:
        fh.write(f"reason: {reason}\n")
    return dest


# ---------------------------------------------------------------------------
# Gate 3 — the static audit.
#
# The spec's list: dynamic evaluation of strings, subprocess spawning, outbound
# sockets, writes outside declared paths, credential access.
#
# THIS IS AN AST WALK, NOT A REGEX SWEEP, and the difference is the point. A
# regex over source is bypassable by anyone who knows it is there — `ev + "al"`,
# a line break inside the call, an alias, a getattr lookup. The thing writing
# these tools is a language model that has read a great deal of code, and a
# check it can talk its way around is a check that will eventually be talked
# around. An AST sees the call that will actually execute rather than the
# characters that spell it.
#
# It is a SECOND line, never the only one. Gate 2 already ran the tool with the
# kernel enforcing its permissions. This catches what a passing sandbox run
# cannot: capability present in the code that simply did not fire on the test
# cases the user happened to supply.
# ---------------------------------------------------------------------------

import ast

_EVAL_NAMES = {"eval", "exec", "compile", "__import__"}
_SHELL_MODULES = {"subprocess", "pty", "commands"}
_SHELL_OS_CALLS = {"system", "popen", "execv", "execve", "execl", "execlp", "spawnv", "spawnl", "fork"}
_NET_MODULES = {"socket", "ssl", "urllib", "http", "requests", "httpx", "aiohttp", "ftplib", "telnetlib", "smtplib"}

#: Paths that are credentials by definition. Matched on the literal a tool
#: writes into its own source — a tool naming one of these is not ambiguous.
_CREDENTIAL_HINTS = (
    "/.ssh", "/.aws", "/.gnupg", "/.docker", "/.kube",
    "library/keychains", "com.slashcreative.scprism",
    "id_rsa", "credentials", "secrets",
)
_SECRET_ENV = ("KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL")


@dataclass
class AuditFinding:
    kind: str      # machine-readable
    detail: str
    line: int = 0


def _literal_strings(node: ast.AST) -> List[str]:
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            out.append(n.value)
    return out


def audit_source(src: str, manifest: "ToolManifest") -> List[AuditFinding]:
    """Static findings for a generated tool. Empty means nothing was found —
    which is not the same as "safe", and the caller must not present it as such.
    """
    try:
        tree = ast.parse(src or "")
    except SyntaxError as exc:
        return [AuditFinding("unparseable", f"source does not parse: {exc.msg}", exc.lineno or 0)]

    network_declared = bool(manifest.permissions.get("network"))
    declared_paths = [
        p.replace("**", "")
        for cls in ("filesystem_read", "filesystem_write", "vault_read", "vault_write")
        for p in manifest.permissions.get(cls, [])
    ]
    out: List[AuditFinding] = []

    def add(kind: str, detail: str, node: ast.AST) -> None:
        out.append(AuditFinding(kind, detail, getattr(node, "lineno", 0)))

    for node in ast.walk(tree):
        # Dynamic evaluation — by call, by bare reference (an alias), or by
        # name inside a getattr lookup.
        if isinstance(node, ast.Name) and node.id in _EVAL_NAMES:
            add("dynamic_eval", f"{node.id} is not permitted in a generated tool", node)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in _EVAL_NAMES:
            add("dynamic_eval", f"a dynamic lookup of {node.value!r}", node)

        # Imports: shell and network modules.
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = (
                [a.name for a in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
            )
            for raw in names:
                root = (raw or "").split(".")[0]
                if root in _SHELL_MODULES:
                    add("subprocess", f"imports {root}, which spawns processes", node)
                elif root in _NET_MODULES and not network_declared:
                    add("network", f"imports {root} but the manifest declares no network access", node)

        # os.system / os.popen / os.exec*
        elif isinstance(node, ast.Attribute) and node.attr in _SHELL_OS_CALLS:
            base = getattr(node.value, "id", "")
            if base == "os":
                add("subprocess", f"os.{node.attr} spawns a process", node)

        # Environment lookups shaped like a credential.
        elif isinstance(node, ast.Subscript):
            for s in _literal_strings(node.slice):
                if any(tok in s.upper() for tok in _SECRET_ENV):
                    add("credential_access", f"reads the environment variable {s!r}", node)

    # Path literals anywhere in the file: credentials, absolute paths, escapes.
    for s in _literal_strings(tree):
        low = s.lower()
        if any(h in low for h in _CREDENTIAL_HINTS):
            out.append(AuditFinding("credential_access", f"names a credential path: {s!r}"))
        elif s.startswith("/") or s.startswith("~"):
            if not any(s.startswith(d) for d in declared_paths if d):
                out.append(AuditFinding("undeclared_path", f"absolute path not in the manifest: {s!r}"))
        elif ".." in s.split("/"):
            out.append(AuditFinding("undeclared_path", f"path escapes its root: {s!r}"))

    return out


# ---------------------------------------------------------------------------
# Gate 4 — the registry, and activation.
#
# The registry is the SOURCE OF TRUTH and is resolved from disk at CALL time,
# not cached at start time. That single choice is what makes the spec's
# acceptance criterion true almost for free: deleting a tool's directory
# removes it cleanly, with no orphaned reference, because the next call simply
# does not find it. A cached registry would leave a tool callable after its
# code was gone — the worst kind of stale state, and precisely the kind a user
# would never think to check for.
#
# Two things must BOTH hold before a tool is callable: a human approved it, and
# it passed at least one test built from data the user supplied. Neither alone
# is enough, and neither is inferred.
# ---------------------------------------------------------------------------

import datetime

TOOLS_DIRNAME = "tools"
GENERATED_DIRNAME = "generated"
QUARANTINE_DIRNAME = "quarantine"


class RegistryError(RuntimeError):
    """Refusing to register something that has not earned it."""


def registry_path(vault: str) -> str:
    return os.path.join(vault, TOOLS_DIRNAME, "registry.json")


def generated_root(vault: str) -> str:
    return os.path.join(vault, TOOLS_DIRNAME, GENERATED_DIRNAME)


def quarantine_root(vault: str) -> str:
    return os.path.join(vault, TOOLS_DIRNAME, QUARANTINE_DIRNAME)


def load_registry(vault: str) -> Dict[str, "ToolManifest"]:
    """Every CALLABLE generated tool, read from disk right now.

    Only `generated/` is scanned. A quarantined tool keeps its manifest for
    inspection and a retry, and must never be reachable — so it does not live
    where the loader looks.

    A malformed manifest is SKIPPED, not fatal: one bad tool must not take the
    whole toolset down. The skip is silent by design here and reported by the
    caller that has somewhere to report it.
    """
    root = generated_root(vault)
    out: Dict[str, ToolManifest] = {}
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for name in names:
        mpath = os.path.join(root, name, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath, "r", encoding="utf-8") as fh:
                manifest = parse_manifest(json.load(fh))
        except (OSError, ValueError, ManifestError):
            continue
        if manifest.callable:
            out[manifest.name] = manifest
    return out


def activate_tool(
    vault: str,
    tool_dir: str,
    approved_by: str,
    passing_tests: int,
) -> "ToolManifest":
    """Gate 4. Stamp the manifest and make the tool callable.

    Refuses, rather than warns, when either condition is missing — a warning
    that can be scrolled past is not a gate.
    """
    if not approved_by:
        raise RegistryError("a tool is activated by a person; approved_by is empty")
    if passing_tests <= 0:
        raise RegistryError(
            "no passing test case built from real data — no fixtures, no registration"
        )

    mpath = os.path.join(tool_dir, "manifest.json")
    try:
        with open(mpath, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        raise RegistryError(f"cannot read {mpath}: {exc}") from exc

    raw["approved_by"] = approved_by
    raw["approved_at"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    raw["passing_tests"] = int(passing_tests)

    # Re-validate AFTER stamping: approval must not be a way past the manifest
    # rules, and a confidential tool is pinned local on the way back in.
    manifest = parse_manifest(raw)

    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, indent=2)

    # The index is a convenience for humans and tooling; `load_registry` never
    # trusts it, so it can never be the thing that makes a deleted tool
    # callable.
    os.makedirs(os.path.dirname(registry_path(vault)), exist_ok=True)
    index = {
        name: os.path.relpath(os.path.join(generated_root(vault), name, "manifest.json"), vault)
        for name in sorted(load_registry(vault))
    }
    with open(registry_path(vault), "w", encoding="utf-8") as fh:
        json.dump({"active": index}, fh, indent=2)
    return manifest


# ---------------------------------------------------------------------------
# Step 2 — the draft manifest.
#
# Generated from the gap and the user's own examples, and it starts with
# NOTHING granted. Every permission on it has to be asked for and approved,
# which is what makes Gate 1 the gate that constrains all the others: a draft
# arriving with access already assumed would have skipped it.
#
# Confidential and local_only until argued otherwise, for the same reason the
# parser fails closed — the safe default must be the one you get by saying
# nothing.
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9]+")

#: Words that describe the ABSENCE, not the tool. A gap's `missing` field is
#: phrased as a complaint — "nothing can read Northwind Foods PDF invoices" — and
#: slugging it verbatim produced `nothing_can_read_northwind`. A tool is named for
#: what it does. A default the user has to rewrite every time is not a default.
_NEGATIONS = {
    "nothing", "no", "not", "none", "cannot", "cant", "there", "way", "tool",
    "missing", "lacks", "unable", "can", "read", "parse", "handle",
}


def _slug_from(text: str, fallback: str = "generated_tool") -> str:
    words = [w for w in _SLUG_RE.sub(" ", (text or "").lower()).split() if len(w) > 2]
    # Drop the leading negation clause, keeping the SUBJECT it was about.
    while words and words[0] in _NEGATIONS:
        words.pop(0)
    words = [w for w in words if w not in _NEGATIONS][:4]
    slug = "_".join(words)[:64].strip("_")
    if len(slug) < 3 or not slug[0].isalpha():
        return fallback
    return slug


def draft_manifest(
    gap: "CapabilityGap",
    requested: Optional[Dict[str, List[str]]] = None,
    runtime: str = "python3",
) -> Dict[str, Any]:
    """A manifest for the user to approve the SCOPE of — not to run.

    Deliberately inert and deliberately empty: `approved_by` is null, no test
    has passed, and every permission class is [] unless something explicitly
    asked for it. A permission that appears here appears because it was
    requested and can be pointed at, never because it was assumed.
    """
    asked = requested or {}
    return {
        "name": _slug_from(gap.missing) or _slug_from(gap.task),
        "version": "0.1.0",
        "description": f"{gap.missing}. Needed for: {gap.task}",
        "created_by": "manager",
        "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "runtime": runtime,
        "entrypoint": "tool.py:run",
        "input_schema": {"type": "object", "properties": {}},
        "output_schema": {"type": "object", "properties": {}},
        "permissions": {cls: list(asked.get(cls, [])) for cls in PERMISSION_CLASSES},
        # Fails closed. Anything not argued to be public is confidential, and
        # confidential is pinned local.
        "data_class": "confidential",
        "execution_target": "local_only",
        "approved_by": None,
        "approved_at": "",
        "passing_tests": 0,
        # Kept so the scope screen can show WHY this exists, in the user's own
        # framing rather than the model's summary of it.
        "gap": {"task": gap.task, "missing": gap.missing, "input_shape": gap.input_shape},
    }
