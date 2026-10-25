// SC Prism — pure per-project "Live activity" projection.
//
// Turns a project + the agents store + the verdict history into ONE honest
// snapshot: who is on the build team right now (mirroring the exact roster
// resolution the build itself uses — see `agentsForProject`/`systemAgents`
// in agents.ts) and a newest-first feed of REAL events drawn only from real
// verdict data. Every function here is a pure, deterministic projection of
// its inputs — no store singletons, no React, no `Date.now` — mirrors the
// skillStats.ts/desk.ts aggregator style. NEVER fabricate a row: an event
// exists only when the data passed in says it happened.

import type { StoredAgent, AgentActivity } from './agents'
import { agentActivity, agentsForProject, systemAgents } from './agents'
import type { Verdict } from '../engine/types'
import type { Project } from './projects'
import { isAttention } from './verdictOutcome'

export interface ActivityItem {
  kind: 'run' | 'model' | 'skill' | 'created'
  label: string
  when: number // epoch ms for ordering; 0 when unknown
  ok?: boolean // for 'run' items — true ONLY for a recorded pass
  // For 'run' items: the engine recorded ATTENTION — the deterministic checks
  // ran over real written files and PASSED, the LLM reviewer dissented. `ok` is
  // false (it is not a pass), but the row must not read as a failure either.
  attention?: boolean
}

export interface ProjectActivity {
  team: { agent: StoredAgent; activity: AgentActivity }[]
  events: ActivityItem[] // newest-first
}

/** `verdict.at` (an ISO timestamp, native-only) parsed to epoch ms — 0 when
 * absent or unparseable, never NaN. */
function whenOf(verdict: Verdict): number {
  if (!verdict.at) return 0
  const t = Date.parse(verdict.at)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Honest per-project activity snapshot: the resolved build team (each paired
 * with its real `agentActivity`) + a newest-first feed of run/skill/created
 * events built ONLY from the project's own verdicts and its team's real
 * `createdAt` timestamps.
 */
export function projectActivity(
  project: Project,
  agents: readonly StoredAgent[],
  verdicts: readonly Verdict[],
  runningProjectId?: string,
): ProjectActivity {
  // Mirrors the build's own roster resolution (see ProjectAgentsPanel /
  // projectBuildRoster): assigned agents ARE the team when any exist,
  // otherwise the enabled system agents are the default team.
  const agentsArr = [...agents]
  const assigned = agentsForProject(agentsArr, project.id)
  const teamAgents = assigned.length ? assigned : systemAgents(agentsArr).filter((a) => a.enabled)
  const team = teamAgents.map((agent) => ({
    agent,
    activity: agentActivity(agent, verdicts, runningProjectId),
  }))

  // The project's own verdicts, in whatever order verdictIds carries them —
  // final ordering comes from the sort below, not this mapping. A dangling
  // id (no matching verdict in the store) is silently dropped — never a
  // fabricated row.
  const projectVerdicts = project.verdictIds
    .map((id) => verdicts.find((v) => v.taskId === id))
    .filter((v): v is Verdict => v !== undefined)

  const events: ActivityItem[] = []

  for (const v of projectVerdicts) {
    const modelsUsed = v.native?.models_used
    const suffix = modelsUsed && modelsUsed.length > 0 ? ` · ${modelsUsed.join(', ')}` : ''
    const attention = isAttention(v)
    events.push({
      kind: 'run',
      label: `run ${attention ? 'needs a look — checks passed, reviewer dissented' : v.passed ? 'passed' : 'failed'}${suffix}`,
      ok: v.passed,
      ...(attention ? { attention: true } : {}),
      when: whenOf(v),
    })
  }

  // Distinct disclosed skill names across the project's verdicts, each
  // timestamped by the NEWEST verdict that disclosed it (max `when`, not
  // array position — verdictIds is not guaranteed chronological).
  const skillWhen = new Map<string, number>()
  for (const v of projectVerdicts) {
    const w = whenOf(v)
    for (const name of v.native?.disclosed ?? []) {
      const prev = skillWhen.get(name)
      if (prev === undefined || w > prev) skillWhen.set(name, w)
    }
  }
  for (const [name, when] of skillWhen) {
    events.push({ kind: 'skill', label: `skill used: ${name}`, when })
  }

  // One "created" event per team agent that actually has a createdAt — absent
  // on system/legacy agents, so they simply contribute no row (never a
  // fabricated one).
  for (const { agent } of team) {
    if (agent.createdAt) {
      events.push({ kind: 'created', label: `created agent: ${agent.name}`, when: agent.createdAt })
    }
  }

  // Newest-first; Array#sort is stable (ES2019+), so same-`when` items keep
  // their insertion order above (runs, then skills, then created).
  events.sort((a, b) => b.when - a.when)

  return { team, events }
}
