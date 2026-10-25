# Coworker Desk — design

**Date:** 2026-07-13 · **Status:** approved (Sukhdeep, one-tap) · **Roadmap:** #2 "coworker welcome dashboard"

## Problem

Opening SC Prism lands on a stat strip + chat. Sukhdeep's vision: the app should greet him like a coworker — surface every decision waiting on him with the buttons to act inline, show what's running, and hand him his work — "not like an overview."

## Placement

The desk replaces/extends the top of the **Workspace** (the index route) — greeting → desk sections → the existing chat below. No new page, no nav hop. Client-only; no engine/Rust changes.

## Sections (top to bottom; a section with nothing to show renders NOTHING)

1. **Greeting.** `Good {morning|afternoon|evening}, {firstName}` — extraction found NO user-name field exists (companionName is the AI's); a new optional `yourName: string` on Settings (with a "Your name" input on the Settings page) feeds it; empty → plain `Good {daypart}`. One companion status line assembled from live state (counts of needs-you items + the running build's step), e.g. "2 things need your decision · portfolio-site is mid-build, step 3 of 5." All real; no canned copy when there's nothing to say (falls back to the existing kicker text).
2. **Needs You.** One rail of `DeskItem`s aggregated from: (a) manager dispatch jobs parked (`pendingSince>0`) → Approve/Reject inline (existing `approveDispatch`/`rejectDispatch`); (b) projects `awaiting` → the ask text + Yes/No (existing `answerProjectRequest`, only live when the driver is parked — otherwise a Resume button, reusing the B4 logic); (c) projects `attention` → Resume (runProject); (d) loop `pendingApproval` → Approve/Reject (existing approveStep/rejectStep) + jump to Loop; (e) connectivity `anyDown` → the existing banner semantics (Retry/Open Providers) folded into the rail as an item. Ordering: requests first (b), then approvals (a, d), then attention (c), then connectivity (e).
3. **Happening Now.** Running project (name + "step x of y", click → `/projects?open=<id>`); enabled managers count + most recent job run line; standing loops next-due (from the schedules store) — each only when present.
4. **Health + Today.** The existing three stat tiles stay; joined by a health chip row: providers (reuse `isEffectivelyDown` summary), vault configured, engine mode (native real engine / browser sim — honest), verdict pass-rate over the last 10 verdicts in session state.
5. **Catch-up.** Latest manager-run summaries (newest `runs[0]` across reported jobs, max 3, click → `/vault`); up to 3 most recent projects (status chip + click → open).

## Architecture

- **`src/lib/desk.ts`** — pure, fully unit-tested: `DeskItem` union + `buildDeskItems(inputs)` + `greeting(now, name)` + `statusLine(items, runningProject)` + `passRate(verdicts, n=10)` + `recentManagerRuns(state, max=3)`. Inputs are plain state snapshots (ManagersState, Project[], LoopState bits, connectivity aggregates, notices) — no store imports, no React.
- **`src/components/Desk.tsx` + `Desk.css`** — thin renderer: consumes the pure module + the existing stores/hooks, dispatches only pre-existing actions. Native-only items simply don't appear in the browser (their source stores are empty there); the section-hiding rule keeps the browser honest.
- Workspace.tsx: the `ws__strip` region is reorganized — greeting/status replaces the static "Welcome back", Desk sections mount between strip and the connectivity banner. The standalone ConnectivityBanner remains (it's the e-item's fuller form) — the desk's connectivity item renders ONLY when the banner was dismissed (no double chrome).

## Cuts

Team-head task allocation (team/host mode #8); notification history; configurable/collapsible layout; macOS notifications; new engine surface of any kind.

## Testing

Pure module fully covered (item aggregation per source incl. ordering + empty-hiding; greeting boundaries 5/12/17h; pass-rate math incl. <n verdicts; status line composition). Components: native-gated thinness — tsc + full suite + the section-hiding logic covered via the pure module. Manual acceptance: with a parked dispatch + an awaiting project + a dead provider, the desk shows three actionable items and each button works without leaving the page; empty state shows greeting + stats only.

## Acceptance

Open the app → greeted by name with an honest status line → every parked decision visible and actionable inline → running build visible with live step → health row truthful (browser shows "simulation" engine mode) → nothing renders empty chrome. `verify.sh` PASS; v1/v2 project flows untouched.
