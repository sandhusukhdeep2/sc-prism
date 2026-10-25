# Manager team-dispatch (part C) — design

**Date:** 2026-07-16 · **Status:** approved (Sukhdeep, one-tap) · **Unblocked by:** team-run governance (roadmap #4, shipped 2026-07-16) · **Extends:** manager dispatch jobs (part B, 2026-07-12)

## Problem

Managers can dispatch single verified tasks (part B) but not teams. #4 made team runs governed (hard budget, real Verdict, evidence, `TeamResult.passed`), which was the blocker. Part C: a manager job can launch a governed team run under the same ask/auto approval gate.

## Design (client-only; engine/bridge untouched)

1. **Job kind `team`.** `ManagerJob.kind` becomes `'report' | 'dispatch' | 'team'` (`jobKind` returns it; sanitize normalizes unknown → 'report' as today). Team jobs add `roster?: string` ('' = default) and `tokenBudget?: number` (0/absent = 100_000). `addJob` gains the two optional trailing params.
2. **Approval machine reused verbatim.** `nextDispatchAction` treats `'team'` exactly like `'dispatch'` (ask parks via `pendingSince`, `approveDispatch`/`rejectDispatch`/`recordJobRun` lifecycle unchanged). `dueJobs` logic untouched (it is kind-agnostic on the flags).
3. **Default roster.** Pure helper `defaultTeamRoster(managerProviderId: string): string` → `lead:<managerProviderId>,researcher:local,critic:<cloud>` where `<cloud>` = 'gemini' unless the manager IS gemini (then 'claude'). Manager's AI always leads — the manager runs its own team.
4. **Driver (the manager tick).** For a due team job that `nextDispatchAction` says to run: providers = `buildEngineProviders(settings).providers` (full set — teams route per-agent; the manager's provider leads via the roster, NOT via providers.primary override); `primaryReal` gate as today (via `buildManagerProviders(s, manager.providerId)` for the connectivity check only — reuse the existing refusal path); `runNativeTeam(prompt, vault, providers, roster, 1, job.tokenBudget || 100_000)` raced vs **300_000 ms**; `ok = !!res && res.passed`; report entry heading `team · passed|failed` (failed also when timeout/null: text `(no team result — provider offline or timed out?)`), body = synthesis + `\n\n{tokens.toLocaleString()} / {tokenBudget} tok` + over-budget note when set + `\nverdict: <verdictPath>` when present; `recordJobRun(job.id, now, ok, synthesis-or-reason slice)`. Prompt: `[MANAGER TEAM · <manager.name> · <dept>] <job.prompt>` (no report suffix).
5. **UI (Agents page).** Kind selector gains `team run (governed multi-agent)`; selecting it reveals a roster input (placeholder = the default roster for the currently selected manager) and a budget number input (default 100000, min 1000, the launcher's NaN-guard idiom). Job rows: `team` chip (styled like the `work` chip); parked/approve/reject identical to dispatch.

## Cuts (documented)

Refine-on-fail (failed team jobs reschedule on their normal interval); ADD_VERDICT/in-app verdict card for team jobs (the Verdict is on disk + in the evidence chain, linked from the report entry); multi-round (rounds=1); per-agent budgets; roster validation beyond trim (bad rosters fail honestly engine-side).

## Testing

Pure (Vitest): `jobKind` 'team'; `nextDispatchAction` for team jobs (all four transitions — parametrize the existing dispatch tests over both kinds or add team cases); `defaultTeamRoster` (manager-as-lead, gemini-manager → claude critic); sanitize back-compat (legacy + dispatch jobs unchanged; team fields normalized: roster string else '', tokenBudget number else 0); `addJob` team params. Driver/UI native-gated: tsc + full suite + manual acceptance. No `__TAURI_INTERNALS__` stubs.

## Acceptance

Add a team job ('ask', budget 100k) to an enabled manager → parks with Approve/Reject → Approve → the team runs (serial board, budget-capped), the manager's report gains `team · passed` with the synthesis + token line + verdict path, the run dot goes green; a FAILED run (tiny budget) records `team · failed` honestly and reschedules. Report/dispatch jobs byte-identical. `verify.sh` PASS.
