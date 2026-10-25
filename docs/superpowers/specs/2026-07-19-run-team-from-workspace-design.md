# Run the multi-model team from the Workspace chat — design

**Date:** 2026-07-19 · **From Sukhdeep (repeated, core):** "only the main AI is working, it's not using Gemini/local — even after I made agents on different models." **Root cause (traced):** the Workspace chat calls ONE model (the primary companion, `runNativeTask`); the real multi-model pipeline (`runNativeTeam`, which routes each agent to its own model) only runs from the Team Launcher / a project build — never from the chat. Separately, the companion parrots stale manager-report text and falsely claims providers are offline.

## The fix (two parts)

### Part 1 — "Run with your team" in the Workspace (the real multi-model run)
Add an action in the Workspace composer: **"▶ Run with your team"**. It runs the current message through `runNativeTeam(intent, vault, providers, roster, rounds, tokenBudget)` — the REAL governed pipeline that dispatches each agent to its own model — and shows the result in the chat.
- **Roster source:** if a project is active AND has assigned agents (`agentsForProject(list(), activeProjectId)`), use `agentRoster(those)` — the user's own different-model agents. Else fall back to `defaultProjectRoster(primary)` (lead/planner/developer). If no real primary, honest refusal (as chat already does).
- **Providers:** the FULL `buildEngineProviders(settings, activeProjectId).providers` (teams route per-agent; every connected model is reachable). This actually pings the live providers — so if Gemini/local are connected, they run (fixing the false-offline perception at the source: the team run uses live providers, not stale reports).
- **Show the result in the chat** as a distinct assistant/verdict message: the synthesis + a clear line **"Ran with your team — models used: gemini · local · claude-cli"** (from `TeamResult.models_used`/board) + PASS/FAIL + token/budget + a link to the verdict. Reuse the part-C `teamReportBody(res)` shaping. A busy state while it runs (serial board can take a while). Honest failure if it times out / a provider is truly down (names which).
- ADR-007 preserved: deterministic code launches and governs the team; the primary is the lead role, not the orchestrator.
- Keep the plain chat send (single primary) as-is for conversation/planning. The team action is the explicit "do the multi-model work" path.

### Part 2 — stop the companion falsely claiming offline + guide to the team
In `buildCompanionContext`:
- Do NOT feed the model manager-report text that asserts provider connectivity ("provider not connected / offline"). Either drop the connectivity claims from the injected manager reports, or add an explicit instruction: **"Do NOT state that any provider is offline — live connectivity is shown in Settings; you cannot observe it. If the user wants multiple models to work together, tell them to use 'Run with your team' (a deterministic multi-model run) or build the project — you (one model) do not orchestrate other models."**
- The `Connected AIs` line should reflect real connected providers (from settings' connected flag), not stale interview data — or be omitted if it can mislead.
- Result: the chat stops saying "Gemini is offline" and instead points the user to the real multi-model action.

## Testing / acceptance

- `teamRosterForActive(activeProject, agents, primaryId)` pure helper (assigned agents → their roster; none → default; used by the button) — unit-tested.
- The companion-context change: a test that the offline-claim guidance is present and no stale "offline" assertion is injected; no-active-project path still sane.
- Acceptance: with Gemini + local + Claude connected and 3 agents (one per model) assigned to the active project, click **Run with your team** on a message → the chat shows all three models ran (models_used lists them) + a verdict. The chat never claims a connected provider is offline. `verify.sh` PASS.

## Cuts

Streaming the board live into the chat (show it as one result when done — a later polish); running the team without any project/agents uses the default roster (fine). This is the bridge from "chat = one model" to "the chat can actually run all your models."
