# MCP v2b — Model Tool-Use Loop (design)

**Date:** 2026-07-22 · **Status:** approved (autonomous finish loop) · **Builds on:** MCP v1 (governed
stdio client + gates + tool_exec spans), MCP v2a (register/test servers in Settings).

> **Amended 2026-08-18 (live-bug fix).** Two clauses below are superseded by `toolloop.py`, which is
> the contract:
> 1. **The budget note.** "Return `res.text + "[tool budget exhausted …]"`" shipped a raw
>    ```` ```tool_call ```` fence into the user's chat — the model's unexecuted request rendered as
>    its answer. Every return path now strips the fence and marks the reply
>    `[incomplete: I ran out of tool turns (N used) …]`. The same guard covers the F9 prose-wrapped
>    path, which is how the live bug actually reached the screen.
> 2. **`max_iters=4`.** Too small for real research (one failed fetch plus three searches spent it).
>    Now `DEFAULT_MAX_ITERS = 12`, overridable per run (`--tool-turns`) and by `SCPRISM_TOOL_TURNS`,
>    clamped to `MAX_MAX_ITERS = 32`; the run's token budget still binds first.

## Goal
Let a model, mid-build, **autonomously call MCP tools** (and skills exposed as MCP tools): the model
requests a tool → the deterministic loop gates + executes it → feeds the result back → the model
continues → until it produces a final answer or a bounded budget is hit. Reuse MCP's existing gates
and `tool_exec` telemetry. Off by default; byte-identical to today when no MCP tools are configured.

## The one strategic decision — protocol
**Portable text-convention, NOT native provider function-calling.**

- The gateway supports four providers (local/openai/gemini via OpenAI-compat; claude via the
  Anthropic Messages API) **plus** a deterministic offline stub. Native function-calling would mean
  provider-specific `tools=[…]` request payloads AND provider-specific tool-call response parsing in
  `gateway._invoke` for each — and the stub/offline path (what tests + no-key runs use) has no
  function-calling at all. That is a large, fragile, four-way change to the completion primitive.
- A **text convention** keeps `gateway.model_call` untouched (it stays the single completion
  primitive). The model emits a fenced `tool_call` JSON block; the loop parses it from `res.text`,
  gates + executes it, and feeds a `tool_result` block back as the next turn. This works **identically**
  across all four providers and the stub, is trivially testable with a fake model, and **degrades to
  today's single-shot behavior** when no tools are advertised or the model emits none.

### Convention (injected as a system-appended manifest, only when tools exist)
To call a tool, the model replies with ONLY:
```tool_call
{"tool": "<name>", "arguments": { ... }}
```
The loop parses the **last** such block. It appends the model's turn, executes the tool (gated), and
appends an observation turn:
```tool_result
{"tool": "<name>", "ok": true|false, "content": <result-or-error>}
```
The model then continues. A response with **no** `tool_call` block is the final answer.

## ADR-007 reconciliation (recorded as ADR-035)
ADR-007: *no model orchestrates models.* The companion charter already says *"You never orchestrate
other models yourself."* Tool-use does **not** violate this:
- The model **requests** a tool; the **deterministic loop grants or denies** it via the SAME MCP
  allowlist + sensitivity gates (`MCPClient.call_tool` / `_blocked_reason`). A blocked call becomes an
  honest `ok:false` observation fed back — never a crash, never a fabricated success.
- The model never selects models, routes, agents, or verification. It only requests tools within its
  own turn. The loop is **bounded** (`max_iters`, default 4) and **fully telemetered** (every model
  call = a `model_call` span; every tool exec = a `tool_exec` span — no new span types).
- Sensitivity gate still runs BEFORE egress, so a secret still cannot reach an external tool.

→ **ADR-035 (Proposed):** a model may request tools within its own turn through a bounded, gated,
telemetered loop; it still never steers the orchestration. Consistent with ADR-007 and ADR-009.

## Architecture — two layers

### Layer 1 — `engine/scprism_engine/toolloop.py` (pure, dependency-injected, heavily tested)
No subprocess, no network. Everything injected → 100% unit-testable.
```python
@dataclass
class ToolCallTrace:
    tool: str; ok: bool; blocked: bool; detail: str   # detail = error or short result summary

@dataclass
class ToolLoopResult:
    text: str; tokens_in: int; tokens_out: int; is_real: bool
    iterations: int; tool_calls: list[ToolCallTrace]

def build_tool_manifest(tools: list[MCPTool]) -> str        # manifest + protocol text
def parse_tool_call(text: str) -> dict | None              # {tool, arguments} or None; strict; last block wins

