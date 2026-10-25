# Project Workspace v1 — design

**Date:** 2026-07-12 · **Status:** approved (Sukhdeep: interview+loop flow, FULL cinematic run experience in v1, orb-only notifications) · **Supersedes:** the vault-only write boundary for project work.

## Problem

SC Prism can only write to the vault. "Build my portfolio website" produces verified *notes*, not a website. This feature gives the app a real write surface: it creates and builds actual projects — folders with code files — under the same verify-before-trust governance, and makes the run feel like a coworker doing visible work, not a spinner.

## The experience (v1, end to end)

1. **Projects page** (new top-nav entry). **New Project**: name + goal in plain words + optional verify command. The project's folder is `~/SC Projects/<slug>/` (path shown, overridable); it **materializes on Start build** — the engine creates it, runs `git init`, and the plan's first step writes `PROJECT.md` (goal + stack). Keeping folder creation engine-side avoids granting the webview any new filesystem capability. Project cards show name, status, last activity; clicking opens the project view.
2. **The grill.** Before any work, the project's AI interviews the user in a chat (3–5 clarifying questions, one at a time — audience, style, content, constraints). Powered by the same real-chat plumbing as the setup interview. It ends by proposing a **brief + step plan** the user can read (plain sentences, e.g. "1. Scaffold the page skeleton · 2. Hero + about section · 3. Project cards · 4. Styling pass · 5. Final check"). User taps **Start build** (may edit the goal/plan text first).
3. **The cinematic run.** On Start: the floating companion orb becomes the stage — **agent orbs animate out of it** (scale/translate from the orb's position, one per active step-agent, shrinking to a working row), a **glowing progress indicator** fills per completed step, and a **command-line narration strip** at the bottom streams one-line updates ("writing index.html", "Tier-1: build passed", "refining styles — pass 2"). All animation respects `prefers-reduced-motion` (static states instead). When the run needs the user (yes/no), a **request overlay** anchors on the orb with the question + two buttons; the run parks until answered. V1's concrete trigger: refine passes exhausted with verification still failing → "Try one more refine pass?" (Yes = one extra pass; No = project lands in `needs attention`).
4. **The loop.** Steps run serially through the engine's new project mode. Each step: model returns structured file operations → paths validated against the project boundary → files written → project Tier-1 (the verify command, run in the project dir) → Tier-2 judge → **Verdict** → `git add -A && git commit` checkpoint on pass. After all steps, a final verify pass; on failure the loop runs **refine passes (max 2)** feeding the failure output back to the model; then the project lands in `done` or `needs attention`.
5. **The observer.** If the user navigates elsewhere mid-run, the floating orb carries a badge and speaks up on completion or when input is needed ("portfolio-site is done — check it" / "portfolio-site needs a yes/no"). Clicking navigates to the project. In-app only (no macOS notifications — cut).
6. **Multi-model stays the star:** each step routes through the existing gateway (sensitivity-aware; the project uses the user's primary by default), so local + cloud models share one build.

## Engine: project mode (Python — the core new capability)

New CLI subcommand: `python -m scprism_engine project "<step intent>" --project-dir <dir> --vault <vault> [--tier1 "<cmd>"] [--context "<brief>"] [--refine-feedback "<tier1 output>"]`.

- **File-operations format** (forgiving for small local models): the model is instructed to emit one or more blocks
  `===FILE: relative/path.ext===\n<full file content>\n===END===`
  The parser extracts every block; anything outside blocks is narration. A completion with zero blocks fails the step with a clear reason (no silent no-op).
- **Boundary enforcement (deny-by-default):** every path is normalized and must resolve strictly inside `--project-dir`; `..`, absolute paths, symlink escapes, and writes under `.git/` are rejected with reasons (reuse the `permissions.check` reason pattern). Never-touch globs from the governance bundle apply. v1 is **write/overwrite only** — no deletes or renames by the model (git history is the undo).
- **Verification:** Tier-1 = the project's verify command run with `cwd = project dir` (skipped if none configured, recorded as skipped); Tier-2 judge scores the step against the brief; hash-chained evidence + training record as with any task; Verdict JSON includes `files_written: string[]`.
- **Git checkpoints:** engine runs `git init` if absent, and after a PASSING step `git add -A && git commit -m "scprism: <step intent (truncated)>"`. Git absent → step still passes, checkpoint recorded as skipped with a reason.

## Rust bridge

New command `run_engine_project` in `src-tauri/src/lib.rs`, mirroring `run_engine_task` (same provider env-var passing, bundled-Python resolution) plus `projectDir`, `context`, `refineFeedback` args; returns the Verdict JSON string.

## Client

- **`src/lib/projects.ts`** — singleton store (managers.ts pattern; localStorage `scprism.projects` + disk store key `projects`): `Project { id, name, slug, path, goal, verifyCommand, createdAt, status: 'new'|'interviewing'|'planned'|'running'|'awaiting'|'done'|'attention', brief, plan: string[], stepIndex, refinePass, transcript, verdictIds }`. Pure helpers exported for tests.
- **Run driver** — in `AppStore` (so runs survive page navigation): serial, one project run at a time, per-step `runNativeProject(...)` with a 300s per-step race; consults an exported pure `nextProjectAction(project)` state machine; parks on user requests. Interview + plan drafting use the existing chat plumbing with a structured `===PLAN===` block parsed deterministically.
- **Projects page + project view** (`src/pages/Projects.tsx`) — cards/new form; project view hosts the interview chat, the plan, the run stage, and the verdict list. Route + top-nav entry added to `src/lib/nav.ts`.
- **Run stage (cinematic)** — `src/components/ProjectRunStage.tsx`: orb-anchored agent spawn animation (CSS keyframes, GPU-friendly transform/opacity only), step progress glow, narration strip (EngineConsole aesthetic), request overlay with the yes/no buttons. Reduced-motion: static badges + plain progress bar.
- **Orb notifications** — the Companion store gains a small notice queue `{ id, projectId, text, kind: 'done'|'attention'|'request' }`; the orb badges + shows the latest; click navigates to the project. Notices raised by the run driver only.

## Honest v1 gap (documented at ship, 2026-07-13)

The engine's `--never-touch` globs are fully implemented and tested, but the app does not yet pass any: the governance-bundle → never-touch plumbing is deferred, so v1 project runs enforce the directory boundary (+ `.git` block) only. Exposure is low — projects are fresh engine-created folders and existing-repo editing is cut — but this is a known gap, not a silent one. Wire the bundle's never-touch list into `runNativeProject` when existing-repo support (v2) lands, or earlier.

**Closed in v2 (2026-07-13):** the driver now passes `neverTouchGlobs(interview.neverTouch)` through the bridge on every EXISTING-repo run. Deliberately NOT applied to new-mode projects (review adjudication): the business's protection list (e.g. `billing/**`) describes the user's real systems, and enforcing it inside a fresh sandbox project's own folder layout misfires — a new project's `billing/` module is unrelated to the company's billing.

## Deliberate cuts (v1)

Editing existing repos; model-driven deletes/renames; in-app code editor for project files; dev-server preview/deploy; multi-project concurrent runs; macOS notifications; the universal skill tracker/promotion loop (own roadmap item); team/host mode (design keeps the seam: nothing here assumes an embedded-only gateway).

## Testing

- Engine (unittest, stdlib): file-block parser (multi-block, no-block failure, nested fences); boundary enforcement (traversal, absolute, `.git/`, symlink escape, never-touch) — each rejection carries a reason; tier1 cwd; git checkpoint on pass only; refine-feedback plumbed into the prompt; Verdict includes `files_written`.
- Client (Vitest): projects store CRUD + persistence + sanitize back-compat; `nextProjectAction` state machine; plan-block parser; notice queue logic. Native-only surfaces (run driver wiring, Rust command, cinematic stage) are covered by tsc + the manual acceptance walk — same boundary as prior features.
- Rust: `cargo build` green (command registration).

## Acceptance

Create "portfolio-site" with goal + `python3 -m http.server` off / no verify command → interview asks 3–5 questions → plan appears → Start build → agent orbs animate out, progress glows, narration streams → real files land in `~/SC Projects/portfolio-site` with one git commit per passing step → final Verdicts visible → orb announces "done" from another page → `open index.html` shows the site. A refine pass triggers when Tier-1 fails. `verify.sh` PASS throughout.
