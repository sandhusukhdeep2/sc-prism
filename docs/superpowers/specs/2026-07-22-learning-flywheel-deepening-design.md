# Learning Flywheel Deepening (design)

**Date:** 2026-07-22 · **Status:** approved (autonomous finish loop)

## Why (recon verdicts)
- Training records → REAL, but consumed only by `train --dry-run` (open loop).
- GRPO trainer + golden lift-gate + `ModelRegistry` → REAL; **the promoted router is never read at
  runtime** (the biggest open loop). The Rust bridge even forces `--dry-run`, so nothing can be adopted.
- Memory injection → DECORATIVE (debt #10): `select_context` output is recorded on span/Verdict but
  never reaches a model prompt (`loop.py:471-481` — only `skills_block` is prepended; the comment says so).
- `skillStats` reads only `state.verdicts`; `/loop`-run verdicts (`state.loop.verdicts`) never counted —
  the skill AI-improve gate can miss real failures (roadmap #10 in the skill-library design).
- Skill injection + human-gated AI-improve → already REAL-AND-CLOSED (don't touch).

**Honesty framing (non-negotiable):** this is ROUTE-POLICY adoption (a tiny stdlib softmax over
{local, cloud} per intent bucket) — never describe it as the model "learning/retraining itself". The
existing UI copy already says "route-policy learning, not LLM weight fine-tuning" — keep that true.

## LF-1 — Make memory injection REAL (kill debt #10) [engine]
`loop.py`: where `memory_injected = select_context(...)` is computed (~386-392) and the doer prompt
prefix is built (~471-481): format the selected memory as a labelled block and append it AFTER the
skills block, so the doer prompt = `skills_block + memory_block + prompt`. Requirements:
- Read `select_context`'s real return shape first (context.py) and format honestly (a "Working
  context (from your vault):" header + the selected items; no invention, no re-summarization).
- Empty selection → NO block → prompt byte-identical to today (test proves it).
- Attribution unchanged (span/Verdict `memory_injected` already records it — now it's true).
- Update the stale comment ("memory injection into the prompt is not wired yet").
- Tests: memory block reaches the doer prompt when selected (fake model captures its prompt);
  byte-identical when empty; the block is bounded by the existing token budget (select_context
  already enforces it — assert no double-budgeting).

## LF-2 — Adopt the trained router at runtime + human-gated Apply [engine + Rust + client]
### Engine
- `grpo.py`: `load_current_route_policy(vault) -> Optional[RoutePolicy]` — registry.current() →
  load_weights(version) → restore into a RoutePolicy; return None unless the snapshot kind is the
  stdlib route policy; never raises (corrupt/missing → None).
- `gateway.py`: `Gateway.set_route_policy(policy, version_label)` (default None/off). In `route()`,
  ONLY the final default branch changes (gateway.py:424-434): sensitivity→local, reasoning→cloud,
  and `primary_explicit` (the user's explicit choice) all still return first, unchanged. When no
  rule fired AND a policy is set: bucket the intent text with THE SAME categorization used in
  training (reuse grpo's task-bucket helper on the intent text — share code, don't duplicate the
  keyword table), take `policy.act(bucket)`, argmax over {local, cloud} (tie → local, the zero-egress
  default). Route reason string MUST name it honestly, e.g.
  `"learned route policy v3: bucket 'docs' -> cloud (p=0.61)"` — this reason already flows into
  model_call spans, so the Manager View shows the learned decision truthfully for free.
- Wiring: wherever the engine builds the Gateway for a vault-run (`__main__.py` run/team/project
  paths — find every construction site), after construction: `policy = load_current_route_policy(vault)`;
  if present, set it. No promoted policy (the default for every user until they Apply) → Gateway
  behaves byte-identically (tests prove it).
### Rust (`src-tauri/src/lib.rs`)
- KEEP `run_engine_train` forcing `--dry-run` (the preview stays safe). ADD `run_engine_train_apply`
  (same shape, WITHOUT `--dry-run`): the engine itself still only persists on a gate PROMOTE — the
  golden gate remains the machine gate; this command is the human's explicit apply. Register it.
### Client
- `nativeEngine.ts`: `runNativeLearnApply(vault)` mirroring `runNativeLearn` (same parse).
- `LearningPanel.tsx`: after a dry-run result of PROMOTE, enable a second, explicit button
  "Adopt this router" → `runNativeLearnApply`; show its real outcome (promoted vN / discarded).
  Show the currently-adopted router honestly: read `<vault>/training/models/current.json` via the
  existing `readVaultFile` (works for .json; missing → "no learned router adopted yet — routing uses
  the built-in rules"). After adopt, refresh. Copy: "adopting changes ROUTE SELECTION (local vs
  cloud) for the default lane only — sensitivity always stays local; your explicit provider choice
  always wins."
- Tests: engine (policy loads/restores; route() default-branch honors argmax + honest reason;
  sensitivity/reasoning/explicit-primary unchanged with a policy set; no-policy byte-identical;
  corrupt weights → None → unchanged), client (apply button only after PROMOTE; honest empty state;
  jsdom-safe), Rust compiles.

## LF-3 — skillStats sees ALL real runs [client]
`src/lib/skillStats.ts`: the projection currently reads only session verdicts; merge in `/loop`-run
verdicts (`state.loop.verdicts` — check the real store shape) deduped by taskId, newest-first
semantics preserved. Result: `uses/passRate/underperforming` (which gates the skill AI-improve
button) computed over the full body of real outcomes. Tests: a skill disclosed only in loop verdicts
now counts; dedupe on overlap; ordering stable.

## Out of scope
- Any UI claim of "learning" beyond route selection; LLM fine-tuning; new rating widgets (a user
  feedback channel is a product decision for Sukhdeep, not this cycle); touching the skill-improve
  loop (already closed); `_seal` real encryption (stays an honest STUB note).
