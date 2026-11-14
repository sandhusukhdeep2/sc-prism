// WHO TAKES A STEP OF A PROJECT BUILD (2026-11-15).
//
// The Manager's room has three levels (lib/messageWeight.ts): talk — one AI;
// a job — two seats; a big job — every seat. A project's room had one: every
// job typed there went to the whole build team. Seen in the installed app:
// "Add a fourth line to hello.md" took fifteen minutes and 32 model calls on
// five seats.
//
// So a job typed in a project's room is sized by the same rule. One piece of
// work goes to two seats — the one that writes, and one other (`stepTeam`
// says which; on the default team: the Implementer and the Planner). Work in
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
import { seatKind, type SeatKind } from './workload'

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
 * WHO MAY DO WHAT IS SETTLED ONCE, FOR THE WHOLE TEAM. A cut is two of the
 * seats that settlement produced, each holding exactly what it held there:
 * the seat that writes for the team, and one other. It is never settled
 * again on the two — that could hand `writes` to a seat the team's own
 * settlement did not give it to, or turn a gated team into an ungated pair.
 *
 * The other seat: beside a writer that does the work, the one that plans (on
 * the primary when the primary is on the team, then the one that checks);
 * beside a writer that plans or checks, the seat that does the work.
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
  const seats = splitRoster(whole.roster)
  if (!input.defaultTeam || !input.forTwo || seats.length <= 2) return { ...whole, cut: false }

  const [writer, ...others] = seats
  const first = (kind: SeatKind, onPrimary = false) =>
    others.find(
      (s) =>
        seatKind(s.role) === kind &&
        (!onPrimary || (!!input.primaryToken && s.token === input.primaryToken)),
    )
  const second =
    seatKind(writer.role) === 'do'
      ? (first('plan', true) ?? first('check', true) ?? first('plan') ?? first('check') ?? others[0])
      : (first('do') ?? others[0])
  const kept = [writer, second]
  return {
    ok: true,
    roster: kept.map((s) => `${s.role}:${s.token}`).join(','),
    writer: whole.writer,
    // The team's own settlement, seat for seat — never recomputed.
    seats: kept.map((s) => whole.seats.find((w) => w.name === s.role) ?? { name: s.role, capabilities: [] }),
    cut: true,
  }
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
