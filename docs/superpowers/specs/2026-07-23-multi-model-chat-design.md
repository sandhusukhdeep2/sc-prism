# Multi-model chat (design)

**Date:** 2026-07-23 · **Status:** approved (Sukhdeep: build all remaining).

> **Reconciliation (2026-07-23, hardening H3).** The `· stub` chip / `isReal` meta described
> below was **removed** as a dead branch. In the shipped `sendIntent` flow, an attribution meta is
> dispatched ONLY after `isRealCompletion(verdict.response)` passes — a stub/offline verdict routes
> to an honest error card, never an attributed bubble — so `isReal===false` (and the `· stub`
> chip) was unreachable in production. The honest error-card behavior is kept; the chip and the
> `isReal` field on the message meta / `SET_MESSAGE_MODEL` action were dropped. The rest of the
> attribution (model + route reason + 🔒 local) is unchanged. Read the `isReal`/`stub` mentions
> below as the original proposal, superseded by this note.

## The honest finding
The chat is **already multi-model under the hood**: `sendIntent` (AppStore.tsx ~1440) sends each
message through `runNativeTask` → the engine's `gateway.route(prompt)` picks local vs cloud per
message (sensitivity→local, reasoning→cloud, learned policy in Auto mode), and the returned Verdict
carries the REAL `models_used` + `model_route_reasons`. The gap is **presentation**: the chat bubble
shows only the reply text — it never tells you *which model answered this message or why*. So "make
the chat multi-model" = surface the real per-message routing honestly. Do NOT build a second router.

## Scope
1. **Per-message attribution (core).** Each assistant chat bubble shows an honest chip: the real
   model that answered + the route reason, e.g. `⛭ claude-3.5-sonnet · reasoning` /
   `🔒 local · kept private` / `local · stub` when `is_real` is false (no live LLM). Backed ONLY by
   the Verdict's real fields — never fabricated.
2. **Optional per-message route hint (nice-to-have, include only if clean).** A small control on the
   composer to force the NEXT message local / cloud / auto (default auto = today's behavior). Local
   hint → prepend nothing but pass a route preference the engine honors as a soft hint; if wiring a
   real per-message override is more than a thin pass-through, DEFER it and ship attribution only.

## Design — attribution (core)
- **Type:** extend the `assistant` chat entry (AppStore.tsx:85) with optional meta:
  `model?: string` (the real `provider · model`), `routeReason?: string`, `isLocal?: boolean`,
  `isReal?: boolean`. Optional → every existing assistant message stays valid (persist/back-compat).
- **Wire:** when `sendIntent`'s `runNativeTask` resolves a Verdict, dispatch a new reducer action
  `SET_MESSAGE_MODEL` (id, model, routeReason, isLocal, isReal) derived from the Verdict
  (`models_used[0]`, `model_route_reasons[0]`, route target, `is_real`). The reducer sets the meta on
  that assistant message by id; unknown id → no-op. Pure, id-scoped, other messages untouched.
- **Render:** in the chat bubble component, when an assistant message has `model`, render a small
  attribution chip using the SHARED `modelColor`/`modelKey` (src/lib/modelColor.ts) for the dot and
  the existing honest route-reason phrasing (reuse `routeReasonLabel` logic from nativeEngine, or a
  small shared helper) — `🔒` when local, `· stub` when `isReal===false`. No chip when no meta
  (older messages / in-flight) — never a fabricated label.
- **Honesty invariants:** the chip names the REAL model from the Verdict; a stub run says stub; a
  local turn shows 🔒; nothing is shown if the engine reported nothing. This mirrors the run-stream /
  verdict-card discipline already in the product.

## Tests
- reducer: `SET_MESSAGE_MODEL` sets meta on the right assistant message by id; no-op on unknown id;
  leaves other messages + threads untouched; persists/rehydrates (optional fields back-compat).
- render: an assistant message with `model` shows the chip (model + reason + 🔒 for local + stub for
  !isReal); without meta shows no chip; the chip color matches modelColor for the provider.
- wiring: after a chat `runNativeTask` resolves, the assistant message gets the Verdict's real model +
  reason (a spy/fixture Verdict); a stub Verdict (is_real false) → the chip says stub, not a fake model.
- byte-identical: threads with no model meta render exactly as today.

## Out of scope / follow-ons
- A real engine-level per-message model OVERRIDE beyond a soft route hint (the gateway is authoritative
  by design — ADR-002/026); fanning one message to MULTIPLE models at once; streaming per-token model
  switches. Attribution + an optional soft hint is the honest v1.
