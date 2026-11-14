// The Team board (spec 2026-11-14 "Visible agents").
//
// The owner, of the mockup that puts the Team board at the top of the room:
// "perfect example what I want". The board is the room's TEAM, on screen
// whether or not anything is running: every seat this room would put on a
// job, and — read from the spans of its run — what each one is doing, on
// which AI, and how many tokens it has used.
//
// TWO SOURCES, NEVER MIXED UP. Who is ON the team comes from the roster (the
// same string a launch sends). What a seat DID comes from spans, and only
// from spans: a seat with no span is idle and says nothing. The AI under a
// seat is the roster's setting until a span names the AI that really
// answered, and from then on it is the span's.
//
// Seats never change places: the roster's order holds whoever speaks first,
// so a person looking at the board learns where each coworker sits.
import type { EngineSpan } from './nativeEngine'
import { agentOrbs } from './orbs'
import { handoffs } from './handoffs'
import { seatState, type SeatState } from './seatState'
import { agentTint, monogram } from './pipeline'
import { IDLE_HUE } from './modelColor'
import { agentSlug } from './agents'
import { resolveProviderToken, splitRoster } from './roster'
import type { Settings } from './settings'

/** One seat of the room's team, as the roster names it. */
export interface RosterSeat {
  /** The seat as the engine names it in spans: a roster role, or an agent's slug. */
  key: string
  /** What the board calls it. */
  name: string
  /** `provider · model` the seat is set to run on. */
  ai: string
  local: boolean
  /** Other names a span may use for this seat (the companion's own name for the lead). */
  aliases?: readonly string[]
}

export interface BoardSeat {
  key: string
  name: string
  /** The AI that answered, once a span names it; until then the roster's setting. */
  ai: string
  local: boolean
  tint: string
  letter: string
  state: SeatState
  /** Working right now, on a live run. */
  running: boolean
  /** Has taken a turn in the spans drawn. */
  worked: boolean
  /** Set apart at the head of the row. */
  lead: boolean
  /** The name the spans themselves use for this seat ('' until it has one) —
   *  what a lookup into those spans must be asked for. */
  agent: string
  /** Centre of the seat's column, in percent of the board. */
  x: number
}

export interface BoardLink {
  from: string
  to: string
  /** The engine's word for the later turn ('' when it gave none). */
  label: string
  /** Work is in flight along this link right now. */
  live: boolean
  /** A hand BACK to an earlier seat. */
  back: boolean
  /** The most recent handoff of the run — the one the board labels. */
  latest: boolean
  /** SVG path in the 1000 × BOARD_H box. */
  d: string
  /** Where the label sits, in percent of the board (x) and of the band (y). */
  lx: number
  ly: number
}

export interface TeamBoardModel {
  seats: BoardSeat[]
  links: BoardLink[]
  total: number
  worked: number
  working: number
}

/** The links are drawn in a 1000 × 100 box laid over the rings. */
export const BOARD_W = 1000
export const BOARD_H = 100
/** Where the rings' centres sit in that box; the room above them is for arcs. */
export const RING_Y = 66
/** How far above the rings a link that skips a seat is lifted (control point). */
const ARC_LIFT = 110

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * What a seat is called on screen. The lead seat is the Manager — one name
 * for it wherever a seat is named — and a role the engine writes in lower
 * case ('researcher', 'critic') is shown as a name, like the library's own
 * agents (Planner, Researcher). Only the first letter changes.
 */
