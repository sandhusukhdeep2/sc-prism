import { describe, expect, it } from 'vitest'
import { jobForTwo, jobTwoNames, seatInfoFrom, stepForTwo, stepTeam } from './stepTeam'
import type { Capability } from './delegation'

// Seen in the installed app on 2026-11-15: "Add a fourth line to hello.md"
// typed in a project's room took fifteen minutes and 32 model calls. The
// Manager's room already knows one piece of work is a job for two seats
// (lib/messageWeight.ts, lib/workload.ts jobRoster); a project's room sent
// every job to the whole five-seat build team.

// The default build team, as the app seats it: built-in agents, each with a
// grant of its own, so `buildWriter` asks the doer for `writes` and leads with it.
const TEAM =
  'planner:claude-cli,implementer:local,reviewer-verifier:claude-cli,researcher:local,retrieval:local'
const builtIn = () => ({ capabilities: ['vault'] as Capability[], builtIn: true })

const project = (plan: string[], jobsFrom?: number) => ({ plan, ...(jobsFrom === undefined ? {} : { jobsFrom }) })

describe('jobForTwo — the same rule, on words not yet sent', () => {
  it('one piece of work is; several parts or a call for everyone is not', () => {
    expect(jobForTwo('Add a fourth line to hello.md')).toBe(true)
    expect(jobForTwo('Add a footer with the whole team')).toBe(false)
    expect(jobForTwo('- add a footer\n- add a changelog')).toBe(false)
  })
})

describe('stepForTwo — which steps are one piece of work typed in the room', () => {
  it('a job typed in the room that is one piece of work', () => {
    expect(stepForTwo(project(['Write hello.md', 'Add a fourth line to hello.md'], 1), 1)).toBe(true)
  })

  it('never a step of the plan — the plan was approved with its team', () => {
    expect(stepForTwo(project(['Write hello.md', 'Add a fourth line to hello.md'], 1), 0)).toBe(false)
    expect(stepForTwo(project(['Add a fourth line to hello.md']), 0)).toBe(false)
  })

  it('not a job that asks for more than one pair of eyes, or comes in several parts', () => {
    expect(stepForTwo(project(['Rewrite hello.md with the whole team'], 0), 0)).toBe(false)
    expect(stepForTwo(project(['Review hello.md and tighten it'], 0), 0)).toBe(false)
    expect(stepForTwo(project(['- add a footer\n- add a changelog\n- link them'], 0), 0)).toBe(false)
  })
})