def run_tool_loop(*, messages, tools, model_fn, tool_exec, max_iters=4) -> ToolLoopResult
#   messages : base OpenAI-style messages (companion charter + user prompt)
#   tools    : advertised MCPTools (from client.list_tools()); [] => NO manifest, ONE model call, return as-is
#   model_fn : Callable[[messages], ModelCallResult]  — ONE completion (caller owns the model_call span)
#   tool_exec: Callable[[name, args], dict]           — gated call_tool (caller owns gates+tool_exec span); may raise MCPError
```
**Loop contract (bounds model calls to `max_iters+1`, tool execs to `max_iters`):**
1. `res = model_fn(messages)`; accumulate tokens; `is_real` = OR across calls.
2. `call = parse_tool_call(res.text)`. `None` → return `res.text` as the final answer.
3. If `iters >= max_iters` → return `res.text + "\n\n[tool budget exhausted — stopped after N tool calls]"`.
4. Append assistant(res.text). `try: result = tool_exec(tool,args); ok = not result.get("isError")`
   `except MCPError as e: ok=False, blocked=True, detail=str(e)` (honest, no crash). Append the
   `tool_result` user turn. Record a `ToolCallTrace`. `iters += 1`. Go to 1.
- **`tools == []` fast path:** no manifest injected, exactly one `model_fn` call, `ToolLoopResult`
  with `iterations=0, tool_calls=[]` — the byte-identical guarantee.
- **Malformed `tool_call` block** (bad JSON / missing name) → treated as a final answer (never loops).

### Layer 2 — wire into the dispatch model path (`loop.py`, `__main__.py`)
- `_gateway_model(gateway, telemetry, parent_id, models_used, mcp_client=None, mcp_max_iters=4)`:
  - `mcp_client is None` (default) → **unchanged** code path: one span, one `gateway.model_call`
    (byte-identical to today; the None branch is the current function verbatim).
  - `mcp_client` provided → build `tools = mcp_client.list_tools()` once; `_call(prompt, route)` runs
    `run_tool_loop(messages=companion_messages(prompt), tools=tools, model_fn=<span-wrapped call>,
    tool_exec=mcp_client.call_tool, max_iters=mcp_max_iters)`. `model_fn` emits ONE `model_call` span
    per invocation (so the trace shows each turn interleaved with the tool_exec spans). The gateway
    stays authoritative on routing (`gateway.route(prompt)` once, reused for every turn of that step).
- `loop.run(..., mcp_client=None, mcp_max_iters=4)` threads the client to `_gateway_model`. Default
  `None` → nothing changes anywhere.
- CLI: `team` (and `run`) gain `--mcp-server NAME`. When set, load `<vault>/mcp-servers.json`, open an
  `MCPClient` for that server (context-managed), pass it into the run; telemetry already goes to
  `<vault>/spans.jsonl`.

## Tests
- `engine/tests/test_toolloop.py` (pure): no-tools single-call fast path (no manifest, one call);
  one tool call then final; **blocked tool** (tool_exec raises MCPError) → honest `ok:false`
  observation fed back, no crash; **max_iters cap** → honest budget note + bounded call count;
  malformed block → final answer; multiple sequential tool calls accumulate tokens + trace;
  `parse_tool_call` last-block-wins + rejects non-JSON/missing-name; `build_tool_manifest` lists each
  tool name.
- `engine/tests/test_toolloop_integration.py`: the **real** fixture MCP server
  (`tests/fixtures/mcp_echo_server.py`) + the **real** `MCPClient` (real subprocess, real gate, real
  `tool_exec` span) + a fake model that asks to call `echo` then answers → proves connect → list_tools
  → gated call_tool → span → feed-back → final, end-to-end, offline. Assert a `tool_exec` span landed.
- `loop.run` integration: a fake `mcp_client` (list_tools + call_tool) + a fake tool-using model →
  the run completes and the trace/spans show the tool call; and **without** `mcp_client` → the span
  shape/count for a run is unchanged (the byte-identical guarantee), via a focused assertion.

## Honesty invariants (non-negotiable)
- A blocked/sensitive tool call NEVER reaches the server and NEVER returns a fake success — it becomes
  a truthful `ok:false` observation.
- The loop fabricates nothing: tool results are the server's real `content`; model text is the model's.
- Every model call and every tool exec is a real span in `<vault>/spans.jsonl` (the Manager View shows
  the true interleaving for free).
- Off by default: no MCP client → the engine behaves exactly as before (proven by test).

## Out of scope (follow-ons)
- Native provider function-calling (revisit only if a provider needs it).
- Multiple simultaneous MCP servers in one run (v2b connects one named server; the manifest/loop
  already generalize to N tools, so N servers is a small follow-on).
- Parallel tool calls in a single turn (the convention is one tool per turn — sufficient + safest).
