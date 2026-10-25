"""Permissions — RBAC + ABAC at the Orchestrator (Layer 3, ADR-011).

Every agent has a distinct identity (separate from a human user) and acts only
under a *minimal, time-bound* grant. Access is decided by:

  * **RBAC** — the agent's ``role`` (``implementer`` / ``reviewer`` /
    ``data-reader`` / ``admin``) carries a fixed set of allowed operations.
  * **ABAC** — attributes layered on top: environment (prod vs dev), the
    declared *purpose*, and the target *scope*. This makes a grant
    context-aware instead of static.
  * **Attribute store** — a tiny JSON-serialisable map
    ``agent_id:task_type -> {ops, paths}`` that further narrows a grant to the
    exact operations/paths that task type needs (least privilege).
  * **Time-bound** — a grant carries an issue time + TTL; an expired grant is
    denied. The grant is narrowed to the moment and expires after.

``check(agent, action, path, ctx) -> Decision`` is the single enforcement
entry point. It is deterministic, stdlib-only, and returns a *reason* for every
decision so the outcome is auditable and revocable (ADR-011 acceptance). A path
outside the declared scope is denied WITH a reason.

This is enforcement, not advice: the loop calls ``check`` before a tool/write
step and refuses a denied step — the model never gets to override it.
"""

from __future__ import annotations

import fnmatch
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

# ---------------------------------------------------------------------------
# Operations (the vocabulary RBAC/ABAC reason about).
# ---------------------------------------------------------------------------
READ = "read"
WRITE = "write"
EXECUTE = "execute"
DELETE = "delete"
WRITE_RULE = "write_rule"           # author a new governance rule
DELETE_AUDIT = "delete_audit"       # remove audit history
CHANGE_PERMISSIONS = "change_permissions"

OPERATIONS = (
    READ,
    WRITE,
    EXECUTE,
    DELETE,
    WRITE_RULE,
    DELETE_AUDIT,
    CHANGE_PERMISSIONS,
)

# Irreversible / high-stakes operations. RBAC restricts these to ``admin``;
# the hooks layer additionally requires a RECORDED human approval for them
# (defense in depth — permissions.py gates *who*, hooks.py gates *approval*).
IRREVERSIBLE_OPERATIONS = frozenset(
    {WRITE_RULE, DELETE_AUDIT, CHANGE_PERMISSIONS, DELETE}
)

# Operations that act on a concrete path and therefore must fall inside scope.
PATH_OPERATIONS = frozenset({READ, WRITE, DELETE, WRITE_RULE})

# ---------------------------------------------------------------------------
# Predefined roles — RBAC. Each role carries a fixed, least-privilege set.
# ---------------------------------------------------------------------------
DEFAULT_ROLES: Dict[str, frozenset] = {
    "data-reader": frozenset({READ}),
    "reviewer": frozenset({READ, EXECUTE}),
    "implementer": frozenset({READ, WRITE, EXECUTE}),
    "admin": frozenset(
        {READ, WRITE, EXECUTE, DELETE, WRITE_RULE, DELETE_AUDIT, CHANGE_PERMISSIONS}
    ),
}

DEFAULT_GRANT_TTL_SECONDS = 3600.0  # a grant is scoped to the task's moment


@dataclass
class Decision:
    """The result of a permission check — always carries a human reason."""

    allow: bool
    reason: str
    agent: str = ""
    action: str = ""
    path: str = ""
    role: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "allow": self.allow,
            "reason": self.reason,
            "agent": self.agent,
            "action": self.action,
            "path": self.path,
            "role": self.role,
        }


@dataclass
class AccessContext:
    """ABAC attributes + the time-bound grant envelope for one request.

    Attributes:
        role: the agent's RBAC role.
        purpose: the declared task purpose the grant is bound to.
        scope: allowed path globs (least-privilege blast radius).
        env: ``dev`` or ``prod`` (prod tightens irreversible ops).
        task_type: keys the attribute store (``agent_id:task_type``).
        issued_at / ttl_seconds: the grant's validity window.
        now: evaluation time (injectable for deterministic tests).
    """

    role: str
    purpose: str = ""
    scope: List[str] = field(default_factory=list)
    env: str = "dev"
    task_type: str = ""
    issued_at: Optional[float] = None
    ttl_seconds: float = DEFAULT_GRANT_TTL_SECONDS
    now: Optional[float] = None

    def expired(self) -> bool:
        if self.issued_at is None:
            return False  # no window declared -> not time-bound
        now = self.now if self.now is not None else time.time()
        return (now - self.issued_at) > self.ttl_seconds


