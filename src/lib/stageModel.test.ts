import { describe, expect, it } from 'vitest'
import { STRIP_H, packetRadii, stageLayout, stageModel, stripLayout } from './stageModel'
import type { EngineSpan } from './nativeEngine'

// The owner, 2026-11-11: "Build in the form of animation… agent communicating
// to agent, show with the animation… user can see the animation most of the
// time." The stage is the SAME facts the board draws — seats, handoffs, what
// each one is doing — laid out to be watched. Nothing here is invented: a
// seat is an agent with a model_call span, a link is two consecutive work
// turns by different agents, and a link MOVES only while the run is live and
// the receiving seat is the one working.
const call = (
  agent: string,
  start: number,
  over: Partial<EngineSpan> & { attrs?: Record<string, unknown> } = {},
): EngineSpan =>
  ({
    span_id: `${agent}-${start}`,
    type: 'model_call',
    name: 'model_call',
    start,
    end: start + 1,
    status: 'ok',
    ...over,
    attrs: { agent, provider: 'local', model: 'm', is_real: true, tokens_in: 10, tokens_out: 5, ...(over.attrs ?? {}) },
  }) as unknown as EngineSpan

describe('stageLayout — where the seats stand', () => {
  it('one seat stands in the middle', () => {
    expect(stageLayout(1)).toEqual([{ x: 50, y: 40 }])
  })
  it('several seats spread along an arc, left to right, inside the stage', () => {
    const pts = stageLayout(4)
    expect(pts).toHaveLength(4)
    expect(pts.map((p) => p.x)).toEqual([...pts.map((p) => p.x)].sort((a, b) => a - b))
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(10)
      expect(p.x).toBeLessThanOrEqual(90)
      expect(p.y).toBeGreaterThanOrEqual(20)
      expect(p.y).toBeLessThanOrEqual(70)
    }
    // The middle of the arc is higher than its ends.
    expect(pts[1].y).toBeLessThan(pts[0].y)
    expect(pts[2].y).toBeLessThan(pts[3].y)
  })
  it('no seats, no positions', () => {
    expect(stageLayout(0)).toEqual([])
  })
})

describe('stageModel — the run, as something to watch', () => {
  it('has a seat for each agent that really took a turn, in order of first appearance', () => {
    const m = stageModel([call('lead', 1), call('researcher', 2), call('lead', 3)], false)
    expect(m.seats.map((s) => s.name)).toEqual(['lead', 'researcher'])
    expect(m.seats[0].letter).toBe('L')
    expect(m.seats[0].ai).toBe('local · m')
  })

  it('draws a link for a handoff, labelled with the engine’s word for the later turn', () => {
    const m = stageModel([call('lead', 1), call('researcher', 2, { attrs: { stage: 'research' } })], false)
    expect(m.links).toHaveLength(1)
    expect(m.links[0]).toMatchObject({ from: 'lead', to: 'researcher', label: 'research' })
    expect(m.links[0].d).toMatch(/^M[\d.]+ [\d.]+ Q[\d.]+ [-\d.]+ [\d.]+ [\d.]+$/)
  })

  it('a link moves only while the run is live and its receiver is the seat working', () => {
    const spans = [call('lead', 1), call('researcher', 2, { status: 'open', end: undefined } as never)]
    expect(stageModel(spans, true).links[0].live).toBe(true)
    // The same spans on a run that is not live: nothing moves.
    expect(stageModel(spans, false).links[0].live).toBe(false)
    // A finished exchange on a live run: the receiver has answered, nothing moves.
    expect(stageModel([call('lead', 1), call('researcher', 2)], true).links[0].live).toBe(false)
  })

  it('a hand back is its own link, drawn on the other side of the pair', () => {
    const m = stageModel([call('writer', 1), call('critic', 2), call('writer', 3)], false)
    expect(m.links.map((l) => `${l.from}>${l.to}`)).toEqual(['writer>critic', 'critic>writer'])
    expect(m.links[0].back).toBe(false)
    expect(m.links[1].back).toBe(true)
  })

  it('says who is speaking now, in the seat’s own state words', () => {
    const spans = [call('lead', 1), call('researcher', 2, { status: 'open', end: undefined } as never)]
    const m = stageModel(spans, true)
    expect(m.caption?.who).toBe('researcher')
    expect(m.caption?.ai).toBe('local · m')
    expect(m.caption?.text).toBeTruthy()
  })

  it('an empty run has an empty stage', () => {
    expect(stageModel([], true)).toEqual({ seats: [], links: [], caption: null })
  })
})

