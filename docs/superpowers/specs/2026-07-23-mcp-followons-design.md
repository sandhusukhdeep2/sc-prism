# MCP follow-ons (design): multi-server per run + engine-level approval gate

**Date:** 2026-07-23 · **Status:** approved (build all remaining).
**Builds on:** MCP v2b + `CompositeToolClient` (already merges N tool sources) + the gate/telemetry spine.

## Part A — multiple MCP servers in one run
`--mcp-server` takes one name today; `CompositeToolClient([...])` already merges N duck-typed sources
(built for web research). So: let `--mcp-server` accept MULTIPLE (repeatable flag, or comma-list),
resolve + open each as an `MCPClient`, and wrap them (plus a web provider if `--web`) in one
`CompositeToolClient`. Name-dedupe already handled by the composite. One server → unchanged
(no composite needed). Small, clean.

## Part B — engine-level approval gate (hold a tool call for sign-off)
Today the loop gates on allowlist + sensitivity (auto allow/deny). Add a THIRD, human/policy gate:
certain tool calls are **held** for explicit approval before they run — the multi-user / stricter-
governance primitive.

- `ToolApprovalPolicy(require: set[str]|"all", granted: set[str])` — `.decide(server, tool, args) ->
  "allow" | "hold"`. A tool is HELD when it (or its server, or "all") is in `require` and not in
  `granted`. Empty `require` (the default) → everything "allow" → byte-identical to today.
- `ApprovalGate(source, policy)` — a duck-typed tool source WRAPPING another (MCPClient / composite):
  `list_tools()`/`parent_span_id` pass through; `call_tool(name, args)` FIRST consults the policy:
  * `"hold"` → emit a `tool_exec` span with `held=True` (provider from the inner source, tool, NO
    egress) and return an HONEST held result (`isError`-shaped:
    `{"isError":True,"held":True,"content":[{"type":"text","text":"held: tool '<name>' needs approval
    — not run"}]}`) — the model sees it, the loop continues, NOTHING egressed. Never executes.
  * `"allow"` → delegate to the inner `call_tool` (which still runs the allowlist + sensitivity gates
    before egress — approval is ON TOP of, never instead of, those).
  The held path must run BEFORE the inner source touches a socket. This is the security boundary.
- CLI: `--require-approval [all | <server-or-tool>,...]` (default none) + `--approve
  [<server-or-tool>,...]` (pre-granted this run); OR a policy file `<vault>/mcp-approvals.json`
  (`{"require":[...],"granted":[...]}`) loaded when present. Env fallback optional.
- Wiring (`__main__.py` run/team): when a policy is active, wrap the resolved tool source in
  `ApprovalGate` before passing it to the run. No policy → no wrapper → byte-identical.

## Honesty invariants
- A held call NEVER egresses and NEVER returns a fabricated success — it returns a truthful "held,
  needs approval" observation and is audited as a `held=True` tool_exec span.
- Approval is additive: allowlist + sensitivity gates still run for allowed calls (defense in depth).
- Off by default (empty require) → byte-identical; proven by test.

## Tests
- multi-server: two fixture MCP servers via `--mcp-server a,b` (or repeated) → the loop sees tools
  from BOTH (composite); a name collision is deduped; one server → no composite (unchanged).
- ApprovalGate: a required-but-not-granted tool is HELD (held tool_exec span, honest held result, the
  inner source's `call_tool` is NEVER invoked — assert with a spy/fake inner that records calls); a
  granted tool passes through and still hits the sensitivity gate; "all" holds everything ungranted;
  empty policy → every call delegates (byte-identical).
- policy loading: `<vault>/mcp-approvals.json` + `--require-approval`/`--approve` parse; malformed →
  honest error, run doesn't crash.
- byte-identical: no `--require-approval`/no policy file → the run is unchanged (existing v2b/web tests green).

## Out of scope (follow-ons)
- The app-side sign-off UI (surface held tool calls on the Work desk like manager ask-mode, let the
  user approve → re-run). The engine primitive + CLI + honest held outcome is this build; the
  interactive approval surface is a clean follow-on that reads the held spans.
- Persistent cross-run approval memory.
