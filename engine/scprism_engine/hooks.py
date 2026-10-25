"""Hooks — the enforcement layer (Layer 4, ADR-010).

Hooks are *deterministic code* that fires at fixed lifecycle points and
physically intercepts a tool call BEFORE it runs. The model does not get to
override a hook — a rule in prose is followed "most of the time"; a hook is
followed every time (that is the whole point of ADR-010). Config is data
(``HookConfig``) so it is versionable and reviewable like code.

Lifecycle points implemented here:

  * **PreToolUse** — blocks destructive command patterns (``rm -rf`` …),
    secret leaks (key/token regex), and restricted APIs BEFORE execution.
    Operates on the concrete tool command/payload, so no prompt *phrasing* can
    talk its way past it. Sub-millisecond (compiled regex over a string).
    Block == exit code 2, in Claude-Code hook terms.
  * **ConfirmationGate** — an irreversible action (write a governance rule,
    delete audit history, change permissions) is blocked unless a matching
    RECORDED ``Approval`` object is supplied. No approval → blocked.
  * **PostToolUse** — a read-only check *after* a write: did the write land on
    an in-intent target, and did the tool output leak a secret?
  * **Stop** — the ratchet. Runs the Tier-1/compliance check at the "done"
    moment, exactly once, guarded against the infinite continue loop.

``HTTPHook`` and ``PromptHook`` are stubbed interfaces (extension points) so
the remaining two of the spec's five hook types have a place to land without
network or model dependencies in this tranche.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------------------
# Hook decision vocabulary.
# ---------------------------------------------------------------------------
ALLOW = "allow"
BLOCK = "block"

# ---------------------------------------------------------------------------
# Deterministic pattern tables (config-driven, versionable — see HookConfig).
# ---------------------------------------------------------------------------
# Destructive shell patterns. Matched case-insensitively against the concrete
# command string, so surrounding prose / phrasing cannot bypass them.
DESTRUCTIVE_PATTERNS: List[str] = [
    r"\brm\s+(?:-[a-z]*\s+)*-?[rf]{1,2}\b",   # rm -rf / rm -fr / rm -r -f
    r"\brm\s+-[a-z]*r[a-z]*f",                 # rm -Rf etc.
    r":\s*\(\s*\)\s*\{.*\}\s*;\s*:",           # fork bomb :(){ :|:& };:
    r"\bmkfs(\.\w+)?\b",                        # format a filesystem
    r"\bdd\b[^\n]*\bof=/dev/",                  # dd of=/dev/sdX
    r">\s*/dev/(sd|nvme|disk)",                 # clobber a raw device
    r"\bgit\s+push\b[^\n]*--force",             # force push
    r"\bgit\s+reset\s+--hard\b",                # discard tree
    r"\bchmod\s+-R\s+0?777\b",                  # world-writable recursive
    r"\bshutdown\b|\breboot\b|\bhalt\b",        # take the host down
    r"\bdrop\s+(table|database)\b",             # destructive SQL
    r"\btruncate\s+table\b",
    r"\brm\b[^\n]*\s/\s*$",                      # rm ... /
]

# Secret-detection regex (sub-ms PreToolUse per specs/05 §4). Deny-list style.
SECRET_PATTERNS: List[str] = [
    r"AKIA[0-9A-Z]{16}",                                # AWS access key id
    r"ASIA[0-9A-Z]{16}",                               # AWS temp key id
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",  # private key block
    r"\bsk-[A-Za-z0-9]{20,}\b",                          # OpenAI-style secret
    r"\bghp_[A-Za-z0-9]{20,}\b",                         # GitHub PAT
    r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b",                # Slack token
    r"(?i)\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['\"][^'\"]{8,}['\"]",
    r"(?i)\baws_secret_access_key\b\s*[:=]\s*\S{16,}",
]

# Restricted APIs / commands blocked outright regardless of arguments.
RESTRICTED_APIS: List[str] = [
    r"\bcurl\b[^\n]*\|\s*(?:ba)?sh\b",   # curl ... | sh (remote code exec)
    r"\bwget\b[^\n]*\|\s*(?:ba)?sh\b",
    r"\beval\s*\(",                       # dynamic eval of untrusted input
    r"\bos\.system\s*\(",
]

# Tools whose effect is irreversible / high-stakes -> ConfirmationGate applies.
IRREVERSIBLE_TOOLS = frozenset(
    {"write_rule", "delete_audit", "change_permissions", "delete"}
)


@dataclass
class HookConfig:
    """Versionable hook configuration (reviewed like code, ADR-010).

    Patterns are data, not code paths, so a change is a diffable config change.
    ``version`` lets the Verdict record which policy generation fired.
    """

    version: str = "1"
    destructive_patterns: List[str] = field(
        default_factory=lambda: list(DESTRUCTIVE_PATTERNS)
    )
    secret_patterns: List[str] = field(
        default_factory=lambda: list(SECRET_PATTERNS)
    )
    restricted_apis: List[str] = field(
        default_factory=lambda: list(RESTRICTED_APIS)
    )
    irreversible_tools: frozenset = IRREVERSIBLE_TOOLS


@dataclass
class ToolRequest:
    """One concrete tool operation the loop is about to perform.

    Hooks and permissions reason about *this*, not the natural-language prompt —
    that is what makes enforcement phrasing-proof.
    """

    tool: str                    # 'bash' | 'write_file' | 'write_rule' | ...
    action: str = "execute"      # maps to a permissions op: read/write/execute/delete/...
    path: str = ""               # target path (for scope checks)
    command: str = ""            # concrete command line (for destructive/API scan)
    content: str = ""            # payload being written (for secret scan)
    output: str = ""             # tool output, if already produced (PostToolUse)
    agent_id: str = "orchestrator"
    purpose: str = ""

    def scan_text(self) -> str:
        """The text PreToolUse scans: the command plus any inline payload."""
        return "\n".join(x for x in (self.command, self.content) if x)


@dataclass
class Approval:
    """A recorded human sign-off for an irreversible action.

    Immutable evidence: who approved what, when, and why. The ConfirmationGate
    only lets an irreversible action through when a matching Approval exists.
    """

    action: str                  # e.g. 'write_rule'
    target: str = ""             # path/resource the approval covers ("" = any)
    approver: str = ""           # human identity that signed off
    reason: str = ""
    granted_at: str = ""
    approval_id: str = ""

    def matches(self, req: "ToolRequest") -> bool:
        if self.action != req.tool and self.action != req.action:
            return False
        if not self.target:
            return True  # blanket approval for this action
        return self.target == req.path or self.target == "*"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "target": self.target,
            "approver": self.approver,
            "reason": self.reason,
            "granted_at": self.granted_at,
            "approval_id": self.approval_id,
        }


@dataclass
class HookDecision:
    """Outcome of one hook firing — recorded for the audit spine."""

    hook: str                    # 'PreToolUse' | 'ConfirmationGate' | ...
    action: str                  # ALLOW | BLOCK
    reason: str
    exit_code: int = 0           # 0 = allow, 2 = block (Claude-Code convention)
    tool: str = ""
    target: str = ""
    matched: str = ""            # the pattern/rule that fired, if any

    @property
    def blocked(self) -> bool:
        return self.action == BLOCK

    def to_dict(self) -> Dict[str, Any]:
        return {
            "hook": self.hook,
            "action": self.action,
            "reason": self.reason,
            "exit_code": self.exit_code,
            "tool": self.tool,
            "target": self.target,
            "matched": self.matched,
        }


def _first_match(text: str, patterns: List[str]) -> Optional[str]:
    for pat in patterns:
        if re.search(pat, text, re.IGNORECASE):
            return pat
    return None


def scan_secrets(text: str, patterns: Optional[List[str]] = None) -> Optional[str]:
    """Return the first secret pattern found in ``text``, else None."""
    return _first_match(text or "", patterns or SECRET_PATTERNS)


# ---------------------------------------------------------------------------
# The five hook types.
# ---------------------------------------------------------------------------
class PreToolUseHook:
    """Blocks destructive patterns, secrets, and restricted APIs pre-exec."""

    hook_name = "PreToolUse"

    def __init__(self, config: Optional[HookConfig] = None) -> None:
        self.config = config or HookConfig()

    def check(self, req: ToolRequest) -> HookDecision:
        text = req.scan_text()

        pat = _first_match(text, self.config.destructive_patterns)
        if pat:
            return HookDecision(
                self.hook_name, BLOCK,
                f"destructive command blocked pre-exec (matched /{pat}/)",
                exit_code=2, tool=req.tool, target=req.path, matched=pat,
            )

        pat = _first_match(text, self.config.restricted_apis)
        if pat:
            return HookDecision(
                self.hook_name, BLOCK,
                f"restricted API blocked pre-exec (matched /{pat}/)",
                exit_code=2, tool=req.tool, target=req.path, matched=pat,
            )

        pat = scan_secrets(text, self.config.secret_patterns)
        if pat:
            return HookDecision(
                self.hook_name, BLOCK,
                f"secret detected in tool input — blocked (matched /{pat}/)",
                exit_code=2, tool=req.tool, target=req.path, matched=pat,
            )

        return HookDecision(
            self.hook_name, ALLOW, "no destructive/secret/restricted match",
            tool=req.tool, target=req.path,
        )


class ConfirmationGate:
    """Irreversible actions require a RECORDED approval; absent -> blocked."""

    hook_name = "ConfirmationGate"

    def __init__(self, config: Optional[HookConfig] = None) -> None:
        self.config = config or HookConfig()

    def is_irreversible(self, req: ToolRequest) -> bool:
        return (
            req.tool in self.config.irreversible_tools
            or req.action in self.config.irreversible_tools
        )

    def check(
        self, req: ToolRequest, approvals: Optional[List[Approval]] = None
    ) -> HookDecision:
        if not self.is_irreversible(req):
            return HookDecision(
                self.hook_name, ALLOW, "reversible action — no approval required",
                tool=req.tool, target=req.path,
            )

        match = None
        for appr in approvals or []:
            if appr.matches(req):
                match = appr
                break

        if match is None:
            return HookDecision(
                self.hook_name, BLOCK,
                f"irreversible action '{req.tool}' on '{req.path}' requires a "
                f"recorded human approval — none supplied",
                exit_code=2, tool=req.tool, target=req.path,
            )

        return HookDecision(
            self.hook_name, ALLOW,
            f"irreversible action approved by '{match.approver}' "
            f"(approval_id={match.approval_id or 'n/a'})",
            tool=req.tool, target=req.path, matched=match.approval_id,
        )


class PostToolUseHook:
    """Read-only after-the-fact check: intent match + secret-in-output scan."""

    hook_name = "PostToolUse"

    def __init__(self, config: Optional[HookConfig] = None) -> None:
        self.config = config or HookConfig()

    def check(
        self,
        req: ToolRequest,
        output: str = "",
        allowed_scope: Optional[List[str]] = None,
    ) -> HookDecision:
        text = output or req.output or ""

        # A secret must never appear in tool output / spans (specs/05 §4, §7).
        pat = scan_secrets(text, self.config.secret_patterns)
        if pat:
            return HookDecision(
                self.hook_name, BLOCK,
                f"secret detected in tool output — flagged (matched /{pat}/)",
                exit_code=2, tool=req.tool, target=req.path, matched=pat,
            )

        # Intent match: a write must land on a path inside the declared scope.
        if allowed_scope is not None and req.path:
            from .permissions import _in_scope
            if not _in_scope(req.path, allowed_scope):
                return HookDecision(
                    self.hook_name, BLOCK,
                    f"write landed on '{req.path}' outside declared intent "
                    f"scope {allowed_scope}",
                    exit_code=2, tool=req.tool, target=req.path,
                )

        return HookDecision(
            self.hook_name, ALLOW, "write matched intent; no secret in output",
            tool=req.tool, target=req.path,
        )


class StopHook:
    """The ratchet — runs the compliance check once at the 'done' moment.

    Guarded against the infinite "fix -> stop -> blocked -> fix" loop: the
    ratchet fires exactly once per instance; a second call is a no-op that
    reports the guard tripped.
    """

    hook_name = "Stop"

    def __init__(self, ratchet: Optional[Callable[[Dict[str, Any]], bool]] = None) -> None:
        # Default ratchet: compliant iff Tier-1 passed and nothing was blocked.
        self._ratchet = ratchet or self._default_ratchet
        self._fired = False
        self.runs = 0

    @staticmethod
    def _default_ratchet(ctx: Dict[str, Any]) -> bool:
        return bool(ctx.get("tier1_passed", False)) and not ctx.get("blocks")

    def run(self, ctx: Optional[Dict[str, Any]] = None) -> HookDecision:
        if self._fired:
            # Guard: never re-run the ratchet — prevents the continue loop.
            return HookDecision(
                self.hook_name, ALLOW,
                "ratchet already ran — continuation guard tripped (no re-run)",
            )
        self._fired = True
        self.runs += 1
        compliant = bool(self._ratchet(ctx or {}))
        return HookDecision(
            self.hook_name,
            ALLOW if compliant else BLOCK,
            "compliance ratchet: PASS" if compliant
            else "compliance ratchet: FAIL — task not done",
            exit_code=0 if compliant else 2,
        )


class HTTPHook:
    """Extension point (spec's 5th type): a remote server enforcing team-wide
    policy across every agent. Stubbed — no network in this tranche."""

    hook_name = "HTTP"

    def __init__(self, endpoint: str = "") -> None:
        self.endpoint = endpoint

    def check(self, req: ToolRequest) -> HookDecision:  # pragma: no cover
        raise NotImplementedError(
            "HTTP hook is an extension point (tranche E-Bifrost / team policy)."
        )


class PromptHook:
    """Extension point (spec's 5th type): a fast yes/no LLM 'does this look
    destructive?' check. Stubbed — routes through the gateway when built."""

    hook_name = "prompt"

    def check(self, req: ToolRequest) -> HookDecision:  # pragma: no cover
        raise NotImplementedError(
            "prompt hook is an extension point (fuzzy check via the gateway)."
        )


# ---------------------------------------------------------------------------
# The hook engine — orchestrates the deterministic gate at each lifecycle point.
# ---------------------------------------------------------------------------
@dataclass
class GateOutcome:
    """Result of the pre-execution gate for one ToolRequest."""

    allowed: bool
    decisions: List[HookDecision] = field(default_factory=list)

    @property
    def block(self) -> Optional[HookDecision]:
        for d in self.decisions:
            if d.blocked:
                return d
        return None


class HookEngine:
    """Wires the hooks together; the loop calls this at each lifecycle point."""

    def __init__(self, config: Optional[HookConfig] = None) -> None:
        self.config = config or HookConfig()
        self.pre = PreToolUseHook(self.config)
        self.confirm = ConfirmationGate(self.config)
        self.post = PostToolUseHook(self.config)

    def pre_tool_use(
        self, req: ToolRequest, approvals: Optional[List[Approval]] = None
    ) -> GateOutcome:
        """PreToolUse then ConfirmationGate. First BLOCK stops the gate."""
        decisions: List[HookDecision] = []

        pre = self.pre.check(req)
        decisions.append(pre)
        if pre.blocked:
            return GateOutcome(allowed=False, decisions=decisions)

        conf = self.confirm.check(req, approvals)
        decisions.append(conf)
        if conf.blocked:
            return GateOutcome(allowed=False, decisions=decisions)

        return GateOutcome(allowed=True, decisions=decisions)

    def post_tool_use(
        self,
        req: ToolRequest,
        output: str = "",
        allowed_scope: Optional[List[str]] = None,
    ) -> HookDecision:
        return self.post.check(req, output=output, allowed_scope=allowed_scope)

    def new_stop_hook(
        self, ratchet: Optional[Callable[[Dict[str, Any]], bool]] = None
    ) -> StopHook:
        """A fresh Stop hook per run so its once-only guard is per-task."""
        return StopHook(ratchet)


def now_iso() -> str:
    """UTC timestamp helper for building Approval records."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
