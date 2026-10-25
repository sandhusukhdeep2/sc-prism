# Project Workspace v2 — existing repos — design

**Date:** 2026-07-13 · **Status:** approved scope (Sukhdeep: branch-per-run safety; full interview for both modes) · **Builds on:** 2026-07-12-project-workspace-design.md (v1, shipped)

## Problem

v1 builds fresh projects only. The biggest capability jump is pointing SC Prism at repos the user already has (an existing app repo, or sc-prism itself) — which demands real-code safety rails and closes v1's documented never-touch gap.

## Scope (v2)

1. **Attach existing folder.** Projects page gains "Attach existing" beside New Project: absolute path to a folder that exists. `Project` gains `mode: 'new' | 'existing'` (sanitize default: 'new'), `baseBranch: string`, `runBranch: string` (both '' until a run). Attached projects run the SAME full interview (user's choice) — the grill happens before any plan, identical flow to v1.
2. **Branch-per-run safety (existing mode only).** Before step 1 of a run, the engine: refuses if the working tree is dirty (honest failure: "commit or stash your changes first — SC Prism won't tangle its work into yours"); records the current branch as `base`; creates/checks out `scprism/<slug>-<n>` from HEAD. All v1 checkpoints land on that branch. When the run finishes (done OR attention), any leftover uncommitted changes are committed as `scprism: wip (run ended mid-step)`, and the repo is checked out back to `base`. The user's branch is NEVER written to. New-mode projects keep v1 behavior exactly (no branching).
3. **Merge affordance.** For an existing-mode project with a completed run branch, the project view shows "«runBranch» ready — Merge into «base»" → engine merges (fast-forward when possible, else a regular merge commit); a conflict aborts cleanly (`git merge --abort`) and surfaces an honest notice ("merge conflict — resolve manually in your editor"). Never force, never rebase.

**Interrupted-run rule:** if the app was killed mid-run, the repo may be left checked out on a `scprism/…` branch. On the next Start, if the current branch already matches `scprism/<slug>-*`, the engine RESUMES on that branch (no new branch, dirty-tree leftovers get the wip commit first) instead of branching from it.
4. **Never-touch plumbing (closes the v1 gap).** The client reads the user's never-touch list from the interview/governance state and passes it through `runNativeProject` → Rust `--never-touch` (repeatable) → the engine's existing enforcement. **Amended at review (2026-07-13): applies to EXISTING mode only** — enforcing the business's protection list (e.g. `billing/**`) inside a fresh sandbox project's own layout is a category error and bricks legitimate new-project writes; new-mode projects pass an empty list. The v1 spec's "honest gap" note gets updated accordingly.
5. **Repo awareness.** For existing mode, the engine prepends a bounded repo outline to each step prompt (top-level tree ~100 entries + README first ~80 lines, hard cap ~4k chars) so the model knows what already exists before proposing files. Marked clearly as context, never echoed into file blocks (the instruction-echo filter already guards the template; the outline contains no `===FILE:` markers because any such lines are stripped from the outline text).
6. **Overwrite honesty.** In existing mode, a step's Verdict `extras.project` additionally reports `overwrote: [paths]` (files that existed before the write) so the report and UI can say "changed 3 existing files" — git history remains the undo.

## Engine changes (project.py + CLI + git helpers)

- `run_project` gains keyword `existing_mode: bool = False`, `never_touch` already exists. New pure-ish helpers (all subprocess-git, never raise; return (ok, detail)): `git_is_dirty(dir)`, `git_current_branch(dir)`, `git_checkout_new_branch(dir, name)`, `git_checkout(dir, name)`, `git_merge_branch(dir, branch)` (with auto-abort on conflict).
- CLI: `project` gains `--existing` flag; new `project-merge` subcommand: `python -m scprism_engine project-merge --project-dir DIR --branch NAME` → one JSON result `{merged: bool, reason}`.
- Branch naming: `scprism/<slug>-<n>` where n increments per run (derived from existing branch list; no timestamps needed).
- Dirty-tree refusal and branch operations happen INSIDE run_project before the loop, so the CLI/headless path gets identical safety.

## Bridge + client

- Rust: `run_engine_project` gains `existing_mode: bool` + `never_touch: Vec<String>` (repeatable argv); new `run_engine_project_merge` command. TS: `runNativeProject` opts gain `existingMode`, `neverTouch: string[]`; new `runNativeProjectMerge(projectDir, branch)`.
- Client store: `mode`/`baseBranch`/`runBranch` fields + sanitize; attach form (path validation = absolute path; existence check happens engine-side at first run, refusal is honest).
- Driver: passes `existingMode` + the never-touch list (source: the interview state's never-touch answers — the implementer locates the exact field; if the interview stores it only as prose, derive globs conservatively: exact paths/dirs the user listed, one glob per line, and record the mapping in the run's context). After a run finishes in existing mode, driver stores `runBranch`/`baseBranch` from the verdict extras (engine reports them) and the merge button dispatches the merge call; merge success → notice + `runBranch: ''`.
- UI: attach form; mode badge on cards; branch line + Merge button in the project view; overwrote-count in step notes. The cinematic stage is unchanged (same driver events).

## Cuts (v2)

No multi-repo projects; no PR creation/GitHub integration; no partial staging or per-file approval; no rebase/force operations ever; no repo browsing UI (the user has an editor); interview repo-QA beyond the bounded outline.

## Testing

- Engine: git helpers against real temp repos (init, dirty detection, branch create/checkout/merge, conflict abort); existing-mode run refuses dirty tree; run lands commits on the run branch and returns to base; merge subcommand happy + conflict paths; outline builder respects caps and strips `===FILE:` lines; `overwrote` reporting.
- Client: store sanitize back-compat (v1 projects → mode 'new'); driver pure helpers for the new fields; never-touch list derivation unit-tested.
- Boundary: unchanged (already hardened); never-touch now exercised end-to-end in an engine test with a real glob via the CLI flag.

## Acceptance

Attach sc-prism itself (or a scratch clone) → interview → plan → Start with a dirty tree → honest refusal → commit/stash → Start → run lands on `scprism/<slug>-1`, original branch untouched and checked out again after the run → Merge button integrates the branch (or conflicts abort honestly) → never-touch glob (e.g. `docs/**`) verifiably rejects a write in the verdict's `rejected` list. v1 new-project flow byte-identical. `verify.sh` PASS.