def _in_scope(path: str, scope: List[str]) -> bool:
    """True if ``path`` matches any scope entry (glob or directory prefix)."""
    if not scope:
        return False
    p = path.strip().lstrip("./")
    for entry in scope:
        e = (entry or "").strip().lstrip("./")
        if not e:
            continue
        if e in ("*", "**"):
            return True
        if fnmatch.fnmatch(p, e):
            return True
        # Directory-prefix match: 'engine/' or 'engine/**' covers 'engine/x.py'.
        base = e.rstrip("*").rstrip("/")
        if base and (p == base or p.startswith(base + "/")):
            return True
    return False


class PermissionEngine:
    """RBAC + ABAC decision point. Deterministic; one ``check`` per request."""

    def __init__(
        self,
        roles: Optional[Mapping[str, frozenset]] = None,
        attribute_store: Optional[Mapping[str, Mapping[str, Any]]] = None,
    ) -> None:
        # Copy so callers can't mutate our tables after construction.
        self.roles: Dict[str, frozenset] = {
            k: frozenset(v) for k, v in (roles or DEFAULT_ROLES).items()
        }
        # agent_id:task_type -> {"ops": [...], "paths": [...]}
        self.attribute_store: Dict[str, Dict[str, Any]] = {
            k: dict(v) for k, v in (attribute_store or {}).items()
        }

    # -- authoring the attribute store (audit-friendly, revocable) ---------
    def grant_attributes(
        self, agent_id: str, task_type: str, ops: List[str], paths: List[str]
    ) -> None:
        self.attribute_store[f"{agent_id}:{task_type}"] = {
            "ops": list(ops),
            "paths": list(paths),
        }

    def revoke_attributes(self, agent_id: str, task_type: str) -> None:
        self.attribute_store.pop(f"{agent_id}:{task_type}", None)

    # -- the enforcement entry point ---------------------------------------
    def check(
        self,
        agent: str,
        action: str,
        path: str,
        ctx: AccessContext,
    ) -> Decision:
        """Return an allow/deny Decision with a reason. Least privilege.

        Order: identity/role known -> grant not expired -> RBAC allows the
        action -> ABAC env constraints -> ABAC scope (out-of-scope path denied)
        -> attribute-store narrowing. First failure wins and is explained.
        """
        role = ctx.role
        base = Decision(
            allow=False, reason="", agent=agent, action=action, path=path, role=role
        )

        # 1. RBAC — the role must exist and permit the action.
        allowed_ops = self.roles.get(role)
        if allowed_ops is None:
            base.reason = f"unknown role '{role}' — no grant"
            return base

        # 2. Time-bound — an expired grant is dead.
        if ctx.expired():
            base.reason = (
                f"grant for '{agent}' expired "
                f"(ttl={ctx.ttl_seconds}s, purpose='{ctx.purpose}')"
            )
            return base

        if action not in OPERATIONS:
            base.reason = f"unknown action '{action}'"
            return base

        if action not in allowed_ops:
            base.reason = (
                f"RBAC: role '{role}' may not '{action}' "
                f"(allowed: {sorted(allowed_ops)})"
            )
            return base

        # 3. ABAC — environment. In prod, irreversible ops are admin-only even
        #    if some future role were granted them.
        if ctx.env == "prod" and action in IRREVERSIBLE_OPERATIONS and role != "admin":
            base.reason = (
                f"ABAC: '{action}' in prod requires role 'admin' "
                f"(role '{role}' denied)"
            )
            return base

        # 4. ABAC — scope. A path-bearing action must fall inside the grant's
        #    declared scope; an out-of-scope path is denied WITH a reason.
        needs_path = action in PATH_OPERATIONS or bool(path)
        if needs_path and path:
            if not ctx.scope:
                base.reason = (
                    f"ABAC: no scope declared for purpose '{ctx.purpose}' — "
                    f"path '{path}' denied (least privilege)"
                )
                return base
            if not _in_scope(path, ctx.scope):
                base.reason = (
                    f"ABAC: path '{path}' is outside declared scope "
                    f"{ctx.scope} (purpose='{ctx.purpose}')"
                )
                return base

        # 5. Attribute store — narrow further for this agent:task_type.
        key = f"{agent}:{ctx.task_type}"
        entry = self.attribute_store.get(key)
        if entry is not None:
            if action not in entry.get("ops", []):
                base.reason = (
                    f"ABAC: attribute grant '{key}' does not allow '{action}' "
                    f"(allows {entry.get('ops', [])})"
                )
                return base
            entry_paths = entry.get("paths", [])
            if path and entry_paths and not _in_scope(path, entry_paths):
                base.reason = (
                    f"ABAC: attribute grant '{key}' restricts to {entry_paths}; "
                    f"path '{path}' denied"
                )
                return base

        # Allowed.
        why = (
            f"role '{role}' permits '{action}'"
            + (f" on '{path}' within scope" if path else "")
            + (f"; attribute grant '{key}'" if entry is not None else "")
        )
        return Decision(
            allow=True, reason=why, agent=agent, action=action, path=path, role=role
        )
