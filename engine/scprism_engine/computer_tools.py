"""Computer control as a governed tool source (2026-08-29).

The owner's ask, verbatim intent: "give our agent capability to control the
PC… use application screenshots as Claude coworker is doing… manager is the
one who is choosing who got how many powers." The shape is the house shape:
an MCPClient-SHAPED provider (``list_tools`` + ``call_tool`` + ``telemetry``
+ ``parent_span_id``), tagged ``provider="computer"`` so the per-agent
capability gate requires the ``computer`` grant — a seat holds it only when
its OWN definition file declares ``tools: [computer]`` AND the user's ceiling
includes it (``--computer``). Side effects ride the approval gate like every
other tool.

HONESTY RULES SPECIFIC TO THIS SOURCE
- macOS gates the real power (TCC): screenshots need Screen Recording,
  synthetic input needs Accessibility/Automation. A denial comes back as a
  PLAIN error naming the permission and where to grant it — never a mystery.
- The screenshot result is a PATH (size-stamped), never image bytes into the
  transcript: a vision route can read the file; a text model is told what it
  got. Nothing egresses by itself — the vault floor and result guard apply to
  these observations exactly as to any tool result.
- Every action is one ``tool_exec`` span. What ran is what is recorded.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from typing import Any, Dict, List, Optional, Sequence

from .mcp import MCPBlockedError, MCPTool

# One bounded shell call per action; nothing long-running, nothing detached.
_TIMEOUT_S = 15

_SCREEN_HINT = (
    "Screen Recording permission is not granted for SC Prism. "
    "Grant it in System Settings → Privacy & Security → Screen Recording, "
    "then run again."
)
_INPUT_HINT = (
    "Accessibility / Automation permission is not granted for SC Prism. "
    "Grant it in System Settings → Privacy & Security → Accessibility "
    "(and Automation → System Events), then run again."
)


def _text_result(text: str, is_error: bool = False, **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": is_error}
    out.update(extra)
    return out


class ComputerToolProvider:
    """Governed computer control: screenshot, open app, click, type, key."""

    def __init__(
        self,
        *,
        telemetry: Optional[Any] = None,
        server_name: str = "computer",
        allowed_tools: Optional[Sequence[str]] = None,
        shot_dir: Optional[str] = None,
    ) -> None:
        self.telemetry = telemetry
        self.parent_span_id: Optional[str] = None
        self.provider = "computer"
        self.server_name = server_name
        self.allowed_tools: Optional[set] = (
            None if allowed_tools is None else set(allowed_tools)
        )
        self.shot_dir = shot_dir or tempfile.gettempdir()

    # -- manifest ----------------------------------------------------------

    def list_tools(self) -> List[MCPTool]:
        return [
            MCPTool(
                name="computer_screenshot",
                description=(
                    "Capture the whole screen to a PNG file on this machine. "
                    "Returns the file path and byte size — the image itself "
                    "stays local unless a later step explicitly reads it."
                ),
                input_schema={"type": "object", "properties": {}},
            ),
            MCPTool(
                name="computer_open_app",
                description="Open (or foreground) a named macOS application.",
                input_schema={
                    "type": "object",
                    "properties": {"app": {"type": "string"}},
                    "required": ["app"],
                },
            ),
            MCPTool(
                name="computer_click",
                description="Click at screen coordinates (points, origin top-left).",
                input_schema={
                    "type": "object",
                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                    "required": ["x", "y"],
                },
            ),
            MCPTool(
                name="computer_type",
                description="Type a string into the frontmost application.",
                input_schema={
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            ),
            MCPTool(
                name="computer_key",
                description="Press one named key (e.g. return, tab, escape).",
                input_schema={
                    "type": "object",
                    "properties": {"key": {"type": "string"}},
                    "required": ["key"],
                },
            ),
        ]

    # -- dispatch ----------------------------------------------------------

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        arguments = arguments or {}
        if self.allowed_tools is not None and name not in self.allowed_tools:
            reason = f"'{name}' is not in this run's allowed computer tools"
            self._span(name, blocked=True, reason=reason)
            raise MCPBlockedError(reason)
        if self.telemetry is not None:
            with self.telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=self.parent_span_id,
                provider="computer",
                server=self.server_name,
                tool=name,
            ) as sp:
                result = self._dispatch(name, arguments)
                sp.set(is_error=bool(result.get("isError")))
                return result
        return self._dispatch(name, arguments)

    def _span(self, tool: str, blocked: bool, reason: str) -> None:
        if self.telemetry is None:
            return
        with self.telemetry.span(
            "tool_exec",
            span_type="tool_exec",
            parent=self.parent_span_id,
            provider="computer",
            server=self.server_name,
            tool=tool,
            blocked=blocked,
        ) as sp:
            sp.set(reason=reason)
            sp.set_status("error")

    def _dispatch(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if name == "computer_screenshot":
            return self._screenshot()
        if name == "computer_open_app":
            return self._open_app(str(args.get("app", "")).strip())
        if name == "computer_click":
            return self._click(args.get("x"), args.get("y"))
        if name == "computer_type":
            return self._type(args.get("text"))
        if name == "computer_key":
            return self._key(str(args.get("key", "")).strip())
        return _text_result(f"unknown computer tool '{name}'", is_error=True)

    # -- the five actions --------------------------------------------------

    def _run(self, argv: List[str]) -> subprocess.CompletedProcess:
        return subprocess.run(argv, capture_output=True, timeout=_TIMEOUT_S)

    def _screenshot(self) -> Dict[str, Any]:
        path = os.path.join(self.shot_dir, f"scprism-shot-{int(time.time() * 1000)}.png")
        proc = self._run(["screencapture", "-x", path])
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf-8", "replace")
            hint = _SCREEN_HINT if "image" in err or "display" in err else err or "screencapture failed"
            return _text_result(hint, is_error=True)
        try:
            size = os.path.getsize(path)
        except OSError:
            return _text_result(_SCREEN_HINT, is_error=True)
        return _text_result(
            f"screenshot saved: {path} ({size} bytes)", path=path, bytes=size
        )

    def _open_app(self, app: str) -> Dict[str, Any]:
        if not app:
            return _text_result("computer_open_app needs an 'app' name", is_error=True)
        proc = self._run(["open", "-a", app])
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf-8", "replace").strip()
            return _text_result(err or f"could not open '{app}'", is_error=True)
        return _text_result(f"opened {app}")

    def _osascript(self, script: str) -> Optional[str]:
        """Run one osascript; None on success, else the honest error text."""
        proc = self._run(["osascript", "-e", script])
        if proc.returncode == 0:
            return None
        err = (proc.stderr or b"").decode("utf-8", "replace")
        if "-1743" in err or "Not authorised" in err or "not authorized" in err:
            return _INPUT_HINT
        return err.strip() or "osascript failed"

    def _click(self, x: Any, y: Any) -> Dict[str, Any]:
        try:
            xi, yi = int(float(x)), int(float(y))
        except (TypeError, ValueError):
            return _text_result("computer_click needs numeric x and y", is_error=True)
        err = self._osascript(
            f'tell application "System Events" to click at {{{xi}, {yi}}}'
        )
        if err:
            return _text_result(err, is_error=True)
        return _text_result(f"clicked at ({xi}, {yi})")

    def _type(self, text: Any) -> Dict[str, Any]:
        if not isinstance(text, str) or not text:
            return _text_result("computer_type needs a non-empty 'text'", is_error=True)
        safe = text.replace("\\", "\\\\").replace('"', '\\"')
        err = self._osascript(f'tell application "System Events" to keystroke "{safe}"')
        if err:
            return _text_result(err, is_error=True)
        return _text_result(f"typed {len(text)} characters")

    _KEYS = {
        "return": 36, "enter": 36, "tab": 48, "escape": 53, "esc": 53,
        "space": 49, "delete": 51, "up": 126, "down": 125, "left": 123, "right": 124,
    }

    def _key(self, key: str) -> Dict[str, Any]:
        code = self._KEYS.get(key.lower())
        if code is None:
            return _text_result(
                f"unknown key '{key}' — one of: {', '.join(sorted(self._KEYS))}",
                is_error=True,
            )
        err = self._osascript(f'tell application "System Events" to key code {code}')
        if err:
            return _text_result(err, is_error=True)
        return _text_result(f"pressed {key}")
