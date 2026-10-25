"""A second tiny stdlib MCP server fixture (stdio, newline-delimited JSON-RPC).

Companion to ``mcp_echo_server.py`` for the multi-server (composite) tests. It
advertises a DISTINCT tool ``upper`` plus an ``echo`` tool that deliberately
COLLIDES with the echo fixture's name, so ``--mcp-server echo,upper`` exercises
both "tools from BOTH servers are visible" and "a name collision is deduped
(first source wins)".

Tools advertised:
  * ``upper(text: string)`` -> returns ``text.upper()`` (unique to this server)
  * ``echo(text: string)``  -> returns ``"upper-echo:" + text`` (name collides
    with the echo fixture; the composite must keep the FIRST server's ``echo``)

Same protocol subset the client uses: initialize -> notifications/initialized ->
tools/list -> tools/call. One line of JSON per message; runs until stdin EOF.
"""

import json
import sys

PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "upper",
        "description": "Uppercase the given text.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "echo",
        "description": "Echo (this server's variant — should be shadowed).",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]


def _result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")

    if method == "initialize":
        return _result(
            req_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "upper", "version": "1"},
            },
        )
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return _result(req_id, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "upper":
            return _result(
                req_id,
                {"content": [{"type": "text", "text": str(args.get("text", "")).upper()}]},
            )
        if name == "echo":
            return _result(
                req_id,
                {"content": [{"type": "text", "text": "upper-echo:" + str(args.get("text", ""))}]},
            )
        return _result(
            req_id,
            {
                "content": [{"type": "text", "text": "unknown tool: %s" % name}],
                "isError": True,
            },
        )

    if req_id is not None:
        return _error(req_id, -32601, "method not found: %s" % method)
    return None


def main():
    while True:
        line = sys.stdin.readline()
        if line == "":
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
