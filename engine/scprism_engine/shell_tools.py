"""Terminal commands as a governed tool source (2026-08-31).

The owner's directive, verbatim intent: "this software is going to do all kinds
of jobs, whatever the user said — 3D modeling, CAD work, game development —
with the terminal or other control powers it can do the task."

The house shape (mirrors computer_tools.py): an MCPClient-SHAPED provider
tagged ``provider="shell"``, so the per-agent capability gate requires the
``terminal`` grant — a seat holds it only when its OWN definition declares
``tools: [terminal]`` AND the user's ceiling includes it. Every call is
acting-class: the approval gate HOLDS it until a human (or an explicit
--approve) says yes. One ``tool_exec`` span per execution — the command line
itself is recorded (the user granted terminal access; what ran must be
auditable), plus exit code, duration, and byte counts.

HONESTY RULES SPECIFIC TO THIS SOURCE
- Output is truncated at a stated cap and SAYS SO — never silently.
- A non-zero exit is an error result carrying the real code, never dressed up.
- A timeout kills the process group and says how long it waited.
- No environment scrubbing theatre: the command runs as the engine's user,
  which is the whole point — and the whole reason for the three gates above.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import Any, Dict, List, Optional

from .webtools import MCPTool

_DEFAULT_TIMEOUT_S = 300
_DEFAULT_OUTPUT_CAP = 20_000


class ShellToolProvider:
    """Governed terminal access: one tool, ``run_command``."""

    def __init__(
        self,
        *,
        telemetry: Optional[Any] = None,
        server_name: str = "shell",
        timeout_s: int = _DEFAULT_TIMEOUT_S,
        output_cap: int = _DEFAULT_OUTPUT_CAP,
        default_cwd: Optional[str] = None,
    ) -> None:
        self.telemetry = telemetry
        self.parent_span_id: Optional[str] = None
        self.provider = "shell"
        self.server_name = server_name
        self.timeout_s = timeout_s
        self.output_cap = output_cap
        self.default_cwd = default_cwd

    # -- manifest ----------------------------------------------------------

    def list_tools(self) -> List[MCPTool]:
        return [
            MCPTool(
                name="run_command",
                description=(
                    "Run one terminal command on this machine (zsh). Returns "
                    "stdout+stderr (truncated at a stated cap) and the exit "
                    "code. Long jobs are killed at the timeout and say so."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "cwd": {
                            "type": "string",
                            "description": "Working directory (absolute).",
                        },
                    },
                    "required": ["command"],
                },
            )
        ]

    # -- execution ---------------------------------------------------------

    def call_tool(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if name != "run_command":
            return _err(f"unknown tool: {name}", exit_code=None)
        command = str(args.get("command") or "").strip()
        if not command:
            return _err("empty command", exit_code=None)
        cwd = str(args.get("cwd") or self.default_cwd or "") or None
        if cwd and not os.path.isdir(cwd):
            return _err(f"cwd is not a directory: {cwd}", exit_code=None)

        started = time.time()
        try:
            proc = subprocess.Popen(
                ["/bin/zsh", "-c", command],
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # so a timeout can kill the whole group
            )
            try:
                out_b, _ = proc.communicate(timeout=self.timeout_s)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                proc.wait()
                return _err(
                    f"timed out after {self.timeout_s}s — process group killed",
                    exit_code=None,
                )
        except OSError as e:
            return _err(f"could not start: {e}", exit_code=None)

        raw = (out_b or b"").decode("utf-8", "replace")
        text = raw
        if len(text) > self.output_cap:
            text = (
                text[: self.output_cap]
                + f"\n… truncated at {self.output_cap} of {len(raw)} chars"
            )
        code = proc.returncode
        result: Dict[str, Any] = {
            "content": [{"type": "text", "text": text if text else "(no output)"}],
            "isError": code != 0,
            "exit_code": code,
            "duration_ms": round((time.time() - started) * 1000, 1),
            "bytes": len(raw),
        }
        return result


def _err(msg: str, exit_code: Optional[int]) -> Dict[str, Any]:
    return {
        "content": [{"type": "text", "text": msg}],
        "isError": True,
        "exit_code": exit_code,
    }
