// WHO TAKES A STEP OF A PROJECT BUILD (2026-11-15).
//
// The Manager's room has three levels (lib/messageWeight.ts): talk — one AI;
// a job — two seats; a big job — every seat. A project's room had one: every
// job typed there went to the whole build team. Seen in the installed app:
// "Add a fourth line to hello.md" took fifteen minutes and 32 model calls on
// five seats.
//
// So a job typed in a project's room is sized by the same rule. One piece of
// work goes to two seats — the one that does the work, and the one that plans
// (on the primary when the primary is on the team: `jobRoster`). Work in
// several parts, a long brief, or a job that asks for more than one pair of
// eyes ("review…", "…with the whole team") gets every seat.
//
// What is NOT sized:
//   * a step of the PLAN — the plan was approved with its team;
//   * a team the user chose for this project (its own agents, or a roster
//     typed by hand) — a rule does not overrule an explicit choice.
//
// A rule, shown before the send, never a model's choice. Pure.

import { agentNameKey, agentSlug } from './agents'
import { buildWriter, type BuildWriter } from './buildWriter'
import { agentCapabilityNames, type Capability } from './delegation'
import { messageLevel } from './messageWeight'
import type { Project } from './projects'
import { splitRoster } from './roster'
import { jobRoster } from './workload'

/** These words are one piece of work — not several parts, not a call for everyone. */
export function jobForTwo(text: string): boolean {
  return messageLevel(text).level !== 'big'
}

/** Step `index` is a job typed in the room, and it is one piece of work. */
export function stepForTwo(project: Pick<Project, 'plan' | 'jobsFrom'>, index: number): boolean {
  if (project.jobsFrom === undefined || index < project.jobsFrom) return false
  return jobForTwo(project.plan[index] ?? '')
}

export type StepTeam =
  | (Extract<BuildWriter, { ok: true }> & {
      /** Fewer seats than the build team: this step is a job for two. */
      cut: boolean
    })
  | Extract<BuildWriter, { ok: false }>

/**
 * The seats a step is sent to, the writer first (`buildWriter`).
 *
 * The WHOLE team is settled first, so a team nobody may write on is refused
 * for the reason that is true of the team, not of a cut of it. A cut that
 * could not write (or is no smaller) falls back to the whole team.
 */
export function stepTeam(input: {
  /** The build team in its own order, after the staffing and provider gates. */
  roster: string
  seatInfo: (role: string) => { capabilities: readonly Capability[]; builtIn: boolean }
  /** The primary's provider token: the second seat of a job for two. */
  primaryToken: string
  /** The team is the default one — not this project's own agents or a typed roster. */
  defaultTeam: boolean
  /** The step is one piece of work typed in the room (`stepForTwo`). */
  forTwo: boolean
}): StepTeam {
  const whole = buildWriter(input.roster, input.seatInfo)
  if (!whole.ok) return whole
  if (!input.defaultTeam || !input.forTwo) return { ...whole, cut: false }
  const two = buildWriter(jobRoster(input.roster, input.primaryToken), input.seatInfo)
  if (!two.ok || splitRoster(two.roster).length >= splitRoster(whole.roster).length) {
    return { ...whole, cut: false }
  }
  return { ...two, cut: true }
}

/** What the library has to say about a seat: the fields read here, no more. */
export interface LibraryAgent {
  name: string
  system?: boolean
  tools?: readonly string[]
  skills?: readonly string[]
}

function agentFor(agents: readonly LibraryAgent[], role: string): LibraryAgent | undefined {
  // A roster names a seat by its SLUG ("reviewer-verifier"); matching on the
  // name key alone missed "Reviewer / Verifier", which then went into the
  // grant table holding nothing.
  return agents.find(
    (a) => agentSlug(a.name) === agentSlug(role) || agentNameKey(a.name) === agentNameKey(role),
  )
}

/** A seat's grants, and whether it is a built-in agent — `buildWriter`'s question. */
export function seatInfoFrom(
  agents: readonly LibraryAgent[],
): (role: string) => { capabilities: Capability[]; builtIn: boolean } {
  return (role) => {
    const agent = agentFor(agents, role)
    return { capabilities: agentCapabilityNames(agent), builtIn: !!agent?.system }
  }
}

/**
 * The two seats a job typed in a project's room would go to, by the names the
 * library gives them ("Implementer + Planner") — '' when the whole team takes
 * it. Said before the send and in the room's notice after it.
 */
export function jobTwoNames(input: {
  /** The build team as asked (`projectBuildRoster`). */
  roster: string
  agents: readonly LibraryAgent[]
  primaryToken: string
  defaultTeam: boolean
  text: string
}): string {
  const team = stepTeam({
    roster: input.roster,
    seatInfo: seatInfoFrom(input.agents),
    primaryToken: input.primaryToken,
    defaultTeam: input.defaultTeam,
    forTwo: jobForTwo(input.text),
  })
  if (!team.ok || !team.cut) return ''
  return splitRoster(team.roster)
    .map(({ role }) => agentFor(input.agents, role)?.name ?? role.charAt(0).toUpperCase() + role.slice(1))
    .join(' + ')
}
