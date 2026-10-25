# Team-run governance — design

**Date:** 2026-07-13 · **Status:** approved (Sukhdeep, one-tap; "normal safe development") · **Roadmap:** #4

## Problem

Team runs (`run_team`) bypass the governance spine every single-task run honors: no TaskContract, no telemetry spans, no token budget (uncapped `O(rounds×agents+1)` model calls), no Verdict, no evidence-chain append, no training record, and the board file is a plain overwrite outside the tamper-evident audit chain. This is safety debt and blocks manager team-dispatch (part C). The fix: route team runs through the same standalone spine helpers the loop already uses.

## Key finding (from extraction)

All five spine pieces are already standalone module functions/classes (`Telemetry.span`, `evals.build_envelope`/`evaluate`, `EvidenceStore.append_verdict`, `training.record_pass`, `writeback.build_verdict`/`write_verdict`) that derive from a Verdict/contract/trace, not from `run()`'s locals. The work is caller-side: build the inputs and call them.

## Design (engine-first; the spine is Python)

### 1. Team gets a TaskContract + budget
`run_team` gains `token_budget: int = 0` (0 = the contract default 100_000). It builds a real `TaskContract` via `contract.parse(intent, mode='read')` — team runs are **read-mode** (they produce advice/a board, they don't write files), which makes the Tier-1 story clean (see §3). `task_id` comes from the contract (slugged from intent), replacing the random hex; the board/verdict/spans all key off it.

### 2. Telemetry spans
Construct `Telemetry(<vault>/spans.jsonl)`; wrap the whole run in a `run` span keyed on the contract task_id, and each agent `model_call` + the synthesis in `model_call` spans (the only allowed types that fit). A team run becomes reconstructable and shows in the engine console.

### 3. Budget enforcement + Tier-1/Tier-2
- **Budget:** before each agent/synthesis `model_call`, if `result.tokens >= token_budget` → stop the loop early, mark `over_budget=True`, record the reason. The accumulation hooks already exist (team.py:148, :176).
- **Tier-1:** a team run has no deterministic verify command. Since it is read-mode advisory work, Tier-1 is a synthetic **pass** (`Tier1Result(passed=True, commands=[], tokens=0)` — "no code gate for an advisory team run", recorded honestly as such), NOT fail-closed. This mirrors how report-mode manager jobs already skip the code gate.
- **Tier-2:** build a team→trace adapter (a lightweight object exposing `tokens_spent = result.tokens` and `step_results` mapped from board messages) + reuse `evals.build_envelope(contract)` → `evals.evaluate(contract, trace, gateway=<lead gw>, envelope, threshold, telemetry)`. The judge scores the synthesis against the intent; the envelope enforces `token_budget`/`max_turns` (a budget breach → Tier-2 fail even if the score is high). `over_budget` also forces the envelope breach.

### 4. Verdict + evidence + training
- `build_verdict(task_id=…, tier1_result=<synthetic pass>, tier2_result=<judge>, tokens_spent=result.tokens, response=synthesis, models_used=<providers used>, artifacts=[board_path], …governance lists empty…)` → `write_verdict(verdict, vault)`.
- `EvidenceStore(vault).append_verdict(verdict, agent_id='team', role='team', intent=…, diff={'writes': [], 'scope': []})` — the team run now sits inside the hash-chained audit spine.
- `training.record_pass(contract, verdict, vault=…, stop_compliant=not over_budget, steps=<rounds×agents>)` — emits a record only when the verdict passed AND not over budget (the seam's existing rule).
- Extract the loop's inline finalize tail (Tier-2 → build_verdict → write_verdict → record_pass → append_verdict) into one reusable helper `finalize_run(...)` in a new `engine/scprism_engine/finalize.py`, called by BOTH `loop.run` (refactor to call it — byte-identical behavior, pinned by the existing 400+ engine tests) and the team path. This avoids duplicating the governance sequence.

### 5. TeamResult carries the Verdict
`TeamResult` gains `passed: bool`, `over_budget: bool`, `token_budget: int`, `reason: str`, `task_id: str`, `spans_path: str`; `to_dict()` emits them. The board file becomes append-safe (still one file per run_id, but written once atomically — no behavior change, it's already one write).

## Bridge + client

- CLI `team` gains `--token-budget` (default 0); `_cmd_team` returns `0 if result.passed else 1` (mirror `_cmd_project`), still `_emit`s the dict.
- Rust `run_engine_team` gains `token_budget: u32` → `--token-budget` argv; forwards the FULL provider set (today it drops primary/sensitive/tier1/flags — bring it to parity with `run_engine_task` so governance routing is consistent); stops treating non-empty stdout as unconditional success is not required (the JSON's `passed` is authoritative and the client reads it).
- TS `runNativeTeam` gains `tokenBudget` param + forwards the full providers; `TeamResult` interface gains `passed/overBudget/tokenBudget/reason/taskId/spansPath`.
- Agents page TeamLauncher: a **token-budget input** (default 100000) and, after a run, a **verdict line** — PASSED/FAILED badge (like VerdictCard) + "N tok / budget M" + over-budget flag + a link to the saved Verdict. No pre-run approval gate in v1 (the user clicking Launch IS the approval; the budget cap is the safety); the board/synthesis rendering stays.

## Cuts

Manager team-dispatch (part C — this feature UNLOCKS it but doesn't build it); write-mode team runs (teams stay advisory/read-mode; file-writing teams are a later feature); per-agent budgets (one run-level cap); pre-run cost preview/approval gate (budget cap replaces it); permission/scope/memory/retrieval injection for teams (the loop's other machinery — out of scope, teams are read-mode advisory).

## Testing

- Engine: `finalize_run` extraction pinned by the full existing suite staying green (byte-identical loop behavior) + new direct tests; team run now: builds a contract, emits spans (assert spans.jsonl non-empty + a run span), enforces budget (a tiny budget stops early + over_budget True + envelope breach → passed False), produces a Verdict on disk, appends to the evidence chain (verify_chain still intact), emits a training record on a passing within-budget run and none when over budget; the synthetic Tier-1 pass is recorded honestly. Offline-stub determinism preserved (no real calls in tests).
- Client: runNativeTeam guard + TeamResult mapping; TeamLauncher budget input + verdict rendering (native-gated — tsc + suite).
- Rust: cargo build.

## Acceptance

Launch a team with a low token budget → it stops early, the result shows FAILED + over-budget; launch with a normal budget → PASSED with a token/budget line, a Verdict file exists in the vault, `verify-chain` reports the chain intact including the team run, and `spans.jsonl` has the team's spans. `verify.sh` PASS; single-task runs byte-identical (the loop refactor changed nothing observable).
