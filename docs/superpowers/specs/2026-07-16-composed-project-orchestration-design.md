# Composed project runs — orchestration, loops, per-role skills, learning, result link

**Date:** 2026-07-16 · **Author:** Claude (autonomous build authorized by Sukhdeep — "start building from phase zero and build till [last] phase… make it ready") · **Grounded in:** the seam map (workflow wf_b18ca7ab-420, 4 opus readers over the live code).

## Problem (Sukhdeep's vision vs. reality)

Traced his finished `webs` project: **one model** (`claude-cli`) did all 5 steps, isolated on the Projects page, no loops, skills matched globally (not per-role), 117 training records collected but **never trained on**, and no result link. His vision: the **primary AI he talks to** (Claude Code — decision/director) **delegates by role to different models** (Gemini plans, local model develops, primary decides); the project **lives in the Workspace with its own build/test loops**; each agent carries **its own skills**; the project's runs **feed learning** and skills **adapt**; and when done, a **link to check the result**. The building blocks exist as separate features — this feature **composes** them. Four phases, each independently shippable, built in order.

## Binding architectural invariant

**ADR-007: a model must never orchestrate models.** Deterministic Python controls rounds, roles, and budget (as `team.py` already does). "The primary orchestrates" = the primary is the **lead/decider role** (the voice Sukhdeep talks to and that synthesizes), NOT a controller of the loop. Every phase preserves the verify-before-trust spine (Tier-1 verify → Tier-2 judge → hooks → evidence → git commit) unchanged.

---

## Phase 0 — Result link (effort S)

When a project reaches `status: 'done'`, offer to open the built files.

- **Rust:** new `reveal_path(path: String)` command in `src-tauri/src/lib.rs` mirroring `open_url` (:1094): reject non-absolute paths, then `open -R <path>` (reveal-and-select in Finder). Register in `generate_handler!` (:1293). No capability change (matches `open_url`).
- **Client:** `revealPath(path)` in `src/lib/nativeEngine.ts` beside `openExternal` (isNative gate → `invoke('reveal_path', { path })`).
- **UI:** a `status === 'done'` block in `Projects.tsx` `ProjectView` with a **"Reveal folder"** button: `const dir = await expandUserPath(project.path); if (isUsableProjectDir(dir)) void revealPath(dir)` — reusing the driver's exact resolve+validate.
- **Honest limit (documented in copy):** reveals the **folder**, not a live site URL — we don't track an entry file. Label it "Reveal folder", not "Open site".

## Phase 1 — Role-based multi-model team on each project step (effort M) — the crown jewel

Today `project.run_project` dispatches every step through **one** gateway. Make each step run a **role board** (planner → developer → lead-synthesizer) on **different models**, then the existing verified pipeline gates the result.

