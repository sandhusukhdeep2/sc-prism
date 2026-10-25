"""Governed MCP client (ADR-009) — stdio, newline-delimited JSON-RPC 2.0.

SC Prism's first real **MCP** capability. This is a CLIENT that spawns an
external MCP server subprocess, performs the handshake, lists its tools, and
invokes them — it reads and calls EXTERNAL tools; it is never a model
controlling models (ADR-007). The app Settings UI to register servers and a
model-driven tool-use loop are deliberate follow-ons (out of scope here).

Transport: each JSON-RPC message is one line — ``json.dumps(msg) + "\\n"`` to
the child's stdin; one line read from its stdout, ``json.loads``-ed. Handshake:
``initialize`` (read the result) then the ``notifications/initialized``
notification (no id, no response). Then ``tools/list`` and ``tools/call``.

Governance runs BEFORE any bytes reach the external server:

  1. **Tool allowlist** — when an allowlist is configured, an unlisted tool is
     blocked (no call is made).
  2. **Sensitivity gate** — arguments whose JSON contains any of the engine's
     sensitive keywords (``gateway.SENSITIVE_KEYWORDS``: password / secret /
     token / api-key / ssn / prod / ...) are blocked, because an external tool
     must never receive secrets. The keyword list is REUSED from the gateway,
     never duplicated here.

Honesty is the invariant: a blocked call RAISES ``MCPBlockedError`` (a subclass
of ``MCPError``) and — when telemetry is configured — still emits a
``tool_exec`` span with ``blocked=True``
and ``status="error"`` so the block is auditable. A block is never silently
allowed, and a tool result is never fabricated. Every real ``tools/call`` is
wrapped in a ``tool_exec`` span (``provider="mcp"``).

Disclosure vs. privacy: that span records ``server``/``tool``/``is_error`` and
(2026-08-17) ``bytes`` — the SIZE of the text the server returned, so an MCP call
that came back with 12 KB no longer reads identically to one that came back
empty. It records NO ARGUMENTS, deliberately and permanently. ``webtools`` may
record a URL or a search query because those already left the machine; an MCP
tool's arguments have not, and may hold material the user never egressed. See
**THE PRIVACY LINE** in ``webtools.py`` — this module is on the other side of it.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .gateway import SENSITIVE_KEYWORDS, sensitive_hit

PROTOCOL_VERSION = "2025-06-18"

# Sentinel pushed onto the stdout queue when the child's stdout hits EOF.
_EOF = object()


def _result_text_bytes(result: Any) -> Optional[int]:
    """How many bytes of TEXT an MCP tool result carried, or None if it carried
    no text blocks at all.

    A size, never the content and never the arguments: it lets a UI say an MCP
    call came back with 12 KB (or with nothing) without disclosing one character
    of what the tool returned or what it was asked. Counted in UTF-8 so it is the
    same unit the web tools report.
    """
    if not isinstance(result, dict):
        return None
    content = result.get("content")
    if not isinstance(content, list):
        return None
    total = 0
    saw_text = False
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str):
            saw_text = True
            total += len(text.encode("utf-8", errors="replace"))
    return total if saw_text else None


@dataclass
class MCPTool:
    """A tool advertised by an MCP server (from ``tools/list``)."""

    name: str
    description: str
    input_schema: Dict[str, Any] = field(default_factory=dict)


class MCPError(Exception):
    """Raised on a JSON-RPC error or a protocol/timeout/transport fault."""


class MCPBlockedError(MCPError):
    """Raised specifically when GOVERNANCE blocks a call (allowlist / sensitivity
    gate). A subclass of ``MCPError`` so existing ``except MCPError`` handlers
    still catch it, but distinguishable from an infra fault: the tool-use loop
    audits this as ``blocked=True`` and a plain ``MCPError`` as ``blocked=False``
    (F6), keeping the trace in agreement with the ``tool_exec`` span."""


class MCPClient:
    """A minimal governed MCP client over stdio (JSON-RPC 2.0, newline-delimited).

    Spawns a configured MCP server subprocess, initializes, lists + calls tools.
    Governance: an optional tool allowlist and a sensitivity gate block calls
    before they reach the external server; every call emits a ``tool_exec`` span.
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        allowed_tools: Optional[Sequence[str]] = None,
        telemetry: Optional[Any] = None,
        parent_span_id: Optional[str] = None,
        server_name: str = "mcp",
        timeout: float = 30.0,
    ) -> None:
        # command: [server_program, *args]. allowed_tools: None = allow all;
        # otherwise an allowlist of tool names (empty list = allow nothing).
        if not command:
            raise MCPError("MCPClient requires a non-empty command")
        self.command: List[str] = list(command)
        self.allowed_tools: Optional[set] = (
            None if allowed_tools is None else set(allowed_tools)
        )
        self.telemetry = telemetry
        self.parent_span_id = parent_span_id
        self.server_name = server_name
        self.timeout = float(timeout)

        self._proc: Optional[subprocess.Popen] = None
        self._id = 0
        self._lock = threading.Lock()
        self._stdout_q: "queue.Queue" = queue.Queue()
        self._reader_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._initialized = False
        self._closed = False
        self._server_info: Dict[str, Any] = {}

    # -- context management --------------------------------------------

    def __enter__(self) -> "MCPClient":
        self.start()
        try:
            self.initialize()
        except BaseException:
            # A failed handshake (timeout / broken pipe / JSON-RPC error) raises
            # before __enter__ returns, so Python would NEVER call __exit__ — the
            # child + reader threads would orphan. Close before re-raising.
            self.close()
            raise
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- lifecycle ------------------------------------------------------

    def start(self) -> None:
        """Spawn the server subprocess and start the stdout/stderr readers."""
        if self._proc is not None:
            return
        self._proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",  # JSON-RPC is UTF-8; don't depend on the locale (LANG=C)
            bufsize=1,  # line-buffered writes to the child's stdin
        )
        # A reader thread drains stdout into a queue (so a matching-id read can
        # time out cleanly and the pipe never back-pressures the child).
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()
        # A stderr drainer thread so a chatty server can't fill the pipe and hang.
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _read_stdout(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                line = proc.stdout.readline()
                if line == "":  # EOF
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    self._stdout_q.put(json.loads(line))
                except json.JSONDecodeError:
                    continue  # ignore non-JSON noise on stdout
        except Exception:
            pass
        finally:
            self._stdout_q.put(_EOF)

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                if proc.stderr.readline() == "":
                    break
        except Exception:
            pass

    def close(self) -> None:
        """Terminate the child (terminate -> wait -> kill); join reader threads.

        Leaves no orphan process behind and is idempotent.
        """
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is not None:
            # EOF on stdin lets a well-behaved server exit on its own.
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:
                pass
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    try:
                        proc.wait(timeout=2.0)
                    except subprocess.TimeoutExpired:
                        pass
        # The child's exit closes the stdout/stderr write ends -> the reader
        # threads see EOF and return; join them so nothing dangles.
        for thread in (self._reader_thread, self._stderr_thread):
            if thread is not None:
                thread.join(timeout=2.0)
        # Threads have returned; now close our read ends so no fd is leaked.
        if proc is not None:
            for stream in (proc.stdout, proc.stderr, proc.stdin):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:
                    pass

    # -- handshake + discovery -----------------------------------------

    def initialize(self) -> Dict[str, Any]:
        """Send ``initialize``, read the result, send ``notifications/initialized``.

        Returns ``{"serverInfo": ..., "capabilities": ...}``.
        """
        if self._initialized:
            return self._server_info
        result = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "sc-prism", "version": "1"},
            },
        )
        # A notification: no id, no response expected.
        self._notify("notifications/initialized")
        self._initialized = True
        self._server_info = {
            "serverInfo": result.get("serverInfo", {}),
            "capabilities": result.get("capabilities", {}),
        }
        return self._server_info

    def list_tools(self) -> List[MCPTool]:
        """``tools/list`` -> a list of ``MCPTool``."""
        result = self._request("tools/list", {})
        tools: List[MCPTool] = []
        for entry in result.get("tools", []) or []:
            if not isinstance(entry, dict):
                continue
            tools.append(
                MCPTool(
                    name=str(entry.get("name", "")),
                    description=str(entry.get("description", "")),
                    input_schema=entry.get("inputSchema", {}) or {},
                )
            )
        return tools

    # -- the governed call ---------------------------------------------

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Governed ``tools/call``. Blocks (raises) before any bytes egress.

        1) allowlist gate, 2) sensitivity gate, 3) tool_exec-traced call.
        """
        arguments = arguments or {}
        blocked_reason = self._blocked_reason(name, arguments)
        if blocked_reason is not None:
            # Audit the block (blocked=True, status=error), THEN raise — the
            # block is never silently allowed and no result is fabricated.
            if self.telemetry is not None:
                with self.telemetry.span(
                    "tool_exec",
                    span_type="tool_exec",
                    parent=self.parent_span_id,
                    provider="mcp",
                    server=self.server_name,
                    tool=name,
                    blocked=True,
                ) as sp:
                    # The REASON, never the arguments — the block fired because
                    # those arguments looked like a secret.
                    sp.set(reason=blocked_reason)
                    sp.set_status("error")
            # F6: a governance block raises the BLOCKED subclass so the tool-use
            # loop can tell it apart from a transport/JSON-RPC fault.
            raise MCPBlockedError(blocked_reason)

        # Not blocked: perform the real call, traced.
        if self.telemetry is not None:
            with self.telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=self.parent_span_id,
                provider="mcp",
                server=self.server_name,
                tool=name,
            ) as sp:
                result = self._request(
                    "tools/call", {"name": name, "arguments": arguments}
                )
                sp.set(is_error=bool(result.get("isError")))
                # HOW MUCH came back. An MCP row used to read `⛭ notion·search`
                # and nothing else, so a call that returned a page of results
                # and one that returned nothing were the same row. This is a
                # SIZE, not content and not arguments — the safe half of the
                # disclosure (see the module docstring / THE PRIVACY LINE in
                # webtools.py). Never the arguments, never the result text.
                size = _result_text_bytes(result)
                if size is not None:
                    sp.set(bytes=size)
                return result
        return self._request("tools/call", {"name": name, "arguments": arguments})

    def _blocked_reason(self, name: str, arguments: Dict[str, Any]) -> Optional[str]:
        """Return why the call is blocked, or None to allow it."""
        # 1) Tool allowlist.
        if self.allowed_tools is not None and name not in self.allowed_tools:
            return "tool '%s' is not allowed" % name
        # 2) Sensitivity gate — REUSES gateway.sensitive_hit (no duplication):
        #    the SAME word-aware rule route() and the result guard use.
        if sensitive_hit(json.dumps(arguments, ensure_ascii=False)) is not None:
            return (
                "blocked: tool arguments contain sensitive data "
                "(external tools must not receive secrets)"
            )
        return None

    # -- JSON-RPC internals --------------------------------------------

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _write(self, msg: Dict[str, Any]) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise MCPError("MCP server process is not started")
        line = json.dumps(msg, ensure_ascii=False)
        # JSON-RPC messages MUST be one line; json.dumps is single-line, but be
        # defensive in case a value somehow carries a literal newline.
        if "\n" in line or "\r" in line:
            line = line.replace("\n", " ").replace("\r", " ")
        try:
            self._proc.stdin.write(line + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise MCPError("failed to write to MCP server: %r" % exc)

    def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            msg: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if params is not None:
                msg["params"] = params
            self._write(msg)

    def _request(self, method: str, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Write a request with a fresh id; read lines until the matching id.

        Raises ``MCPError`` on a JSON-RPC ``error``, on a closed stream, or on a
        timeout.
        """
        with self._lock:
            req_id = self._next_id()
            msg: Dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
            if params is not None:
                msg["params"] = params
            self._write(msg)

            deadline = time.time() + self.timeout
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise MCPError(
                        "timed out waiting for response to %r (id=%d)"
                        % (method, req_id)
                    )
                try:
                    item = self._stdout_q.get(timeout=remaining)
                except queue.Empty:
                    raise MCPError(
                        "timed out waiting for response to %r (id=%d)"
                        % (method, req_id)
                    )
                if item is _EOF:
                    raise MCPError(
                        "MCP server closed stdout before responding to %r" % method
                    )
                if not isinstance(item, dict):
                    continue
                if item.get("id") != req_id:
                    # A notification or a stale/other-id message — ignore it.
                    continue
                if item.get("error") is not None:
                    raise MCPError(
                        "MCP server error for %r: %r" % (method, item["error"])
                    )
                return item.get("result", {}) or {}


