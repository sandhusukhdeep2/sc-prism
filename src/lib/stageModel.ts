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

/**
 * Where `n` seats stand: left to right along an arc, in percent.
 *
 * A seat's ring is centred on its point and its name, AI and state hang BELOW
 * it, so no seat stands lower than half way down: in the real room the stage
 * is often given only ~250 points of height, and seats at 58% had their names
 * cut off by the composer (seen in a live team run, 2026-11-11).
 */
export function stageLayout(n: number): { x: number; y: number }[] {
  if (n <= 0) return []
  if (n === 1) return [{ x: 50, y: 40 }]
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return { x: r1(12 + 76 * t), y: r1(50 - 22 * Math.sin(Math.PI * t)) }
  })
}

/** The strip's drawing box is 1000 × 100: one line of seats above the chat. */
export const STRIP_H = 100

/**
 * Where `n` seats stand in the strip: evenly spaced on ONE line, in percent.
 * A track with a station per seat — the same seats and handoffs as the stage,
 * at a quarter of the height.
 */
export function stripLayout(n: number): { x: number; y: number }[] {
  if (n <= 0) return []
  if (n === 1) return [{ x: 50, y: 50 }]
  return Array.from({ length: n }, (_, i) => ({ x: r1(8 + (84 * i) / (n - 1)), y: 50 }))
}

/** How big a packet looks on screen, in CSS pixels (its radius). */
const PACKET_PX = 5

/**
 * A packet's radii in the DRAWING's units, so it stays round on screen.
 *
 * The links are drawn in a 1000 × 400 box that is stretched to whatever shape
 * the room gives the stage; a plain circle would be squashed with it. Given
 * the box's measured size, the radii are set per axis. Before it has been
 * measured (0 × 0) a plain dot is returned.
 */
export function packetRadii(
  widthPx: number,
  heightPx: number,
  boxH: number = STAGE_H,
): { rx: number; ry: number } {
  if (!(widthPx > 0) || !(heightPx > 0)) return { rx: 6, ry: 6 }
  return { rx: (PACKET_PX * STAGE_W) / widthPx, ry: (PACKET_PX * boxH) / heightPx }
}

/**
 * `shape` only decides WHERE things stand: 'arc' is the full stage (the Live
 * page), 'row' the strip above the chat. The seats, the links, what is live
 * and who is speaking are the same facts either way.
 */
export function stageModel(
  spans: readonly EngineSpan[],
  live: boolean,
  shape: 'arc' | 'row' = 'arc',
): StageModel {
  const orbs = agentOrbs(spans as EngineSpan[])
  if (orbs.length === 0) return { seats: [], links: [], caption: null }
  const row = shape === 'row'
  const boxH = row ? STRIP_H : STAGE_H
  const spots = row ? stripLayout(orbs.length) : stageLayout(orbs.length)
  const seats: StageSeat[] = orbs.map((o, i) => {
    const state = seatState(spans as EngineSpan[], o.agent, live)
    return {
      name: o.agent,
      ai: [o.provider, o.model].filter(Boolean).join(' · ') || 'an AI',
      local: o.provider === 'local',
      tint: agentTint(o.provider, o.model),
      letter: monogram(o.agent),
      state,
      // Working right now: its model call is open — or, between calls, a tool
      // of its own is (`seatState` only says 'thinking' / 'tool' for an OPEN
      // span on a LIVE run, so a parked or finished run cannot reach here).
      running: live && (o.outcome === 'running' || state.kind === 'thinking' || state.kind === 'tool'),
      x: spots[i].x,
      y: spots[i].y,
    }
  })
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
    const ay = a.y * (boxH / 100)
    const bx = b.x * (STAGE_W / 100)
    const by = b.y * (boxH / 100)
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
      // In the strip a link is a straight run along the one line the seats
      // stand on; its direction is the handoff's.
      d: row
        ? `M${r1(ax)} ${r1(ay)} L${r1(bx)} ${r1(by)}`
        : `M${r1(ax)} ${r1(ay)} Q${r1(cx)} ${r1(cy)} ${r1(bx)} ${r1(by)}`,
      // The curve's own midpoint (t = 0.5 of a quadratic), in percent.
      lx: row ? r1((ax + bx) / 2 / (STAGE_W / 100)) : r1(((ax + 2 * cx + bx) / 4 / STAGE_W) * 100),
      ly: row ? 50 : r1(((ay + 2 * cy + by) / 4 / STAGE_H) * 100),
    }
  })

  // Who is speaking: the seat working now, else the seat that took the last turn.
  // When more than one seat has work open, it is the one the latest handoff
  // went to — the same seat the moving link points at.
  const receiver = last && at.has(last.to) ? seats[at.get(last.to)!] : undefined
  const speaking =
    (receiver?.running ? receiver : undefined) ??
    seats.find((s) => s.running) ??
    receiver ??
    seats[seats.length - 1]
  const caption = speaking
    ? { who: speaking.name, ai: speaking.ai, text: speaking.state.text }
    : null
  return { seats, links, caption }
}