export function seatLabel(agent: string): string {
  if (agent === 'lead') return 'Manager'
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

/**
 * The seats of a roster string (`role:token,…` — the same string a launch
 * sends), read against the settings: each seat's name, and the provider and
 * model it is set to run on.
 *
 * `agents` are the library's agents: a seat whose role is an agent's slug is
 * called by the name that agent was given. `leadAlias` is the companion's own
 * name — a wake speaks under it, and it is the lead's seat that is speaking.
 */
export function rosterSeats(
  settings: Settings,
  roster: string,
  opts: { agents?: readonly { name: string }[]; leadAlias?: string } = {},
): RosterSeat[] {
  return splitRoster(roster).map(({ role, token }) => {
    const p = resolveProviderToken(settings, token)
    const provider = p?.id ?? token
    const model = (p?.model ?? '').trim()
    const given = (opts.agents ?? []).find((a) => agentSlug(a.name) === role)?.name
    const alias = role === 'lead' ? (opts.leadAlias ?? '').trim() : ''
    return {
      key: role,
      name: given ?? seatLabel(role),
      ai: [provider, model].filter(Boolean).join(' · '),
      local: provider === 'local',
      ...(alias ? { aliases: [alias] } : {}),
    }
  })
}

/**
 * The name the room uses for a seat, for anything that prints one beside the
 * board (the lines in the chat, a handoff's "handed to …"): the roster's own
 * name when the agent is on it — matched by key, by slug, or by an alias —
 * and the plain label otherwise. One seat, one name.
 */
export function rosterNameOf(roster: readonly RosterSeat[]): (agent: string) => string {
  return (agent) => {
    const hit = roster.find(
      (r) => r.key === agent || r.key === agentSlug(agent) || (r.aliases ?? []).includes(agent),
    )
    return hit ? hit.name : seatLabel(agent)
  }
}

function agentOf(s: EngineSpan): string {
  const v = s.attrs?.agent
  return typeof v === 'string' ? v : ''
}

export function teamBoard(input: {
  roster: readonly RosterSeat[]
  spans: readonly EngineSpan[]
  live: boolean
  /** One AI is answering a message in this room: the lead seat is at work. */
  answering?: boolean
}): TeamBoardModel {
  const { roster, live } = input
  // A span names its agent in the engine's words; the roster seat it belongs
  // to is found by key, by slug, or by a name the seat is also known under.
  const keyOf = (agent: string): string => {
    const hit = roster.find(
      (r) => r.key === agent || r.key === agentSlug(agent) || (r.aliases ?? []).includes(agent),
    )
    return hit ? hit.key : agent
  }
  const spokenAs = new Map<string, string>()
  const spans = input.spans.map((s) => {
    const agent = agentOf(s)
    if (!agent) return s
    const key = keyOf(agent)
    if (!spokenAs.has(key)) spokenAs.set(key, agent)
    return key === agent ? s : ({ ...s, attrs: { ...s.attrs, agent: key } } as EngineSpan)
  })

  const orbs = agentOrbs(spans)
  const orbOf = new Map(orbs.map((o) => [o.agent, o] as const))
  const keys = [...roster.map((r) => r.key), ...orbs.map((o) => o.agent).filter((a) => !roster.some((r) => r.key === a))]
  const n = keys.length
  const leadKey = n >= 2 && roster[0]?.key === 'lead' ? 'lead' : ''

  const seats: BoardSeat[] = keys.map((key, i) => {
    const seat = roster.find((r) => r.key === key)
    const orb = orbOf.get(key)
    const state: SeatState = orb ? seatState(spans, key, live) : { kind: 'idle', text: '', tokens: 0 }
    let running = live && !!orb && (orb.outcome === 'running' || state.kind === 'thinking' || state.kind === 'tool')
    // One AI answering a message has no seat of its own in the spans; the app
    // knows its primary is at work, and the primary is the lead. The seat
    // breathes and says nothing: the chat's own bubble has the words.
    if (input.answering && live && key === 'lead') running = true
    return {
      key,
      name: seat?.name ?? seatLabel(key),
      ai: orb ? [orb.provider, orb.model].filter(Boolean).join(' · ') || 'an AI' : (seat?.ai ?? 'an AI'),
      local: orb ? orb.provider === 'local' : !!seat?.local,
      tint: orb ? agentTint(orb.provider, orb.model) : IDLE_HUE,
      letter: monogram(seat?.name ?? seatLabel(key)),
      state,
      running,
      worked: !!orb,
      lead: key === leadKey,
      agent: spokenAs.get(key) ?? '',
      x: r1(((i + 0.5) / n) * 100),
    }
  })
  const at = new Map(seats.map((s, i) => [s.key, i] as const))

  // One link per ordered pair, carrying its LATEST label; first-seen order.
  const hands = handoffs(spans)
  const order: string[] = []
  const latest = new Map<string, { from: string; to: string; label: string }>()
  for (const h of hands) {
    if (!at.has(h.from) || !at.has(h.to)) continue
    const key = `${h.from}\u0000${h.to}`
    if (!latest.has(key)) order.push(key)
    latest.set(key, h)
  }
  const last = hands[hands.length - 1]
  const links: BoardLink[] = order.map((key) => {
    const h = latest.get(key)!
    const ia = at.get(h.from)!
    const ib = at.get(h.to)!
    const ax = seats[ia].x * (BOARD_W / 100)
    const bx = seats[ib].x * (BOARD_W / 100)
    const near = Math.abs(ia - ib) === 1
    const cy = RING_Y - ARC_LIFT
    return {
      from: h.from,
      to: h.to,
      label: h.label,
      back: ib < ia,
      latest: !!last && last.from === h.from && last.to === h.to,
      live: live && !!last && last.from === h.from && last.to === h.to && seats[ib].running,
      // Neighbours are joined by a straight run along the rings; a handoff
      // that skips a seat goes over it, so it never reads as passing through.
      d: near
        ? `M${r1(ax)} ${RING_Y} L${r1(bx)} ${RING_Y}`
        : `M${r1(ax)} ${RING_Y} Q${r1((ax + bx) / 2)} ${cy} ${r1(bx)} ${RING_Y}`,
      lx: r1((seats[ia].x + seats[ib].x) / 2),
      // The curve's own midpoint (t = 0.5 of a quadratic), in percent of the band.
      ly: near ? RING_Y : r1(((2 * RING_Y + 2 * cy) / 4 / BOARD_H) * 100),
    }
  })

  return {
    seats,
    links,
    total: seats.length,
    worked: seats.filter((s) => s.worked).length,
    working: seats.filter((s) => s.running).length,
  }
}

/**
 * The room's count, read off the board: how many agents, how many have taken
 * a turn in what is drawn, and — while a run is executing and the board can
 * SEE a seat at work — how many are working now. A number the board cannot
 * see is not zero, so it is not said: a room at rest, a run whose steps
 * cannot be told apart, and the gap between two turns all claim nothing.
 */
export function boardCountLine(m: TeamBoardModel, live: boolean): string {
  if (m.total === 0) return ''
  const parts = [`${m.total} agent${m.total === 1 ? '' : 's'}`]
  if (m.worked > 0) parts.push(`${m.worked} ha${m.worked === 1 ? 's' : 've'} worked`)
  if (live && m.working > 0) parts.push(`${m.working} working now`)
  return parts.join(' · ')
}
