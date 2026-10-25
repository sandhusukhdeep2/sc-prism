"""Terminal access as a governed tool source (2026-08-31).

The owner's ask, verbatim intent: "this software is going to do all kinds of
jobs, whatever the user says — 3D modeling, CAD work, game development — with
the terminal it can do the task." The shape is the house shape: an
MCPClient-SHAPED provider (``list_tools`` + ``call_tool`` + ``telemetry`` +
``parent_span_id``), tagged ``provider="terminal"`` so the per-agent
capability gate requires the ``terminal`` grant — a seat holds it only when
its OWN definition declares ``tools: [terminal]`` AND the user's ceiling
includes it. ``terminal_run`` is not in toolrisk's read-only allowlist, so it
classifies ACTING and every command rides the approval gate: nothing runs
without a human yes (or a standing auto-approval the user chose).

HONESTY RULES SPECIFIC TO THIS SOURCE
- What ran is what is recorded: the span carries the command, the cwd and the
  exit code. There is no quiet mode.
- Output is capped and SAYS SO when truncated; a nonzero exit is an error
  result with the real code, never dressed as success.
- A relative cwd is refused (mirrors reveal_path's absolute-only rule); the
  default working directory is the user's home.
- A timeout kills the process group and reports "timed out" — a hung command
  can never hang the run.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence

from . import containment
from . import proc as proc_util
from . import toolpath
from .mcp import MCPTool

_MAX_OUTPUT = 80_000  # bytes of combined output shown to the model
_DEFAULT_TIMEOUT_S = 120
_MAX_TIMEOUT_S = 600


class TerminalToolProvider:
    """Governed shell access: one tool, every execution on the record."""

    def __init__(
        self,
        *,
        telemetry: Optional[Any] = None,
        server_name: str = "terminal",
        allowed_tools: Optional[Sequence[str]] = None,
        vault: str = "",
    ) -> None:
        self.telemetry = telemetry
        # Used only to write-deny the governance surface (mcp-approvals.json).
        # A command that can rewrite that file can approve itself, permanently,
        # for every future tool.
        self.vault = vault
        self.parent_span_id: Optional[str] = None
        self.provider = "terminal"
        self.server_name = server_name
        self.allowed_tools: Optional[set] = (
            None if allowed_tools is None else set(allowed_tools)
        )

    # -- manifest ----------------------------------------------------------

    def list_tools(self) -> List[MCPTool]:
        return [
            MCPTool(
                name="terminal_run",
                description=(
                    "Run one shell command on this machine and return its "
                    "stdout/stderr and exit code. cwd must be an absolute "
                    "path (default: the user's home). Long output is "
                    "truncated and says so. Every execution is recorded."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "cwd": {"type": "string"},
                        "timeout_s": {"type": "number"},
                    },
                    "required": ["command"],
                },
            )
        ]

    # -- execution ---------------------------------------------------------

    def _err(self, text: str, exit_code: Optional[int] = None) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "content": [{"type": "text", "text": text}],
            "isError": True,
        }
        if exit_code is not None:
            out["exit_code"] = exit_code
        return out

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        result = self._call(name, arguments)
        # WHAT RAN IS WHAT IS RECORDED (no black box): one self-reported span
        # per command with the command, cwd and exit code — the command text
        # is the user-approved act itself, so recording it is the honesty,
        # not a leak (mirrors web recording its already-egressed args).
        if self.telemetry is not None:
            with self.telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=self.parent_span_id,
                provider="terminal",
                server=self.server_name,
                tool=name,
                command=str(arguments.get("command") or "")[:400],
                cwd=str(arguments.get("cwd") or ""),
                exit_code=result.get("exit_code"),
                is_error=bool(result.get("isError")),
                contained=bool(getattr(self, "_contained", False)),
            ):
                pass
        return result

    def _call(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if name != "terminal_run" or (
            self.allowed_tools is not None and name not in self.allowed_tools
        ):
            return self._err(f"unknown tool: {name}")
        command = str(arguments.get("command") or "").strip()
        if not command:
            return self._err("command is required")
        cwd = str(arguments.get("cwd") or "").strip() or os.path.expanduser("~")
        if not cwd.startswith("/"):
            return self._err("cwd must be an absolute path")
        if not os.path.isdir(cwd):
            return self._err(f"cwd is not a directory: {cwd}")
        try:
            timeout_s = float(arguments.get("timeout_s") or _DEFAULT_TIMEOUT_S)
        except (TypeError, ValueError):
            timeout_s = _DEFAULT_TIMEOUT_S
        timeout_s = max(1.0, min(timeout_s, _MAX_TIMEOUT_S))

        # `proc.run_bounded`, NOT subprocess.run(timeout=…). Python's timeout
        # handling calls Popen.kill(), which signals the direct child — the
        # shell — and leaves every grandchild it spawned running forever. This
        # module used to claim the opposite in a comment ("a killed timeout
        # takes its children"); a test that starts a real background process
        # and asks the kernel whether it survived proved otherwise.
        # run_bounded kills the whole process group, measures on the longer of
        # the monotonic and wall clocks (so a sleeping Mac cannot stretch the
        # bound), and returns whatever the command printed before it was cut
        # off — reporting a timeout with the partial work discarded is strictly
        # less useful than reporting it with the output.
        # Containment: a deny-list, not a jail. Reading the saved credentials
        # and rewriting SC Prism's own approvals are closed; everything else
        # still runs, because a containment that blocks `npm test` teaches the
        # user to switch it off. `contained` is recorded on the span so the
        # trace never claims containment that was not applied.
        argv = containment.contain(["/bin/zsh", "-c", command], vault=self.vault)
        self._contained = argv[0] != "/bin/zsh"
        try:
            proc = proc_util.run_bounded(
                argv,
                timeout=timeout_s,
                cwd=cwd,
                env=containment.scrub_env(toolpath.env_with_path()),
            )
        except OSError as exc:
            return self._err(f"could not run: {exc}")

        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        if proc.timed_out:
            partial = (stdout + ("\n" + stderr if stderr else "")).strip()
            note = f"timed out after {int(timeout_s)}s — process group killed"
            return self._err(f"{note}\n[output before the timeout]\n{partial}" if partial else note)
        combined = stdout if not stderr else f"{stdout}\n[stderr]\n{stderr}"
        if len(combined) > _MAX_OUTPUT:
            combined = combined[:_MAX_OUTPUT] + "\n… [truncated]"
        text = combined.strip() or "(no output)"
        if proc.returncode != 0:
            return {
                "content": [
                    {"type": "text", "text": f"{text}\n[exit {proc.returncode}]"}
                ],
                "isError": True,
                "exit_code": proc.returncode,
            }
        return {
            "content": [{"type": "text", "text": text}],
            "isError": False,
            "exit_code": 0,
        }
