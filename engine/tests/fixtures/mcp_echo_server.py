"""A tiny stdlib MCP server fixture (stdio, newline-delimited JSON-RPC 2.0).

Used by ``engine/tests/test_mcp.py`` to drive ``MCPClient`` against a REAL MCP
handshake with NO external dependency. It speaks the same protocol subset the
client uses:

    initialize -> notifications/initialized -> tools/list -> tools/call

Tools advertised:
  * ``echo(text: string)``          -> returns ``text`` verbatim
  * ``add(a: number, b: number)``   -> returns ``str(a + b)``

Every message is exactly one line of JSON on stdin/stdout (no embedded
newlines). Requests carry an integer ``id``; the notification
``notifications/initialized`` has no ``id`` and gets NO response. The loop runs
until stdin EOF, then exits 0.

Runnable as ``python <path>`` or ``python -m ...``.
"""

import json
import sys

PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "echo",
        "description": "Echo the given text back to the caller.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "add",
        "description": "Add two numbers and return their sum as text.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
]


def _result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code, message):
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def _fmt_number(value):
    """Render an int-valued sum without a trailing ``.0`` (2 + 3 -> "5")."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def handle(msg):
    """Return a response dict, or None for a notification (no response)."""
    method = msg.get("method")
    req_id = msg.get("id")

    if method == "initialize":
        return _result(
            req_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo", "version": "1"},
            },
        )

    if method == "notifications/initialized":
        return None  # a notification: acknowledge nothing

    if method == "tools/list":
        return _result(req_id, {"tools": TOOLS})

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "echo":
            return _result(
                req_id,
                {"content": [{"type": "text", "text": str(args.get("text", ""))}]},
            )
        if name == "add":
            total = (args.get("a", 0) or 0) + (args.get("b", 0) or 0)
            return _result(
                req_id,
                {"content": [{"type": "text", "text": _fmt_number(total)}]},
            )
        return _result(
            req_id,
            {
                "content": [{"type": "text", "text": "unknown tool: %s" % name}],
                "isError": True,
            },
        )

    # Unknown method: answer a request with a JSON-RPC error; ignore a notification.
    if req_id is not None:
        return _error(req_id, -32601, "method not found: %s" % method)
    return None


def main():
    while True:
        line = sys.stdin.readline()
        if line == "":  # EOF
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle(msg)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
