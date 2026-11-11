// The run, as something to WATCH (2026-11-11).
//
// The owner: "Build in the form of animation… agent communicating to agent,
// show with the animation… user can see the animation most of the time." The
// stage draws the same facts the crew board draws, laid out to be watched:
// seats on an arc, a curved link for every handoff, and one line saying who is
// speaking now.
//
// NOTHING HERE IS INVENTED. A seat is an agent with a model_call span
// (`agentOrbs`). A link is two consecutive work turns by different agents
// (`handoffs`). What a seat says is `seatState`'s words. And a link MOVES only
// while the run is live, it is the latest handoff, and its receiver is the
// seat working right now — motion is a claim that work is in flight.
import type { EngineSpan } from './nativeEngine'
import { agentOrbs } from './orbs'
import { handoffs } from './handoffs'
import { seatState, type SeatState } from './seatState'
import { agentTint, monogram } from './pipeline'

/** The drawing's own units: links are paths in a 1000 × 400 box. */
export const STAGE_W = 1000
export const STAGE_H = 400

export interface StageSeat {
  name: string
  /** `provider · model`, or 'an AI' when the span named neither. */
  ai: string
  /** Ran on this Mac (provider `local`). */
  local: boolean
  tint: string
  letter: string
  state: SeatState
  /** Working right now, on a live run. */
  running: boolean
  /** Position, in percent of the stage. */
  x: number
  y: number
}

export interface StageLink {
  from: string
  to: string
  /** The engine's word for the later turn ('' when it gave none). */
  label: string
  /** Work is in flight along this link right now. */
  live: boolean
  /** A hand BACK to an earlier seat — drawn on the other side of the pair. */
  back: boolean
  /** SVG path in the 1000 × 400 box. */
  d: string
  /** Where the label sits, in percent of the stage. */
  lx: number
  ly: number
}

export interface StageModel {
  seats: StageSeat[]
  links: StageLink[]
  /** Who is speaking now (or spoke last), in the seat's own state words. */
  caption: { who: string; ai: string; text: string } | null
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Where `n` seats stand: left to right along an arc, in percent. */
export function stageLayout(n: number): { x: number; y: number }[] {
  if (n <= 0) return []
  if (n === 1) return [{ x: 50, y: 46 }]
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return { x: r1(12 + 76 * t), y: r1(58 - 22 * Math.sin(Math.PI * t)) }
  })
}

export function stageModel(spans: readonly EngineSpan[], live: boolean): StageModel {
  const orbs = agentOrbs(spans as EngineSpan[])
  if (orbs.length === 0) return { seats: [], links: [], caption: null }
  const spots = stageLayout(orbs.length)
  const seats: StageSeat[] = orbs.map((o, i) => ({
    name: o.agent,
    ai: [o.provider, o.model].filter(Boolean).join(' · ') || 'an AI',
    local: o.provider === 'local',
    tint: agentTint(o.provider, o.model),
    letter: monogram(o.agent),
    state: seatState(spans as EngineSpan[], o.agent, live),
    running: live && o.outcome === 'running',
    x: spots[i].x,
    y: spots[i].y,
  }))
  const at = new Map(seats.map((s, i) => [s.name, i] as const))

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
  const links: StageLink[] = order.map((key) => {
    const h = latest.get(key)!
    const a = seats[at.get(h.from)!]
    const b = seats[at.get(h.to)!]
    const back = at.get(h.to)! < at.get(h.from)!
    const ax = a.x * (STAGE_W / 100)
    const ay = a.y * (STAGE_H / 100)
    const bx = b.x * (STAGE_W / 100)
    const by = b.y * (STAGE_H / 100)
    const span = Math.abs(at.get(h.to)! - at.get(h.from)!)
    const lift = 70 + 22 * span
    const cx = (ax + bx) / 2
    const cy = (ay + by) / 2 + (back ? lift : -lift)
    return {
      from: h.from,
      to: h.to,
      label: h.label,
      back,
      live: live && !!last && last.from === h.from && last.to === h.to && b.running,
      d: `M${r1(ax)} ${r1(ay)} Q${r1(cx)} ${r1(cy)} ${r1(bx)} ${r1(by)}`,
      // The curve's own midpoint (t = 0.5 of a quadratic), in percent.
      lx: r1(((ax + 2 * cx + bx) / 4 / STAGE_W) * 100),
      ly: r1(((ay + 2 * cy + by) / 4 / STAGE_H) * 100),
    }
  })

  // Who is speaking: the seat working now, else the seat that took the last turn.
  const speaking =
    seats.find((s) => s.running) ??
    (last ? seats[at.get(last.to)!] : seats[seats.length - 1])
  const caption = speaking
    ? { who: speaking.name, ai: speaking.ai, text: speaking.state.text }
    : null
  return { seats, links, caption }
}
