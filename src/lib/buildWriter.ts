// WHO WRITES THE FILES OF A PROJECT BUILD (2026-11-14).
//
// The engine lets ONE seat of a build write to the folder: the board's lead —
// the first seat of the roster, which synthesizes the FILE blocks
// (`_cmd_project`: `writer_agent = roster[0].name`; refused at
// `project.apply_file_ops` when that seat does not hold `writes`).
//
// So the app has to send a roster whose FIRST seat is one that may write.
// Until now it sent the team in its own order, and since the built-in agents
// were given grants of their own (vault, web) every build on the default team
// led with the Planner, which holds no `writes`: a job ran its board three
// times and changed nothing ("all file writes rejected: planner was not
// granted the 'writes' capability").
//
// The rule, in order:
//   1. No seat carries any grant → nothing is gated; the roster is untouched.
//   2. A seat holds `writes` → it leads. It is the one that writes.
//   3. Every seat is one of the BUILT-IN agents → the seat that does the work
//      (the Implementer) is asked for `writes` for this build, and leads.
//      Writing the project's files is that agent's charter; whether writes
//      are allowed at all is still the user's own grant, which the engine
//      intersects again.
//   4. Otherwise — a team the user staffed, with no seat approved to write —
//      the build is refused BEFORE it runs, in words that say what to change.
//      The app never hands `writes` to an agent the user configured without it.
//
// Pure. The engine remains the boundary; this only decides what is asked for.

import { normalizeCapabilities, type Capability } from './delegation'
import { splitRoster } from './roster'
import { seatKind } from './workload'

export type BuildWriter =
  | {
      ok: true
      /** The roster to send: the writer first, the rest in their order. */
      roster: string
      /** The seat that writes. */
      writer: string
      /** Each seat's requested grants, in the roster's order. */
      seats: { name: string; capabilities: Capability[] }[]
    }
  | { ok: false; reason: string }

export function buildWriter(
  roster: string,
  seatInfo: (role: string) => { capabilities: readonly Capability[]; builtIn: boolean },
): BuildWriter {
  const pairs = splitRoster(roster)
  const seats = pairs.map((p) => {
    const info = seatInfo(p.role)
    return {
      role: p.role,
      token: p.token,
      capabilities: normalizeCapabilities(info.capabilities as string[]),
      builtIn: info.builtIn,
    }
  })
  const done = (order: typeof seats): BuildWriter => ({
    ok: true,
    roster: order.map((s) => `${s.role}:${s.token}`).join(','),
    writer: order[0]?.role ?? '',
    seats: order.map((s) => ({ name: s.role, capabilities: s.capabilities })),
  })
  const leadWith = (i: number) => done([seats[i], ...seats.filter((_, j) => j !== i)])

  // 1. Nothing is gated.
  if (seats.every((s) => s.capabilities.length === 0)) return done(seats)

  // 2. A seat that may write leads.
  const holder = seats.findIndex((s) => s.capabilities.includes('writes'))
  if (holder >= 0) return leadWith(holder)

  // 3. The built-in team: its doer is asked for writes.
  if (seats.every((s) => s.builtIn)) {
    const doer = seats.findIndex((s) => seatKind(s.role) === 'do')
    const i = doer >= 0 ? doer : 0
    seats[i] = {
      ...seats[i],
      capabilities: normalizeCapabilities([...seats[i].capabilities, 'writes']),
    }
    return leadWith(i)
  }

  // 4. A staffed team where nobody was approved to write.
  return {
    ok: false,
    reason:
      'no agent on this project’s team may write files — give one of them the Writes capability on the Agents page, then start the build again',
  }
}
