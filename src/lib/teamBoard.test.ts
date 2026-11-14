import { describe, expect, it } from 'vitest'
import { boardCountLine, seatLabel, teamBoard, type RosterSeat } from './teamBoard'
import type { EngineSpan } from './nativeEngine'

// THE TEAM BOARD (spec 2026-11-14 "Visible agents"). The owner, of the mockup
// with the Team board at the top of the room: "perfect example what I want".
// The board is the room's TEAM, always on screen: every seat this room would
// put on a job, and — from the spans of its run — what each one is doing, on
// which AI, and how many tokens it has used. Nothing on it is invented: a
// seat with no span says nothing about work it has not done.
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
    attrs: { agent, provider: 'local', model: 'gemma', is_real: true, tokens_in: 100, tokens_out: 40, ...(over.attrs ?? {}) },
  }) as unknown as EngineSpan

const working = (agent: string, start: number, attrs: Record<string, unknown> = {}) =>
  call(agent, start, { status: 'open', end: undefined, attrs } as never)

const roster: RosterSeat[] = [
  { key: 'lead', name: 'Manager', ai: 'claude-cli · fable', local: false, aliases: ['Prism'] },
  { key: 'researcher', name: 'Researcher', ai: 'local · gemma', local: true },
  { key: 'critic', name: 'Critic', ai: 'gemini · flash', local: false },
]

