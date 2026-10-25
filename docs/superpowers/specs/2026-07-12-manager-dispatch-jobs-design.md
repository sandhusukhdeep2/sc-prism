# Manager dispatch jobs (part B) — design

**Date:** 2026-07-12 · **Status:** approved (Sukhdeep, via design summary) · **Predecessor:** 2026-07-10-manager-agents-design.md (part A; part B was deferred there)

## Problem

Managers today only produce recurring *reports* (prose appended to `vault/reports/…`; Tier-1 deliberately skipped). They cannot hand out real work. Part B gives a manager's job the power to **dispatch a verified task** — through the same engine pipeline chat uses — under a human approval gate.

## Approach (chosen of three)

Dispatch runs the **existing verified single-task loop** (`runNativeTask` → `scprism_engine run`): Tier-1 deterministic checks, Tier-2 judge, hash-chained evidence, a real Verdict, a training record. Rejected: (a) **team dispatch** — engine team runs currently bypass hooks/permissions/budgets/Verdicts (gateway calls only), so unattended team dispatch would contradict verify-before-trust; revisit only after team runs gain governance; (b) **manager-drafted contracts** (the manager's AI refines the intent before approval) — an extra model call with no v1 gain since the user authors the intent at job creation; v2 candidate.

**No engine or Rust changes.** Entirely client-side: `src/lib/managers.ts`, the driver in `src/store/AppStore.tsx`, and the Agents page panel.

## Data model (`src/lib/managers.ts`)

`ManagerJob` gains three optional fields (absent = legacy report job; `sanitize()` must default them):

```ts
kind?: 'report' | 'dispatch'   // default 'report'
approval?: 'ask' | 'auto'      // dispatch only; default 'ask'
pendingSince?: number          // >0 = parked awaiting the user's OK
approvedAt?: number            // >0 = user approved; driver runs it next tick
```

State machine for a dispatch job (pure, exported as `nextDispatchAction(job, managerEnabled, now): 'run' | 'park' | 'wait'`):
- due + `approval:'auto'` → **run**
- due + `approval:'ask'` + not pending + not approved → **park** (set `pendingSince`)
- pending → **wait** (driver skips; UI shows Approve/Reject)
- `approvedAt > 0` → **run** (regardless of `everyMinutes`)

Flag lifecycle: `recordJobRun` is extended to clear `pendingSince` and `approvedAt` alongside setting `lastRun`, so every recorded run resets the state machine. `dueJobs` is extended: it must ALSO return dispatch jobs with `approvedAt > 0` even when their timer isn't due (an approval means "run now"), and must EXCLUDE jobs parked pending (`pendingSince > 0` with no approval) so the driver doesn't churn on them.

Store actions: `approveDispatch(jobId)` (clears `pendingSince`, sets `approvedAt`), `rejectDispatch(jobId)` (clears both flags, sets `lastRun = now` so it quietly reschedules; no run entry recorded — a rejection is not a run), `parkJob(jobId, now)` (sets `pendingSince`; driver-internal).

## Driver (`src/store/AppStore.tsx`, the 30s tick)

For a due job the driver consults `nextDispatchAction` (report jobs keep today's path unchanged):
- **park** → `parkJob`; no engine call.
- **run** → `buildManagerProviders(settings, providerId, { keepTier1: true })` — a new option; **report jobs keep `tier1: ''`**, dispatch jobs keep the user's configured Tier-1 command so real checks run. Prompt: `[MANAGER DISPATCH · <manager> · <dept>] <job.prompt>` (no "reply as a report" suffix). Same 240s race, same serial busy flag.
- Outcome: `ok = verdict !== null && isRealCompletion(verdict.response) && verdict.passed`. On any verdict, `dispatch({ type: 'ADD_VERDICT', verdict })` so it appears on the Verdicts surfaces. Report file gets a dated entry: `## <ts> · dispatch · passed|failed`, the answer (truncated like reports), and a pointer line noting the full Verdict is on the app's Verdicts view. `recordJobRun` as today.

## UI (`src/pages/Agents.tsx`, ManagersPanel)

- Add-job form: a kind selector — **Report** (default) / **Dispatch work** — and, when Dispatch, an approval selector — **Ask me first** (default) / **Auto-run**.
- Job row: a small `work` chip on dispatch jobs; when parked, an amber "awaiting your OK" state with **Approve** / **Reject** buttons inline on the row. Panel-only surfacing in v1 (no topbar pill integration — cut).

## Deliberate cuts (do not build)

Team dispatch; manager-drafted contracts; per-job token budgets (engine default 100k envelope applies; the CLI has no budget flag today); topbar approval-pill integration; any browser-mode behavior (managers stay native-only); notifications.

## Testing

- Pure logic (Vitest, no native): `sanitize()` back-compat (legacy jobs → `kind:'report'`), the `nextDispatchAction` state machine (all four transitions), `approveDispatch`/`rejectDispatch`/`parkJob` effects on state + persistence, `dueJobs` interaction with pending/approved flags.
- Testing boundary: the driver effect and ManagersPanel are native-only (`isNative()` false in jsdom), so their wiring is covered by the pure helpers plus a manual acceptance walk — same boundary the connectivity feature used. No `__TAURI_INTERNALS__` stubs.

## Acceptance

Create a dispatch job ("ask first", every 5 min) → it parks with "awaiting your OK" on the manager card → Approve → it runs the full pipeline, a real Verdict appears, the manager's report file gains a `dispatch · passed|failed` entry, the run dot reflects the result → Reject on the next cycle reschedules it quietly with no run entry. An `auto` dispatch job runs unattended. Existing report jobs behave exactly as before. `verify.sh` stays green.
