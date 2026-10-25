# Mid-run blocking approval (design)

**Date:** 2026-07-26 · **Status:** approved (Sukhdeep: "do the second one").
**Builds on:** the MCP approval gate (`approval.py` ApprovalGate hold path) + the app-side approval UI.

## Goal
A build can **pause mid-run** at a tool call that needs approval, wait for the user to click
Approve/Deny in the app, and then **resume that same run** with the answer — instead of today's
hold-then-continue + grant-for-next-run. Off by default (byte-identical). Bounded by a timeout so a run
can NEVER hang forever. Honest: a denied/timed-out call is truthfully NOT run (the existing held
observation), never fabricated.

## Architecture — file-based IPC (fits the existing subprocess model)
The engine runs as a headless subprocess that reads/writes the vault; the app already POLLS the vault
(spans, held-tool approvals). So the pause is a vault handshake — NO new socket/streaming infra:
1. Engine hits a tool the policy says HOLD, and blocking is enabled → it writes a REQUEST:
   `<vault>/approvals/pending/<id>.json` = `{id, run_id, server, tool, args_summary, at}` and emits an
   `awaiting=True` tool_exec span.
2. Engine BLOCKS: polls `<vault>/approvals/decided/<id>.json` every ~0.5s, up to `timeout` seconds.
3. App polls `<vault>/approvals/pending/` → surfaces a LIVE "run paused — approve to continue" prompt
   on the Work desk. User clicks Approve/Deny → app writes
   `<vault>/approvals/decided/<id>.json` = `{decision: "allow"|"deny"}`.
4. Engine reads the decision → `"allow"` executes the tool (delegate to the inner source, which STILL
   runs allowlist+sensitivity gates); `"deny"` or TIMEOUT → the honest `_held_result` (tool NOT run,
   run continues). Engine cleans up both files.

## Engine
- `approval.py`: `BlockingApprovalBroker(vault, timeout=300.0, poll=0.5, clock=time)` with
  `await_decision(request: dict) -> "allow"|"deny"|"timeout"` — writes the pending file, polls for the
  decision (bounded), cleans up, returns the outcome. Pure-ish + injectable clock/poll for tests (no
  real sleep in unit tests). Never raises out (a write/read failure → "timeout" so the run continues
  honestly). Atomic writes (temp+rename); id = a uuid or a monotonic counter (no Date.now in the loop —
  use `uuid4` / os.urandom; stamped by the broker, fine).
- `ApprovalGate.__init__(source, policy, broker=None)`. In `call_tool`, the `decision == "hold"` branch:
  - `broker is None` (default) → TODAY'S behavior verbatim (held span + `_held_result`, no egress) —
    byte-identical.
  - `broker` set → write the pending request, emit an `awaiting=True` span, `outcome =
    broker.await_decision(req)`:
      * `"allow"` → emit a resolved span (`awaiting=True, resolved="allow"`) and DELEGATE to the inner
        source (execute the tool; inner gates still run).
      * `"deny"`/`"timeout"` → resolved span (`resolved="deny"/"timeout"`) + the honest `_held_result`
        (never fabricated). Run continues.
  The security boundary is UNCHANGED: nothing egresses until "allow" delegates to the inner source's
  gated `call_tool`.
- `__main__.py` run+team: `--approval-blocking` flag (default off) + `--approval-timeout SECS`
  (default 300). When set AND a policy is active, construct `BlockingApprovalBroker(vault, timeout)` and
  pass it to `ApprovalGate(source, policy, broker=broker)`. No flag → no broker → byte-identical.
- Telemetry: the `awaiting`/`resolved` tool_exec spans let the Manager View show the pause honestly.

## Client
- Rust (`src-tauri/src/lib.rs`): `read_pending_approvals(vault) -> Vec<PendingApproval>` (read the
  pending dir, parse the JSON files) + `write_approval_decision(vault, id, decision)` (atomic write of
  the decided file). Path-safe. (Or reuse list_vault_tree+read_vault_file+write_vault_note if cleaner —
  but a small dedicated command is simplest for the dir scan.)
- `nativeEngine.ts`: `readPendingApprovals(vault)` + `decideApproval(vault, id, decision)` wrappers.
- Desk (`Desk.tsx`/`desk.ts`): a NEW live desk item kind `live-approval` (distinct from the
  after-the-fact `tool-approval` grant): "Build paused — {server · tool} needs your approval to run,"
  with **Approve** (writes decision "allow") and **Deny** (writes "deny"). Poll the pending dir (reuse
  the desk poll cadence). Show it PROMINENTLY at the top of Needs-you; when a live-approval is pending,
  the run state honestly reads "paused — waiting for you." On click, write the decision + remove the
  item (the engine resumes on its own).
- Honesty: the prompt is a REAL pending request the engine wrote; Approve → the tool actually runs;
  Deny → honestly not run; a timeout (engine-side) → the run already continued without it (the item
  disappears when the pending file is cleaned up — the app should also drop a stale pending item whose
  file vanished).

## Honesty + safety invariants
- OFF by default (no `--approval-blocking`) → byte-identical everywhere (proven by test).
- The pause is REAL (subprocess blocks polling) but BOUNDED (timeout) — a run can never hang forever.
- Deny/timeout → the tool is NOT run; the honest held observation is returned; NEVER fabricated.
- Nothing egresses until "allow" reaches the inner source's gated call_tool (security boundary intact).

## Tests
- Broker (injected clock/poll, no real sleep): writes the pending file; returns "allow"/"deny" when the
  decided file appears; returns "timeout" after the bound; cleans up; a write/read failure → "timeout".
- ApprovalGate: broker=None → byte-identical hold path (existing tests pass). broker set + "allow" →
  inner `call_tool` IS invoked (spy); broker + "deny"/"timeout" → inner NEVER invoked + honest
  held_result; the awaiting/resolved spans emitted.
- CLI: `--approval-blocking` wires the broker; absent → no broker (byte-identical).
- Client: readPendingApprovals/decideApproval round-trip; a pending request → a live-approval desk item;
  Approve writes decision "allow" + removes the item; browser/non-native → no item, no crash.

## Out of scope
- A per-tool timeout policy UI (one global `--approval-timeout` for v1). A "pause the whole run vs just
  this tool" toggle (v1 = per tool call). Resuming across app restarts (the engine subprocess owns the
  wait; if the app quits mid-pause, the timeout resolves it honestly).
