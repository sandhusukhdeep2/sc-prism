"""The destructive-command denylist, wired into the LIVE tool path.

`hooks.py` has been complete and well tested since it was written, and
reachable only through `loop.py`'s ``tool_requests`` parameter — which nothing
outside ``engine/tests/`` has ever populated. The path a real run takes
(terminal, computer, MCP, via ``toolloop``) therefore had no ``rm -rf``
denylist at all, while a green suite made it look as though it did.

This module is the missing wire. It is a tool-source wrapper shaped exactly
like ``approval.ApprovalGate``: ``list_tools`` and every unknown attribute pass
through, and ``call_tool`` runs the scan before delegating.

THREE DELIBERATE DESIGN CHOICES, each from attacking the first draft:

1.  It calls ``PreToolUseHook.check`` DIRECTLY, not ``HookEngine.pre_tool_use``.
    The engine also runs a ``ConfirmationGate`` that holds any tool whose name
    looks irreversible; with no approvals broker wired, a tool named ``delete``
    would be permanently unsatisfiable rather than merely gated.

2.  It runs a PURPOSE-BUILT pattern table, not ``hooks.DESTRUCTIVE_PATTERNS``.
    The default table is written for a planner reviewing a PROPOSED command and
    is far too broad for live execution — it refuses ``rm -f notes.txt``,
    ``git push --force-with-lease`` and ``grep -r reboot .``. A denylist that
    blocks ``npm test`` teaches the user to switch it off, which is strictly
    worse than not shipping one. ``hooks.py`` itself is untouched: its own
    docstring says patterns are data, and ``HookConfig`` exists for exactly
    this.

3.  The refusal handed to the MODEL is a category, never the matched pattern.
    A leaked regex is a bypass recipe. The pattern still reaches the SPAN,
    where a human can read it.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .hooks import BLOCK, HookConfig, PreToolUseHook, ToolRequest
from .mcp import MCPBlockedError

# Argument names whose VALUE is a command to be executed. Scanning every string
# argument of every tool would refuse a Slack message containing the word
# "reboot"; scanning none would miss the thing we exist to catch.
_COMMAND_KEYS = ("command", "cmd", "script")

# `text` is free prose for most providers and a keystroke stream for the
# computer provider — only the latter is scanned.
_TYPED_TEXT_PROVIDERS = ("computer",)

# The live table. Narrower and more anchored than hooks.DESTRUCTIVE_PATTERNS:
# every entry here is something with no legitimate use inside a coding task.
LIVE_COMMAND_PATTERNS: List[str] = [
    # Recursive rm, but only against an absolute path, ~ or $HOME. This is the
    # single most important narrowing: `rm -rf node_modules/.cache` is ordinary
    # work, `rm -rf /` and `rm -rf ~/Documents` are not.
    r"\brm\s+(?:-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*['\"]?(?:/|~|\$HOME)",
    r"\brm\b[^\n]*\s/\s*$",
    r"--no-preserve-root",
    r":\s*\(\s*\)\s*\{.*\}\s*;\s*:",
    r"\bmkfs(\.\w+)?\b",
    r"\bdd\b[^\n]*\bof=/dev/",
    r">\s*/dev/(sd|nvme|disk)",
    r"\bchmod\s+-R\s+0?777\b",
    # Anchored to command position, so `grep -r reboot .` is untouched.
    r"(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt)\b",
    r"\bgit\s+reset\s+--hard\b",
    # --force is destructive; --force-with-lease is the safe form and is the
    # one a careful engineer actually uses.
    r"\bgit\s+push\b(?![^\n]*--force-with-lease)[^\n]*--force",
    r"\bdrop\s+(table|database)\b",
    r"\btruncate\s+table\b",
]

LIVE_RESTRICTED_APIS: List[str] = [
    r"\bcurl\b[^\n]*\|\s*(?:ba)?sh\b",
    r"\bwget\b[^\n]*\|\s*(?:ba)?sh\b",
]

# Secret scanning is OFF on this path on purpose. PreToolUseHook's secret
# patterns are meant for CONTENT being written; applied to a command line they
# would refuse `export AWS_SECRET_ACCESS_KEY=...`, which is a legitimate thing
# to do in a shell. Outbound secret containment is the egress floor's job.
LIVE_HOOK_CONFIG = HookConfig(
    version="live-1",
    destructive_patterns=LIVE_COMMAND_PATTERNS,
    restricted_apis=LIVE_RESTRICTED_APIS,
    secret_patterns=[],
)

# What the MODEL is told. Deliberately free of the pattern that matched.
REFUSAL_TEXT = "destructive command blocked pre-exec"


def scanned_text(provider: str, arguments: Dict[str, Any]) -> str:
    """The part of a call worth scanning — command-shaped arguments only.

    Returns '' when a call carries nothing executable, which is the common case
    and costs one dict lookup.
    """
    parts: List[str] = []
    for key in _COMMAND_KEYS:
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value)
    if (provider or "").lower() in _TYPED_TEXT_PROVIDERS:
        typed = arguments.get("text")
        if isinstance(typed, str) and typed.strip():
            parts.append(typed)
    return "\n".join(parts)


class PreToolUseGate:
    """A tool source that REFUSES destructive commands before they execute.

    Wraps another duck-typed source. ``list_tools`` and every attribute this
    class does not define pass through, so the loop's span attribution keeps
    working through the wrapper.

    Raises ``MCPBlockedError`` on a refusal — the tool loop already audits that
    exception as ``blocked=True`` and a plain ``MCPError`` as an infra fault, so
    a governance refusal is distinguishable from a broken pipe in the trace
    without any change to the loop.
    """

    def __init__(
        self,
        source: Any,
        config: Optional[HookConfig] = None,
        telemetry: Any = None,
        on_block: Any = None,
    ) -> None:
        self.source = source
        self._config = config or LIVE_HOOK_CONFIG
        self._hook = PreToolUseHook(self._config)
        self._telemetry = telemetry
        self._on_block = on_block

    def __getattr__(self, name: str) -> Any:
        try:
            source = self.__dict__["source"]
        except KeyError:  # during __init__, before source is bound
            raise AttributeError(name)
        return getattr(source, name)

    @property
    def parent_span_id(self) -> Optional[str]:
        return getattr(self.source, "parent_span_id", None)

    @parent_span_id.setter
    def parent_span_id(self, value: Optional[str]) -> None:
        try:
            self.source.parent_span_id = value
        except AttributeError:
            pass

    def list_tools(self) -> Any:
        return self.source.list_tools()

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        provider = str(getattr(self.source, "provider", "") or "")
        text = scanned_text(provider, arguments or {})
        if text:
            decision = self._hook.check(
                ToolRequest(tool=name, action="execute", command=text)
            )
            # `action` is HookDecision's real field (hooks.py: ALLOW | BLOCK).
            # Compared against the constant, not a string literal, so a rename
            # breaks the build instead of silently allowing everything.
            if decision.action == BLOCK:
                # The human-facing record keeps the matched pattern; the model
                # is told only the category.
                if self._on_block is not None:
                    try:
                        self._on_block(decision)
                    except Exception:
                        pass
                raise MCPBlockedError(REFUSAL_TEXT)
        return self.source.call_tool(name, arguments)
