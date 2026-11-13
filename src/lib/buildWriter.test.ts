// WHO WRITES THE FILES OF A PROJECT BUILD.
//
// Found by driving the real app, 2026-11-14: a job sent to a project's folder
// ran its board three times over ten minutes and changed nothing — "all file
// writes rejected: planner was not granted the 'writes' capability".
//
// The engine lets ONE seat write: the board's lead, the first seat of the
// roster, which synthesizes the FILE blocks. Since the built-in agents were
// given their own grants (vault, web — 2026-11-09), every build on the default
// team sent a grant table in which no seat held `writes`, with the Planner in
// front. Nothing on that team could write, and nobody was told until the run
// had been paid for.
import { describe, expect, it } from 'vitest'
import { buildWriter } from './buildWriter'
import type { Capability } from './delegation'

type Info = { capabilities: Capability[]; builtIn: boolean }
const team =
  (seats: Record<string, Info>) =>
  (role: string): Info =>
    seats[role] ?? { capabilities: [], builtIn: false }

describe('buildWriter', () => {
  it('a team with no grants at all is left exactly as it was', () => {
    const r = buildWriter('lead:claude,developer:local', team({}))
    expect(r).toEqual({ ok: true, roster: 'lead:claude,developer:local', writer: 'lead', seats: [
      { name: 'lead', capabilities: [] },
      { name: 'developer', capabilities: [] },
    ] })
  })

  it('the seat that holds writes leads the build — it is the one that writes', () => {
    const r = buildWriter(
      'planner:claude,developer:local,critic:gemini',
      team({
        planner: { capabilities: ['vault'], builtIn: false },
        developer: { capabilities: ['vault', 'writes'], builtIn: false },
        critic: { capabilities: ['vault'], builtIn: false },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.writer).toBe('developer')
    // Moved to the front; the others keep their order behind it.
    expect(r.roster).toBe('developer:local,planner:claude,critic:gemini')
    expect(r.seats.map((s) => s.name)).toEqual(['developer', 'planner', 'critic'])
  })

  it('a writer already in front changes nothing', () => {
    const r = buildWriter(
      'lead:claude,planner:claude',
      team({ lead: { capabilities: ['writes'], builtIn: false }, planner: { capabilities: ['vault'], builtIn: false } }),
    )
    expect(r.ok && r.roster).toBe('lead:claude,planner:claude')
  })

  it('the built-in team: the seat that does the work is asked for writes, and leads', () => {
    // Exactly the roster of the failed run: planner first, no seat with writes.
    const r = buildWriter(
      'planner:claude,implementer:local,reviewer-verifier:claude',
      team({
        planner: { capabilities: ['vault'], builtIn: true },
        implementer: { capabilities: ['vault'], builtIn: true },
        'reviewer-verifier': { capabilities: ['vault'], builtIn: true },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.writer).toBe('implementer')
    expect(r.roster).toBe('implementer:local,planner:claude,reviewer-verifier:claude')
    expect(r.seats[0]).toEqual({ name: 'implementer', capabilities: ['vault', 'writes'] })
    // Nobody else gained anything.
    expect(r.seats[1]).toEqual({ name: 'planner', capabilities: ['vault'] })
  })

  it('a built-in team with no doer on it: the first seat writes', () => {
    const r = buildWriter(
      'planner:claude,reviewer-verifier:claude',
      team({
        planner: { capabilities: ['vault'], builtIn: true },
        'reviewer-verifier': { capabilities: ['vault'], builtIn: true },
      }),
    )
    expect(r.ok && r.writer).toBe('planner')
    expect(r.ok && r.seats[0].capabilities).toEqual(['vault', 'writes'])
  })

  it('a team the user staffed, where no seat was approved to write, is refused before it runs', () => {
    const r = buildWriter(
      'planner:claude,analyst:local',
      team({
        planner: { capabilities: ['vault'], builtIn: false },
        analyst: { capabilities: ['vault', 'web'], builtIn: false },
      }),
    )
    expect(r).toEqual({
      ok: false,
      reason:
        'no agent on this project’s team may write files — give one of them the Writes capability on the Agents page, then start the build again',
    })
  })

  it('one staffed seat among built-ins still counts as the user’s own team', () => {
    // The user put their own agent on the team and did not let it write: the
    // app does not hand writes to someone else behind their back.
    const r = buildWriter(
      'planner:claude,my-dev:local',
      team({
        planner: { capabilities: ['vault'], builtIn: true },
        'my-dev': { capabilities: ['vault'], builtIn: false },
      }),
    )
    expect(r.ok).toBe(false)
  })
})