// Seen in the installed app during a real team run (2026-11-11): the room gave
// the stage about 250 points of height, the end seats stood 58% of the way
// down it, and their names and states were cut off by the composer.
describe('the stage fits the room it is given', () => {
  it('no seat stands lower than half way down — its name and state go under it', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      for (const p of stageLayout(n)) expect(p.y, `n=${n}`).toBeLessThanOrEqual(50)
    }
  })

  it('the arc still rises in the middle', () => {
    const pts = stageLayout(3)
    expect(pts[1].y).toBeLessThan(pts[0].y)
    expect(pts[1].y).toBeGreaterThanOrEqual(20)
  })
})

// The links are drawn in a 1000 × 400 box stretched to whatever the room
// gives, so a packet's radii are set per axis to stay ROUND on screen.
describe('packetRadii — a packet stays round in a stretched drawing', () => {
  it('in a box of the drawing’s own shape the radii are equal', () => {
    const r = packetRadii(1000, 400)
    expect(r.rx).toBeCloseTo(r.ry, 5)
  })

  it('in a wide, short box the horizontal radius shrinks in drawing units', () => {
    const r = packetRadii(1000, 200)
    // 5 screen px: x maps 1:1, y maps 400 units onto 200 px.
    expect(r.rx).toBeCloseTo(5, 5)
    expect(r.ry).toBeCloseTo(10, 5)
  })

  it('before the box has been measured it falls back to a plain dot', () => {
    expect(packetRadii(0, 0)).toEqual({ rx: 6, ry: 6 })
  })
})

// The run strip (spec 2026-11-14 "The chat is the room"): the same seats and
// handoffs on ONE line above the chat — a track with a station per seat.
describe('stripLayout — seats on one line', () => {
  it('one seat stands in the middle of the line', () => {
    expect(stripLayout(1)).toEqual([{ x: 50, y: 50 }])
  })
  it('several seats are evenly spaced, left to right, all on the line', () => {
    const pts = stripLayout(4)
    expect(pts.map((p) => p.y)).toEqual([50, 50, 50, 50])
    const gaps = pts.slice(1).map((p, i) => Math.round((p.x - pts[i].x) * 10) / 10)
    expect(new Set(gaps).size).toBe(1)
    expect(pts[0].x).toBeGreaterThanOrEqual(5)
    expect(pts[3].x).toBeLessThanOrEqual(95)
  })
  it('no seats, no positions', () => {
    expect(stripLayout(0)).toEqual([])
  })
})

describe('stageModel in a row — the strip above the chat', () => {
  const spans = [call('lead', 1), call('researcher', 2), call('critic', 3), call('lead', 4)]
  it('has the same seats, links and caption as the stage — only the places differ', () => {
    const arc = stageModel(spans, true)
    const row = stageModel(spans, true, 'row')
    expect(row.seats.map((s) => s.name)).toEqual(arc.seats.map((s) => s.name))
    expect(row.links.map((l) => [l.from, l.to, l.live, l.back])).toEqual(
      arc.links.map((l) => [l.from, l.to, l.live, l.back]),
    )
    expect(row.caption).toEqual(arc.caption)
  })
  it('every seat is on the line and every link is a straight run along it', () => {
    const row = stageModel(spans, true, 'row')
    expect(new Set(row.seats.map((s) => s.y))).toEqual(new Set([50]))
    for (const l of row.links) expect(l.d).toMatch(/^M[\d.]+ 50 L[\d.]+ 50$/)
  })
  it('a hand back runs the other way along the same line', () => {
    const row = stageModel(spans, false, 'row')
    const back = row.links.find((l) => l.back)!
    const [from, to] = back.d.match(/[\d.]+(?= 50)/g)!.map(Number)
    expect(from).toBeGreaterThan(to)
  })
})

describe('packetRadii in the strip', () => {
  it('uses the strip’s own box height', () => {
    // 1000 × 100 drawing in a 500 × 50 box: both axes scale by two.
    expect(packetRadii(500, 50, STRIP_H)).toEqual({ rx: 10, ry: 10 })
  })
})