describe('stepTeam — the seats a step is sent to', () => {
  const ask = (over: Partial<Parameters<typeof stepTeam>[0]> = {}) =>
    stepTeam({
      roster: TEAM,
      seatInfo: builtIn,
      primaryToken: 'claude-cli',
      defaultTeam: true,
      forTwo: true,
      ...over,
    })

  it('one piece of work on the default team: the doer, and the planner on the primary', () => {
    const team = ask()
    expect(team.ok).toBe(true)
    if (!team.ok) return
    expect(team.roster).toBe('implementer:local,planner:claude-cli')
    expect(team.cut).toBe(true)
    // The seat that writes still leads, and is still the one asked for writes.
    expect(team.writer).toBe('implementer')
    expect(team.seats[0].capabilities).toContain('writes')
  })

  it('a bigger job gets the whole team, the writer first', () => {
    const team = ask({ forTwo: false })
    expect(team.ok && team.roster).toBe(
      'implementer:local,planner:claude-cli,reviewer-verifier:claude-cli,researcher:local,retrieval:local',
    )
    expect(team.ok && team.cut).toBe(false)
  })

  it('a team the user chose for this project is never cut — their choice stands', () => {
    const team = ask({ defaultTeam: false })
    expect(team.ok && team.roster.split(',').length).toBe(5)
    expect(team.ok && team.cut).toBe(false)
  })

  it('a team of two is sent as it is', () => {
    const team = ask({ roster: 'planner:claude-cli,implementer:local' })
    expect(team.ok && team.roster).toBe('implementer:local,planner:claude-cli')
    expect(team.ok && team.cut).toBe(false)
  })

  it('with no primary on the team the second seat is still the one that plans', () => {
    const team = ask({ roster: 'planner:local,implementer:local,reviewer-verifier:local', primaryToken: 'claude-cli' })
    expect(team.ok && team.roster).toBe('implementer:local,planner:local')
  })

  // THE CUT NEVER MOVES A GRANT. Who may write is settled once, for the whole
  // team (`buildWriter`). Settling it again on two seats could hand `writes`
  // to a seat the team's own settlement did not give it to: here the user
  // gave Writes to the Reviewer, so on the whole team the Reviewer writes and
  // the Implementer does not — and a cut of "Implementer + Planner", settled
  // afresh, would have asked the Implementer for it.
  describe('a cut carries the team’s own settlement', () => {
    const reviewerWrites = (role: string) => ({
      capabilities: (role === 'reviewer-verifier' ? ['writes', 'vault'] : ['vault']) as Capability[],
      builtIn: true,
    })

    it('the seat that writes for the team is the seat that writes for the cut', () => {
      const whole = ask({ seatInfo: reviewerWrites, forTwo: false })
      const team = ask({ seatInfo: reviewerWrites })
      expect(whole.ok && whole.writer).toBe('reviewer-verifier')
      expect(team.ok && team.writer).toBe('reviewer-verifier')
      expect(team.ok && team.roster).toBe('reviewer-verifier:claude-cli,implementer:local')
      expect(team.ok && team.cut).toBe(true)
    })

    it('no seat of the cut holds anything it did not hold on the team', () => {
      const whole = ask({ seatInfo: reviewerWrites, forTwo: false })
      const team = ask({ seatInfo: reviewerWrites })
      if (!whole.ok || !team.ok) throw new Error('expected both to be settled')
      for (const seat of team.seats) {
        const before = whole.seats.find((s) => s.name === seat.name)
        expect(before, seat.name).toBeDefined()
        expect(seat.capabilities).toEqual(before!.capabilities)
      }
      // The Implementer was not given Writes by the team's settlement.
      expect(team.seats.find((s) => s.name === 'implementer')!.capabilities).not.toContain('writes')
    })

    it('a gated team is never cut into an ungated one', () => {
      // One seat with a grant gates the whole team; the cut keeps the writer,
      // and the writer of a gated team always holds `writes`.
      const onlyResearcher = (role: string) => ({
        capabilities: (role === 'researcher' ? ['web'] : []) as Capability[],
        builtIn: true,
      })
      const team = ask({ seatInfo: onlyResearcher })
      if (!team.ok) throw new Error('expected a settled team')
      expect(team.cut).toBe(true)
      expect(team.seats.some((s) => s.capabilities.length > 0)).toBe(true)
      expect(team.seats[0].capabilities).toContain('writes')
    })
  })

  it('a team nobody may write on is refused whole — never cut into a different refusal', () => {
    const staffed = () => ({ capabilities: ['vault'] as Capability[], builtIn: false })
    const team = ask({ seatInfo: staffed })
    expect(team.ok).toBe(false)
  })
})

// The library decides two things about a seat: what it may do, and what it is
// called. Both readings live here so the line before the send, the notice
// after it and the run itself cannot disagree.
const LIBRARY = [
  { name: 'Planner', system: true, tools: ['vault'] },
  { name: 'Implementer', system: true, tools: ['vault'] },
  { name: 'Reviewer / Verifier', system: true, tools: ['vault'] },
  { name: 'Researcher', system: true, tools: ['web'] },
  { name: 'Retrieval', system: true, tools: ['vault'] },
]

describe('seatInfoFrom — a seat\'s grants, read from the library', () => {
  it('finds a seat by its roster slug, and says whether it is built in', () => {
    const info = seatInfoFrom(LIBRARY)
    expect(info('reviewer-verifier')).toEqual({ capabilities: ['vault'], builtIn: true })
    expect(info('researcher').capabilities).toEqual(['web'])
  })

  it('a seat nobody in the library answers to holds nothing', () => {
    expect(seatInfoFrom(LIBRARY)('ghost')).toEqual({ capabilities: [], builtIn: false })
  })
})

describe('jobTwoNames — who a job typed in the room would go to', () => {
  const ask = (text: string, over: Partial<Parameters<typeof jobTwoNames>[0]> = {}) =>
    jobTwoNames({ roster: TEAM, agents: LIBRARY, primaryToken: 'claude-cli', defaultTeam: true, text, ...over })

  it('names the two seats as the library names them', () => {
    expect(ask('Add a fourth line to hello.md')).toBe('Implementer + Planner')
  })

  it('is empty when the whole team takes it', () => {
    expect(ask('Rewrite hello.md with the whole team')).toBe('')
    expect(ask('Add a fourth line to hello.md', { defaultTeam: false })).toBe('')
    expect(ask('Add a fourth line to hello.md', { roster: 'planner:claude-cli,implementer:local' })).toBe('')
  })
})