describe('teamBoard', () => {
  it('at rest the room’s whole team is on the board, each on the AI it is set to, saying nothing', () => {
    const m = teamBoard({ roster, spans: [], live: false })
    expect(m.seats.map((s) => s.name)).toEqual(['Manager', 'Researcher', 'Critic'])
    expect(m.seats.map((s) => s.ai)).toEqual(['claude-cli · fable', 'local · gemma', 'gemini · flash'])
    expect(m.seats.every((s) => s.state.kind === 'idle' && !s.running && !s.worked)).toBe(true)
    expect(m.links).toEqual([])
    expect(m.seats[1].local).toBe(true)
  })

  it('a seat that took a turn says what it did, on the AI that really answered, with its tokens', () => {
    const m = teamBoard({
      roster,
      spans: [
        call('lead', 1, { attrs: { provider: 'claude-cli', model: 'opus' } }),
        working('researcher', 3),
      ],
      live: true,
    })
    const [lead, researcher, critic] = m.seats
    // The span's AI wins over the roster's setting: it is what answered.
    expect(lead.ai).toBe('claude-cli · opus')
    expect(lead.state.text).toBe('answered')
    expect(lead.state.tokens).toBe(140)
    expect(lead.worked).toBe(true)
    expect(researcher.running).toBe(true)
    expect(researcher.state.text).toBe('thinking')
    // The seat that has not been called keeps its place and claims nothing.
    expect(critic.state.kind).toBe('idle')
    expect(critic.worked).toBe(false)
  })

  it('seats never change places: the roster’s order holds whoever speaks first', () => {
    const m = teamBoard({ roster, spans: [call('critic', 1), call('lead', 2)], live: false })
    expect(m.seats.map((s) => s.key)).toEqual(['lead', 'researcher', 'critic'])
  })

  it('an agent the roster does not name still gets a seat, after the team', () => {
    const m = teamBoard({ roster, spans: [call('auditor', 1)], live: false })
    expect(m.seats.map((s) => s.key)).toEqual(['lead', 'researcher', 'critic', 'auditor'])
    expect(m.seats[3].name).toBe('Auditor')
  })

  it('a library agent’s seat is matched by its slug and keeps its given name', () => {
    const m = teamBoard({
      roster: [{ key: 'reviewer-verifier', name: 'Reviewer / Verifier', ai: 'claude-cli · fable', local: false }],
      spans: [call('reviewer-verifier', 1)],
      live: false,
    })
    expect(m.seats).toHaveLength(1)
    expect(m.seats[0].name).toBe('Reviewer / Verifier')
    expect(m.seats[0].worked).toBe(true)
  })

  it('the companion speaking under its own name is the lead seat, not a second one', () => {
    const m = teamBoard({ roster, spans: [working('Prism', 1, { provider: 'claude-cli', model: 'fable' })], live: true })
    expect(m.seats.map((s) => s.key)).toEqual(['lead', 'researcher', 'critic'])
    expect(m.seats[0].running).toBe(true)
    // A lookup into the spans is asked for the name the spans used.
    expect(m.seats[0].agent).toBe('Prism')
    expect(m.seats[1].agent).toBe('')
  })

  it('only the most recent handoff is the one to label', () => {
    const m = teamBoard({ roster, spans: [call('lead', 1), call('researcher', 2), call('critic', 3)], live: false })
    expect(m.links.map((l) => [l.from, l.to, l.latest])).toEqual([
      ['lead', 'researcher', false],
      ['researcher', 'critic', true],
    ])
  })

  it('the lead is set apart only when it heads a team of two or more', () => {
    expect(teamBoard({ roster, spans: [], live: false }).seats.map((s) => s.lead)).toEqual([true, false, false])
    expect(teamBoard({ roster: roster.slice(0, 1), spans: [], live: false }).seats[0].lead).toBe(false)
    expect(teamBoard({ roster: roster.slice(1), spans: [], live: false }).seats.some((s) => s.lead)).toBe(false)
  })

  it('a handoff is a link between the two seats, and it moves only while that work is in flight', () => {
    const spans = [call('lead', 1, { attrs: { stage: 'plan' } }), working('researcher', 3, { stage: 'research' })]
    const live = teamBoard({ roster, spans, live: true })
    expect(live.links).toHaveLength(1)
    expect(live.links[0]).toMatchObject({ from: 'lead', to: 'researcher', label: 'research', live: true, back: false })
    // The same spans on a run that is not executing: the link is there, still.
    expect(teamBoard({ roster, spans, live: false }).links[0].live).toBe(false)
  })

  it('a handoff past a seat goes over it, not through it', () => {
    const m = teamBoard({ roster, spans: [call('lead', 1), call('critic', 2)], live: false })
    const link = m.links[0]
    expect(link.from).toBe('lead')
    expect(link.to).toBe('critic')
    // Adjacent seats are joined by a straight run; a skipped seat is cleared
    // by a curve above the rings.
    expect(link.d).toContain('Q')
    const near = teamBoard({ roster, spans: [call('lead', 1), call('researcher', 2)], live: false }).links[0]
    expect(near.d).not.toContain('Q')
  })

  it('one AI answering a message lights the lead seat, and only it', () => {
    const m = teamBoard({ roster, spans: [], live: true, answering: true })
    expect(m.seats[0].running).toBe(true)
    expect(m.seats.slice(1).some((s) => s.running)).toBe(false)
    // The chat's own bubble says it is thinking; the seat only breathes. The
    // same fact is not put into words twice.
    expect(m.seats[0].state.kind).toBe('idle')
    expect(m.working).toBe(1)
  })

  // Seen in a real two-seat run, 2026-11-14: the researcher was "searching
  // the web" — its model call had closed and a tool call was open — and
  // nothing moved. A seat using a tool on a live run IS working.
  it('a seat using a tool is working, and the handoff into it is in flight', () => {
    const tool = {
      span_id: 'researcher-tool-3',
      type: 'tool_exec',
      name: 'tool_exec',
      start: 3,
      status: 'open',
      attrs: { agent: 'researcher', tool: 'web_search' },
    } as unknown as EngineSpan
    const m = teamBoard({ roster, spans: [call('lead', 1), call('researcher', 2), tool], live: true })
    const researcher = m.seats.find((s) => s.key === 'researcher')!
    expect(researcher.state.text).toBe('searching the web')
    expect(researcher.running).toBe(true)
    expect(m.links.find((l) => l.to === 'researcher')!.live).toBe(true)
  })

  it('a parked run lights nobody', () => {
    const m = teamBoard({ roster, spans: [working('researcher', 3)], live: false })
    expect(m.seats.some((s) => s.running)).toBe(false)
  })

  it('counts are read off the board: how many, how many have worked, how many are working', () => {
    const m = teamBoard({ roster, spans: [call('lead', 1), working('researcher', 3)], live: true })
    expect(m).toMatchObject({ total: 3, worked: 2, working: 1 })
    expect(boardCountLine(m, true)).toBe('3 agents · 2 have worked · 1 working now')
  })

  it('the count line claims no work that has not happened, and no "working now" on a still room', () => {
    const rest = teamBoard({ roster, spans: [], live: false })
    expect(boardCountLine(rest, false)).toBe('3 agents')
    const after = teamBoard({ roster: roster.slice(0, 1), spans: [call('lead', 1)], live: false })
    expect(boardCountLine(after, false)).toBe('1 agent · 1 has worked')
    expect(boardCountLine(teamBoard({ roster: [], spans: [], live: false }), false)).toBe('')
  })

  // Seen in a test of two runs at once: the head said "2 agents · 0 working
  // now" while two engines were at work — their steps simply could not be
  // told apart. A number the board cannot see is not zero; it is not said.
  it('a live run whose steps cannot be shown is not counted as "0 working now"', () => {
    const blind = teamBoard({ roster, spans: [], live: true })
    expect(boardCountLine(blind, true)).toBe('3 agents')
    // The same between two turns of a run: nobody is mid-call, and the head
    // does not announce a zero.
    const between = teamBoard({ roster, spans: [call('lead', 1)], live: true })
    expect(boardCountLine(between, true)).toBe('3 agents · 1 has worked')
  })

  it('the lead seat is called the Manager, and a role is shown as a name', () => {
    expect(seatLabel('lead')).toBe('Manager')
    expect(seatLabel('researcher')).toBe('Researcher')
    // Only the first letter: a name that is already one is left alone.
    expect(seatLabel('Prism')).toBe('Prism')
    expect(seatLabel('reviewer-verifier')).toBe('Reviewer-verifier')
  })
})

