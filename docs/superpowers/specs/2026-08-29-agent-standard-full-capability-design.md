# Agents to today's standard — portable definitions, real tools, full capability

**Status:** DRAFT for Sukhdeep's review · his directive 2026-08-29: "whatever skill and agents you are making, even manager agents, should follow today's standard of agent creation — not just a single file. Agents need tool calling, web search — all the stuff a cloud coworker holds. Full capability for skills and agents."

## What "today's standard" means, concretely

The convention the whole ecosystem converged on (Claude Code, Codex, Cursor, Gemini CLI): an agent is a **portable markdown definition with frontmatter** — name, description/charter, the tools it may call, the model it prefers — and a skill is a **folder** with a `SKILL.md` plus the resources it needs. Definitions live as files the user owns, readable by any runtime, versioned like everything else.

SC Prism is already halfway there and honest about it:
- Skills ARE portable `SKILL.md` files in the vault (roadmap #5) — the format other tools read.
- The engine already has every capability an agent needs: the bounded, gated tool-use loop; governed vault tools; the web provider; the MCP client; per-agent capability grants (`AgentGrants` / `AgentCapabilityGate`); role-scoped skill disclosure.
- What's missing is the STANDARD SHAPE: agents are localStorage rows (`name/role/model/skills[]`), seats on a board run prompt-only (no per-seat tool loop), and "skills" conflates procedures with capabilities.

## The design

### 1. Agents become vault files — `<vault>/agents/<slug>.md`

```markdown
---
name: researcher
description: gathers sources and cites them
model: claude            # brand preference; the roster gate still binds the real provider
tools: [vault, web]      # capability grants THIS agent asks for (ceiling: the user's own)
skills: [web-digest]     # SKILL.md procedures disclosed to this agent's turns
memory: [reports/, notes/]   # vault read scopes (team-host mode reuses this as its role filter)
---
The charter: what this coworker is for, in plain words. Travels into its turns.
```

- The agents STORE keeps working exactly as now (it becomes the index/cache); the file is the source of truth, same write-through pattern the skill library proved. System agents ship as seed files; editing in-app writes the file.
- Portable on purpose: the same file is meaningful to Claude Code as a subagent definition. Nothing SC Prism writes locks the user in.

### 2. Every seat runs the real tool loop

A board seat's contribution today is one prompt-only completion. Under the standard, each seat's turn runs the SAME bounded, gated tool loop the solo path has — with the TOOLS THAT SEAT's definition grants, gated by `AgentCapabilityGate` (already enforces per-agent grants engine-side; the ceiling is always the user's own grant — no escalation, unchanged).
- Researcher with `tools: [web]` actually searches the web mid-board and returns citations.
- Retrieval with `tools: [vault]` actually reads the vault instead of being pasted a listing.
- A seat with no tools declared runs exactly as today — byte-identical, opt-in per agent.
- Cost honesty: tool turns per seat ride the existing `--tool-turns` bound and the step's token envelope; the board's spend stays capped.

### 3. Skills grow up from single files to folders (compatible)

`<vault>/skills/<slug>/SKILL.md` + optional `references/`, `scripts/` — the folder shape every runtime now reads. A bare `<slug>.md` keeps working forever (the library loader tries the folder first, then the flat file). Disclosure, the tracker, and role-scoping are unchanged — they key on the SKILL.md.

### 4. Managers and the Companion are agents too

`reports/…` managers and the Companion get definition files with the same frontmatter (the Companion's charter already lives in the store — it moves into `agents/companion.md` with a migration, editable in place). A manager's `tools:` finally states on the record what its jobs may touch — today that fact lives in code.

## Order of work (each slice the full reviewed cycle)

1. **A — the file format + store write-through** (agents read/write `agents/*.md`, seeds migrate, Agents page edits the file) — no behavior change to runs.
2. **B — per-seat tool loop** (engine: seat contributions run the gated loop with the seat's grants; depends on the web-tools-in-project-steps chip landing for build steps).
3. **C — skills folders** (loader accepts both shapes).
4. **D — managers/companion on definitions** + the memory scopes field (which team-host mode then reuses as its role filter — the two specs interlock).

## Honesty rules carried over (non-negotiable)

- A tool an agent's file asks for but the user hasn't granted is refused with a reason at staffing time — never silently dropped, never silently escalated.
- Unmeasured claims stay unmade: an agent's file says what it MAY do; only spans say what it DID.
- Everything is a real file the user can open, diff, and delete.

## Slice D — concrete design (2026-08-29, day three)

**Companion:** `agents/companion.md`, same frontmatter as any agent
(`name`, `description`, `model`, `tools`, `skills`, `memory`) with the charter
as the body. Migration reuses the existing fingerprint rule in `managers.ts`:
a stored charter byte-equal to the shipped default migrates as the DEFAULT
(the file is written with the current default body and stays upgradeable);
anything else is the USER'S text and moves verbatim. The store keeps being the
runtime cache exactly like agents after slice A — file is source of truth,
write-through on edit, `syncVaultAgents`-style discovery on the Agents page.

**Managers:** one file per report manager under `agents/managers/<slug>.md`.
The `tools:` line finally states on record what a manager's jobs may touch
(today that fact lives in code); loader refuses a tool the user hasn't
granted, with a reason, at job-schedule time — never silently.

**Honesty rails carried over:** editing the file IS editing the companion
(no second copy drifting); a missing/corrupt file falls back to the store
cache with an app-voice notice, never a silent default swap; deletion of
`companion.md` is a reset-to-default, said out loud in the Companion page.

**Order:** (1) serialize/parse round-trip for the companion file,
(2) migration write-on-first-visit + discovery, (3) managers, (4) Companion
page edits write through. Each step the full reviewed cycle.