def load_mcp_servers(path: str) -> Dict[str, dict]:
    """Load a JSON server config into a dict keyed by server name.

    File shape: ``[{"name":..., "command":[...], "allowed_tools"?:[...]}]``.
    A missing file returns ``{}``; a malformed file raises ``MCPError``.
    """
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise MCPError("failed to read MCP server config %r: %r" % (path, exc))
    if not isinstance(data, list):
        raise MCPError("MCP server config %r must be a JSON array" % path)
    servers: Dict[str, dict] = {}
    for entry in data:
        if not isinstance(entry, dict):
            raise MCPError("MCP server config entry must be an object: %r" % (entry,))
        name = entry.get("name")
        command = entry.get("command")
        if not isinstance(name, str) or not name:
            raise MCPError("MCP server config entry missing a string 'name'")
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) for part in command)
        ):
            raise MCPError(
                "MCP server %r needs a non-empty string-list 'command'" % name
            )
        allowed = entry.get("allowed_tools")
        if allowed is not None and (
            not isinstance(allowed, list)
            or not all(isinstance(part, str) for part in allowed)
        ):
            raise MCPError("MCP server %r 'allowed_tools' must be a string list" % name)
        servers[name] = {
            "name": name,
            "command": list(command),
            "allowed_tools": list(allowed) if allowed is not None else None,
        }
    return servers