// WHO IS ON THE TEAM comes from the same roster string a launch sends, read
// against the settings: the AI under an idle seat is the one it is set to.
import { rosterSeats } from './teamBoard'
import { DEFAULT_SETTINGS, type Settings } from './settings'

describe('rosterSeats', () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    providers: DEFAULT_SETTINGS.providers.map((p) =>
      p.id === 'local'
        ? { ...p, enabled: true, model: 'gemma-3' }
        : p.id === 'gemini'
          ? { ...p, enabled: true, apiKey: 'k', model: 'gemini-flash-latest' }
          : p,
    ),
  }

  it('each seat of the roster is named, with the provider and model it is set to', () => {
    expect(rosterSeats(settings, 'lead:gemini,researcher:local')).toEqual([
      { key: 'lead', name: 'Manager', ai: 'gemini · gemini-flash-latest', local: false },
      { key: 'researcher', name: 'Researcher', ai: 'local · gemma-3', local: true },
    ])
  })

  it('a library agent’s seat carries the name it was given, not its slug', () => {
    const seats = rosterSeats(settings, 'reviewer-verifier:local', { agents: [{ name: 'Reviewer / Verifier' }] })
    expect(seats[0]).toMatchObject({ key: 'reviewer-verifier', name: 'Reviewer / Verifier' })
  })

  it('the lead seat also answers to the companion’s own name', () => {
    const seats = rosterSeats(settings, 'lead:local,researcher:local', { leadAlias: 'Prism' })
    expect(seats[0].aliases).toEqual(['Prism'])
    expect(seats[1].aliases).toBeUndefined()
  })

  it('an empty roster seats nobody', () => {
    expect(rosterSeats(settings, '')).toEqual([])
  })
})
