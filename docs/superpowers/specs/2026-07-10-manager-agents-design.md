# Manager Agents — design

Approved by Sukhdeep 2026-07-10. Direction: maintenance janitors organized by
department (A structured like C); task-dispatch (B) deferred — the team runner
covers project work.

## Concept
A **manager** is a standing agent bound to ONE connected AI (`local`,
`claude-cli`, `gemini`, …). It owns **maintenance jobs** — recurring company
upkeep — each tagged to a department from the interview. Managers sit under
Sukh (the primary co-founder) and report to the user through the vault and
through Sukh's context.

## Data (src/lib/managers.ts — disk-persisted store, like settings)
- `Manager { id, providerId, name, enabled }` — one per connected AI; disabled
  by default.
- `Job { id, managerId, title, department, prompt, everyMinutes, lastRun,
  runs[{at, ok, summary}] }` — editable; capped run history.
- **Seeding** (first load, from real interview + settings; idempotent):
  - compliance regimes → "Compliance check" (best cloud manager)
  - vault hygiene → "Vault health (OKF)" (local manager)
  - new-notes summary → "Summarize new notes" (local manager — private)
  - weekly cost/drift review (cheapest cloud manager)

## Execution (ADR-007 clean)
A global deterministic driver in AppStore (app-wide, not page-bound) ticks
every 30s; due jobs run **serially**: one REAL engine run per job with
`SCPRISM_PRIMARY` = the manager's provider (model/effort from that provider's
settings). Full governance applies — sensitive words force local, Tier-1 gate,
hooks. A "sub-agent" = one engine run for one job. Model never orchestrates.

## Reporting
- Each run appends to `vault/reports/<manager>/<job-slug>.md` (read-append-
  write; file trimmed to keep the newest content under ~50KB).
- Agents page gains a **Managers panel**: manager toggle per AI, jobs with
  department tags, last-run status dot, next-due, add/delete job.
- Sukh rollup: the newest run summary per job rides into the Companion charter
  context ("Manager reports"), so "what did my managers find?" works in chat.

## Safety rails
Managers write only under `reports/`; serial execution; 240s cap per job run;
disabled until the user enables a manager; job history capped.

## Testing
- Vitest: store seeding (idempotent, interview-driven), due-job calculation,
  report-trim helper.
- Engine path reuses the proven run pipeline (no new engine surface).
