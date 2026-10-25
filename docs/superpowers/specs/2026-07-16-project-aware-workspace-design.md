# Project-aware Workspace + named agents + working-visibility — design

**Date:** 2026-07-16 · **Author:** Claude (from Sukhdeep's feedback: "things aren't connected… workspace doesn't understand my project… workspace + loops must be about the project… I want named agents and to see what's working"). **Forks he chose:** (1) ONE global Workspace that becomes **project-aware** (not a separate nested page); (2) **named agents you create** (name + model + skills), assignable to a project or the system, with visible activity.

## Problem

Today "Open in Workspace" only sets `activeProjectId` and shows a chip — the chat's context (`buildCompanionContext`, AppStore.tsx:466) injects skills + manager reports but **never the active project**, so the primary AI answers as a universal assistant with no idea it's on a project. The floating Companion orb (removed) read as disconnected. There's no way to see which agents/skills are actually working, and no way to create named agents.

## The model (his choice: global workspace, project-aware)

There is ONE Workspace. It has two modes, driven by `activeProjectId`:
- **No active project → coworker mode** (today): the primary AI is your general coworker managing memory + system.
- **A project is active → project mode:** the same Workspace becomes *that project's* workspace — the chat knows the project, the loops shown are its loops, the Happening-Now/agents are its agents. Switch or clear the active project from the Workspace header.

The primary AI is always the cross-project coworker (it manages memory + system); "project mode" just focuses its attention and context on one project.

---

## Slice 1 — Project-aware Workspace (build first; highest impact)

**1a. The chat actually knows the project.** `buildCompanionContext` gains the active project's context: when `activeProjectId` resolves to a project, prepend a block —
```
You are working on the project "<name>" (<status>).
Goal / brief: <project.goal / brief>
Plan: <the plan steps, if any>
Recent files: <last written files, if tracked>
Answer and act in the context of THIS project unless the user changes topic.
```
Read the active project from the projects store (same pattern as `listSkills()`/managers already read their stores inside `buildCompanionContext`). No active project → block omitted (byte-identical to today). This is the core fix — the AI stops being a universal Q&A and becomes the project's coworker.

**1b. A clear active-project switcher in the Workspace header.** Replace the passive chip with **"Working on: <project> ▾"** — a control that (i) lists projects to switch the active one, (ii) "Clear" returns to general coworker mode, (iii) links to the project's detail. When none active: "Coworker — no project focused · pick one". This makes "which project is going on" obvious everywhere.

**1c. Workspace surfaces reflect the active project.** The Coworker Desk's "Happening now" and the loop/agent panels, when a project is active, lead with that project (its loops, its live build/agent status) rather than a generic list. When none active, today's cross-project view.

**1d. Fresh project chat thread (optional, small).** When switching the active project, the chat can note the switch ("— now working on <project> —") so the transcript isn't confusingly mixing projects. (No separate per-project message store in slice 1; a divider line is enough.)

## Slice 2 — Named agents you create (build next)

**2a. A StoredAgent you define:** `{ id, name, provider (model), role, skills: string[], assignedTo: projectId | 'system', enabled }`. Create/edit/delete on the Agents page (which today shows only the auto system managers). Reuse `src/lib/agents.ts` if it already models this; else add it.

**2b. A project's agents = its assigned named agents.** When a project builds with a team, its roster is built from its assigned named agents (name:provider), unifying with Phase 1's roster (`--agents`). So "the agents building my project" are the ones you named. A project with no named agents falls back to the default role-team.

**2c. Assignment + skills.** Each named agent carries skills (role-scoped disclosure from the composed-project work already supports `roles:`). System agents (the managers) stay as the standing per-AI agents.

## Slice 3 — "Working or not" visibility (build with/after slice 2)

**3a. Live agent status** everywhere an agent appears: **idle / working: <task> / last: passed|failed <when>** — derived from the run/verdict history + in-flight run state. The role-team members during a build, the named agents, and the system managers all show it.

**3b. Skill "is it helping":** surface the existing tracker (uses · pass-rate · last-used) as a plain **working/underused** signal on each skill and where skills are listed for an agent/project — so you can see which skills are actually pulling weight.

---

## Cuts / honest scope

Slice 1 ships first (the connective tissue — the acute pain). Slices 2–3 are a larger new capability (an agent builder + activity model) and get their own reviewed build after slice 1 lands and you confirm slice 1 feels right. No separate per-project chat store in slice 1 (context + a divider; a full per-project transcript is a later option). The primary AI stays the cross-project coworker throughout — a project never "owns" memory or the system.

## Testing / acceptance

Slice 1: with a project active, the chat's engine context contains the project block (unit-testable via `buildCompanionContext`); the header shows "Working on: <project>" with switch/clear; no active project → context byte-identical to today. `verify.sh` PASS. Acceptance: open the webs project → ask the chat "what are we building?" → it answers about webs, not universally.
