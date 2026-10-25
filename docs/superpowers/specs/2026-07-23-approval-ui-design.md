# App-side approval UI (design) — surface held MCP tool calls + approve

**Date:** 2026-07-23 · **Status:** approved (Sukhdeep picked it).
**Completes:** MCP follow-ons build 2 (the engine approval gate is CLI-only today).

## Honest grounding (match the engine's real behavior)
Build 2's `ApprovalGate` HOLDS a required-but-not-granted tool call: it emits a `tool_exec` span with
`held=True` (server, tool, provider, NO egress) and returns an honest "needs approval" observation —
**the run CONTINUES**, it does not block waiting for a human. So the app-side flow is NOT a mid-run
pause; it is: *review what was held, and grant it so the next run allows it.* The engine already reads
`<vault>/mcp-approvals.json` (`{require, granted}`), so "Approve" = add the tool to `granted`.
Do NOT pretend approving re-executes the already-held call (it returned its honest observation and the
run finished). Copy must say "allowed on your next run", never "the tool ran".

## Scope
1. **Read held calls** from the vault's recent spans (`readSpansTail(vault)`): the tool_exec spans with
   `attrs.held === true`. Dedupe by `server`+`tool` (a tool held N times = one approval item). Keep the
   most recent occurrence's timestamp/args-summary. Native-only; browser → none (honest empty).
2. **Surface on the Work desk "Needs you"** (Desk.tsx): a new desk item kind `tool-approval` — "N MCP
   tool call(s) held for your approval", each row: `server · tool` + a short args/why summary + when.
   Mirrors the existing parked-ask / dispatch-approval item pattern (onApprove callbacks). Only real
   held spans → an item; none → no item (never fabricated).
3. **Approve** → add `server:tool` (or the tool name — match the engine's `granted` matching in
   approval.py: it matches tool OR server OR "all") to `<vault>/mcp-approvals.json` `granted`, via new
   client helpers `readMcpApprovals(vault)` / `writeMcpApprovals(vault, policy)` (mirror
   readMcpServers/writeMcpServers — read/write the JSON via readVaultFile/writeVaultNote; preserve
   `require`). Honest confirmation: "approved — {server·tool} will be allowed on your next run." Remove
   that item from the desk after approving.
4. **Dismiss** (optional) → local-only removal of the desk item for this session (the tool stays
   ungranted = still held next run — which is correct). No denied-list needed for v1.
5. **Settings visibility (optional, if clean):** the "Tools · MCP servers" section could show the
   current `granted`/`require` from mcp-approvals.json read-only ("N tools require approval; M
   granted"). Nice-to-have; the desk flow is the required core.

## Honesty invariants
- Only REAL held spans become approval items — never a fabricated "needs approval".
- Approving writes a real config the engine reads; copy is truthful ("allowed next run", not "ran now").
- No fake success: the held call already returned its honest observation; the UI never implies otherwise.
- Native-gated; browser/non-native shows nothing and never crashes.

## Tests
- `readHeldToolCalls(spans)` (pure): filters tool_exec+held===true, dedupes by server+tool, keeps
  latest; ignores non-held / non-tool spans; [] on no held.
- `readMcpApprovals`/`writeMcpApprovals`: round-trip `{require, granted}`; preserve `require` when
  granting; malformed/missing → sane default (`{require:[],granted:[]}`); non-native → default/false.
- Desk: a held span produces a `tool-approval` item with the right label; Approve calls
  writeMcpApprovals with the tool added to `granted` and removes the item; no held spans → no item;
  browser → no item, no crash.
- byte-identical: with no held spans, the desk renders exactly as today.

## Out of scope (follow-ons)
- A true mid-run blocking pause (engine would need a blocking approval callback + live IPC — a big
  engine change; the held-then-continue model + persistent grant is the honest v1).
- "Approve & re-run this task now" (spans don't carry the originating prompt reliably).
- A denied-list / per-run one-time grants.
