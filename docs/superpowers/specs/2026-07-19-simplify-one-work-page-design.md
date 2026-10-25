# Simplify SC Prism into one chat-centric Work page — master design

**Date:** 2026-07-19 · **Authorized:** Sukhdeep ("finish the whole product, don't ask questions"). **Proposal (approved):** the artifact / research — a project is a *context you point one chat at*, not a page. **Research basis:** ChatGPT/Claude/Cursor/Windsurf/Copilot converge on: one chat surface, project = container {chats + knowledge + instructions + scoped memory}, switch = re-point (no page jump), auto-compaction with a visible meter.

## Current problems (mapped)
Two separate chat engines on two pages (Workspace `state.messages`/`sendIntent` vs. ProjectView `project.transcript`/`askProject`, and the project chat vanishes after planning). The "project switcher" only swaps injected context into ONE shared thread — no real per-project sessions. 10 flat top-nav pages, page-bouncing deep links, no chat compaction, dead/showcase pages.

## Phases (each independently shippable; built in order)

### Phase 1 — One Work page + real per-project chat sessions (foundation)
- **Unified chat model.** ONE `ChatMessage` type (fold `ProjectTurn` into it). Messages live in **threads keyed by scope**: `'universal'` (no project) + one thread per `projectId`. Replace the single `state.messages` with `state.threads: Record<string, ChatMessage[]>` (back-compat: migrate the old `messages` → `threads.universal`; migrate each project's `transcript` → `threads[projectId]`). The active thread = `activeProjectId ?? 'universal'`.
- **One send path.** Collapse `sendIntent` + `askProject` into one `send(text)` that appends to the ACTIVE thread and runs the right pipeline: universal → companion; a project thread → the project pipeline (interview/plan/build as the project's status dictates), carrying that project's context. No second engine.
- **The Work page** (merge Workspace + Projects): left sidebar = **Universal chat** + **Projects as folders** (each a switchable session, "＋ New project" inline); center = the active thread's chat + composer; right rail = the active project's context (knowledge, its team with live status, the context meter placeholder). Switching a project **re-points** the page — no route change. Keep the cinematic build stage reachable from the project thread.
- Routing: `/` = the Work page. `/projects` redirects into it (project selected). No "Open in Workspace" jump — it's the same page.

### Phase 2 — Context meter + auto-compaction (vault-backed)
- Per-thread token estimate + a **meter** (green <60% / amber 60–85% / red >85%, "% until compact"). Thresholds: soft "Compress now" at ~60%, auto-compaction at ~75%, hard safety at ~90%.
- Compaction: summarize older turns of the active thread into a structured summary block (plan/tasks/decisions), drop them, continue; a visible "— compacted earlier context —" divider. Use a cheap/fast model for the summary. **Non-lossy:** write the full pre-compaction transcript + summary to the thread's vault page (`<vault>/conversations/<thread>.md`), so compressed ≠ lost. Manual "Compress now" + "New session" levers.

### Phase 3 — Collapse the navigation (10 → ~3 + a menu)
- Top level: **Work**, **Vault**, **Settings**. Everything else moves into a tidy menu / Settings, still fully reachable: Agents & Skills (review/create/rate), Loop/Schedules (Automations), Stats/Memory/Console (Advanced/Inspect). Editor/Verdict/Approval → click-through panels on the Work page. **Cut** the showcase pages (Orchestration, CompanionStates) + the dead `nav.ts pages[]` map.

### Phase 4 — Training page + agent/skill ratings + Live activity
- A first-class **Training** page: run the learning step (`train --dry-run`), show the honest route-policy lift + history; a path to promote when the golden gate passes.
- **Ratings** everywhere agents/skills appear: agent = real `agentActivity` (runs · pass-rate · working/idle); skill = `skillStats` (uses · pass-rate · helping/underused) — clear "is-it-working."
- **Live activity panel** on a building project: each agent's live status + the skill it's using + a feed of events (team assembled, skill used, "＋ created agent/skill for this project" when it happens).

## Pending fixes folded in
- **Companion false-offline:** stop the chat asserting a provider is offline from stale manager-report text; guide to the team/build for multi-model work.
- Deferred (own slice, not blocking): image attach (multimodal, vision-gated); dictation hint; the coworker auto-*minting* a new agent/skill mid-run (bigger capability).

## Invariants
No new deps; engine largely untouched (client restructure). Back-compat: existing persisted sessions/projects migrate cleanly. Each phase `verify.sh` PASS + reviewed. Honesty: never fabricate activity; "compressed" writes the truth to the vault; don't claim web research (not wired).

## Acceptance
One page where you never wonder "where am I": universal chat + a real chat session per project via the sidebar; long chats show a meter and compact visibly without losing anything; the top nav is 3 surfaces + a menu; a Training page runs learning; every agent/skill shows if it's working.