- **Engine — extract the board core:** `team.py` already binds role→model→board (each `AgentSpec` gets its own `Gateway` via `SCPRISM_PRIMARY=spec.primary`; serial board; lead synthesizes). Extract that per-agent board loop (team.py:299-342) into a reusable helper `run_role_board(prompt, route, agents, gateway_factory, budget) -> str` that returns **one completion string carrying `===FILE:===` blocks** — the lead/implementer role is instructed with `project.py`'s FILE-block format (not team's 200-word prose cap).
- **Engine — the doer adapter:** wrap `run_role_board` in a `ModelCall`-shaped adapter `Callable[[prompt, route], ModelResult]` so it drops into `loop.run`'s injectable `model` seam (loop.py:178, dispatched at :476).
- **Engine — `run_project` gains `roster: Optional[List[AgentSpec]]`:** when present, pass `model=<team adapter>` to `loop.run`; when absent, today's single-doer path is **byte-identical**. Everything downstream (post_dispatch writes files, Tier-1 verify, Tier-2 judge, git_checkpoint, **one** Verdict) is untouched. **Do NOT** embed `run_team`'s own finalize/verdict — reuse the board *conversation*, keep `loop.run`'s single finalize (no double spans/tokens/verdicts).
- **Roles → models (default):** `lead:<primary>` (the decider Sukhdeep talks to — e.g. claude), `planner:gemini`, `developer:local`. If a provider isn't connected, that role falls back to the primary (honest, no crash). Sensitivity routing still force-locals per agent (documented — a "production" prompt can downgrade a cloud role to local by design).
- **Budget:** per-step token budget (roster multiplies calls); over-budget fails the step honestly via the existing budget machinery.
- **CLI + bridge + client:** `__main__.py _cmd_project` gains `--agents` (reuse `_cmd_team`'s parser); `run_engine_project` (lib.rs) forwards a roster env/arg; `runNativeProject` passes it; the Projects UI gets an optional **roster** (default shown: `lead:<primary>, planner:gemini, developer:local`), stored on the Project, editable before build. Absent roster = single-doer (unchanged).

## Phase 2 — Project as a live Workspace session with build + test loops (effort L)

Today the build loop exists (`runProject` — serial plan walk through the real engine, refine-on-fail, park-for-human) but projects are isolated on the Projects page and there's no test loop; the only schedule driver is page-locked in `Loop.tsx`.

- **Data join:** `Schedule` (schedules.ts) gains `projectId?: string` and `kind?: 'task' | 'build' | 'test'` (sanitize is already tolerant → back-compat). A project can own a build loop and a test loop.
- **App-level driver:** relocate the schedule tick into a new `AppStore.tsx` app-level effect modeled on the **manager driver** (:934) — runs regardless of page, 20-30s, serial via a shared busy-ref. Branch on `kind`: `build` → `runProject(projectId)` (existing); `test` → `runNativeProject` verify-only gated on `project.verifyCommand`; `task` → today's `runNativeTask`. Record via `recordRun` + `ADD_NOTICE`.
- **Serialization:** build + test loops + manager driver share the single engine via the busy-ref + `otherRunningProject` semantics (one project build at a time app-wide).
- **Active project in the Workspace:** add `activeProjectId` to `AppState` + an **"Open in Workspace"** action on `Projects.tsx` that sets it; the Workspace labels its header/console for that project; the Coworker Desk groups a project's loops under it in "Happening now" (filter schedules by projectId).
- **Honest guardrails:** do NOT route project loops through the sim `LoopState`/`runLoop` (deterministic-hash sim — would regress honesty); the durable real path is `runProject`. Test loop is **verify-only**, never enters the write/branch path (so it can't thrash git). App-wide ticks keep the `isNative()`/`primaryReal` refusal guards.

## Phase 3 — Per-role skills + turn learning on (effort L)

- **SKILLS per role:** `CatalogEntry` gains `roles: List[str]`; the skill-file frontmatter gains an optional `agents:`/`roles:` key (skills.py already generic-parses frontmatter). `disclose()`/the role board filter a skill to the active agent's role when `roles` is set; **no key = global** (byte-identical to today). Matches the per-agent `skills[]` / per-skill `agents[]` the client already stores but never sent to the engine.
- **LEARN — turn the flywheel on:** the training pipeline (`grpo.run_training_pipeline`) already works with **stdlib only** (RoutePolicy: local-vs-cloud route choice; group-relative advantages; golden lift-gate; promote/discard with rollback) — it's just not reachable from the app. Add a `run_engine_grpo` Tauri command (mirror `read_training_count`/`run_engine_dashboard`) that shells `python -m scprism_engine grpo --vault <v>` **defaulting to `--dry-run`** (so a click can't promote a policy past the golden gate), and a **"Run learning step"** button on Stats/Skills showing the lift result.
- **ADAPT:** extend the Skills `improve()` flow to also draw on the reward-scored training records for that intent (not just verdict pass/fail).
- **Honest limits (documented in copy):** "learn" here = **route selection** (which model to send a task to), not the local model retraining its own weights — real LLM fine-tune (`grpo_llm.py`) needs torch/GPU and stays parked. Copy says "improves routing", never "the model retrains itself." Records today are PASS-only, so note that lift needs reward variance within an intent bucket (a follow-up may record FAILs as negative reward).

## Testing (per phase)

- **Engine:** board-core helper (role→model board returns a FILE-block completion; budget cap; fallback when a role's provider is absent), `run_project` roster path (team adapter used; single verdict; golden hooks order unchanged; absent-roster byte-identical), role-scoped disclosure (roles filter; no-key = global), the GRPO command wiring (dry-run default). Offline fake models; existing suites stay green.
- **Client:** pure state — Schedule projectId/kind + the app-level driver branch logic (extract testable helpers), skillStats unaffected, roster serialization, reveal-path guard. Native-thin UI gated by tsc + suite.
- Every phase: `./verify.sh` PASS + relaunch, ledger line, honest-gap notes in the spec.

## Acceptance

A project built with a roster shows **different models per step** in its verdicts (`models_used` lists lead+planner+developer models, not one); it can be **opened in the Workspace** with a **build loop and a test loop** running under it (visible on the Desk); its skills disclose **by role**; a **"Run learning step"** reports a route-policy lift from the 117 records; and a finished project offers **"Reveal folder"**. The single-doer path and all existing flows remain byte-identical when no roster/loops/roles are used.
