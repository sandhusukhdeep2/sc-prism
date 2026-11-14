import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import TeamBoard from './TeamBoard'
import type { RosterSeat } from '../lib/teamBoard'
import type { EngineSpan } from '../lib/nativeEngine'
import type { LiveRun } from '../lib/liveRuns'

// THE TEAM BOARD (spec 2026-11-14 "Visible agents"). The owner, of the mockup
// with the Team board at the top of the room: "perfect example what I want".
// The room's team is always on screen — each seat a ring, its name, the AI it
// runs on, what it is doing and its tokens — and a run is drawn ON that team:
// the seat at work breathes, the handoff in flight carries packets. It takes
// over everything the slim strip said (what is running, Stop, where the
// engine is busy), each fact still said once.
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

const run = (patch: Partial<LiveRun> = {}): LiveRun => ({
  id: 'r1',
  kind: 'team',
  intent: 'compare the two plans',
  startedAt: 1_000,
  models: [],
  ...patch,
})

const roster: RosterSeat[] = [
  { key: 'lead', name: 'Manager', ai: 'claude-cli · fable', local: false },
  { key: 'researcher', name: 'Researcher', ai: 'local · gemma', local: true },
  { key: 'critic', name: 'Critic', ai: 'gemini · flash', local: false },
]

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

const base = {
  roster,
  runs: [] as LiveRun[],
  spans: [] as EngineSpan[],
  live: false,
  elsewhere: [] as LiveRun[],
  roomName: (room: string) => (room === 'universal' ? 'Manager' : room),
  now: 43_000,
}

const seat = (name: string) => screen.getByRole('button', { name: `What ${name} is doing` })

describe('TeamBoard', () => {
  it('at rest the room’s team is on the board: each seat, and the AI it is set to run on', () => {
    const { container } = render(<TeamBoard {...base} />)
    const seats = screen.getAllByRole('button', { name: /^What .* is doing$/ })
    expect(seats.map((s) => s.getAttribute('aria-label'))).toEqual([
      'What Manager is doing',
      'What Researcher is doing',
      'What Critic is doing',
    ])
    expect(within(seat('Manager')).getByText('claude-cli · fable')).toBeInTheDocument()
    expect(within(seat('Researcher')).getByText('local · gemma')).toBeInTheDocument()
    // Nothing is running, so nothing says it is: no run line, no state, no motion.
    expect(container.querySelector('.board')).not.toHaveClass('is-live')
    expect(container.querySelector('.board__run')).toBeNull()
    expect(container.querySelector('.board__state')).toBeNull()
    expect(container.querySelector('.is-running')).toBeNull()
  })

  it('with no team, no run and nothing busy elsewhere there is no board at all', () => {
    const { container } = render(<TeamBoard {...base} roster={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says what is running and for how long — once', () => {
    render(<TeamBoard {...base} runs={[run()]} spans={[working('lead', 1)]} live />)
    expect(screen.getAllByText('compare the two plans')).toHaveLength(1)
    expect(screen.getByText('0:42')).toBeInTheDocument()
  })

  it('a seat at work says what it is doing, on the AI that answered, with its tokens', () => {
    render(
      <TeamBoard
        {...base}
        runs={[run()]}
        spans={[call('lead', 1, { attrs: { provider: 'claude-cli', model: 'opus' } }), working('researcher', 2)]}
        live
      />,
    )
    const lead = seat('Manager')
    expect(within(lead).getByText('claude-cli · opus')).toBeInTheDocument()
    expect(within(lead).getByText('answered')).toBeInTheDocument()
    expect(within(lead).getByText('140 tokens')).toBeInTheDocument()
    const researcher = seat('Researcher')
    expect(researcher).toHaveClass('is-running')
    expect(within(researcher).getByText('thinking')).toBeInTheDocument()
    // The seat that was not called keeps its place and says nothing.
    expect(seat('Critic').querySelector('.board__state')).toBeNull()
    expect(seat('Critic')).not.toHaveClass('is-running')
  })

  it('a local seat is marked as on this Mac; a cloud seat is not', () => {
    render(<TeamBoard {...base} />)
    expect(seat('Researcher')).toHaveClass('is-local')
    expect(seat('Manager')).not.toHaveClass('is-local')
  })

  it('the lead seat is set apart from the seats it leads', () => {
    render(<TeamBoard {...base} />)
    expect(seat('Manager')).toHaveClass('is-lead')
    expect(seat('Researcher')).not.toHaveClass('is-lead')
  })

  it('a turn that got no answer says so on the seat, in the engine’s own words', () => {
    render(
      <TeamBoard
        {...base}
        runs={[run()]}
        spans={[call('researcher', 1, { attrs: { is_real: false, error: 'local refused the request (HTTP 401)', tokens_in: 0, tokens_out: 0 } })]}
        live
      />,
    )
    const s = seat('Researcher')
    expect(s).toHaveClass('is-no')
    expect(within(s).getByText(/no answer — local refused the request \(HTTP 401\)/)).toBeInTheDocument()
  })

  it('packets travel only the handoff in flight', () => {
    stubReducedMotion(false)
    const { container } = render(
      <TeamBoard
        {...base}
        runs={[run()]}
        spans={[call('lead', 1), call('researcher', 2), working('critic', 3)]}
        live
      />,
    )
    expect(container.querySelectorAll('.board__link')).toHaveLength(2)
    expect(container.querySelectorAll('.board__link.is-live')).toHaveLength(1)
    expect(container.querySelectorAll('.board__packet')).toHaveLength(3)
  })

  it('the latest handoff is named: who handed to whom, at which stage', () => {
    render(
      <TeamBoard
        {...base}
        runs={[run()]}
        spans={[call('lead', 1, { attrs: { stage: 'plan' } }), working('researcher', 2, { stage: 'research' })]}
        live
      />,
    )
    expect(screen.getByRole('img', { name: 'Manager handed to Researcher: research' })).toHaveTextContent('research')
  })

  it('a run parked on the user says so, and nothing moves', () => {
    stubReducedMotion(false)
    const { container } = render(
      <TeamBoard
        {...base}
        runs={[run({ paused: true, kind: 'project', intent: 'my site' })]}
        spans={[call('lead', 1), call('researcher', 2)]}
      />,
    )
    expect(screen.getByText('waiting on you')).toBeInTheDocument()
    expect(container.querySelector('.board')).not.toHaveClass('is-live')
    expect(container.querySelectorAll('.board__packet')).toHaveLength(0)
    expect(container.querySelector('.is-running')).toBeNull()
  })

  it('with reduced motion asked for, the live link is marked and nothing travels', () => {
    stubReducedMotion(true)
    const { container } = render(
      <TeamBoard {...base} runs={[run()]} spans={[call('lead', 1), working('researcher', 2)]} live />,
    )
    expect(container.querySelectorAll('.board__link.is-live')).toHaveLength(1)
    expect(container.querySelectorAll('.board__packet')).toHaveLength(0)
  })

  it('before the engine has reported a step it says exactly that, and lights no seat', () => {
    const { container } = render(<TeamBoard {...base} runs={[run()]} live />)
    expect(screen.getByRole('status')).toHaveTextContent('working — no engine step reported yet')
    expect(container.querySelector('.is-running')).toBeNull()
  })

  it('with a second engine at work it says why no seat is lit — never "no step yet"', () => {
    const { rerender } = render(
      <TeamBoard {...base} runs={[run(), run({ id: 'r2', kind: 'manager', intent: 'a report' })]} live />,
    )
    expect(screen.getByText('compare the two plans')).toBeInTheDocument()
    expect(screen.getByText('a report')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 runs at once — their steps can’t be told apart, so no seat is lit',
    )
    // The same holds when the other run belongs to another room…
    rerender(<TeamBoard {...base} runs={[run()]} live elsewhere={[run({ id: 'beat', kind: 'heartbeat' })]} />)
    expect(screen.getByRole('status')).toHaveTextContent('2 runs at once')
    expect(screen.queryByText(/no engine step reported yet/)).not.toBeInTheDocument()
    // …or is one the room only counts for the board.
    rerender(<TeamBoard {...base} runs={[run()]} live engines={2} />)
    expect(screen.getByRole('status')).toHaveTextContent('2 runs at once')
    // …or is one AI answering a message here: its seat breathes, and the run
    // beside it still says why none of ITS steps can be shown.
    rerender(<TeamBoard {...base} runs={[run()]} live answering engines={2} />)
    expect(screen.getByRole('status')).toHaveTextContent('2 runs at once')
  })

  // Seen in the real app, 2026-11-14: a plain "hello" was said to be at work
  // three times over. The chat's bubble says the AI is thinking; here the
  // Manager's ring breathes, and no words repeat it.
  it('one AI answering a message lights the Manager’s seat — no run line, no second sentence', () => {
    const { container } = render(<TeamBoard {...base} live answering />)
    expect(seat('Manager')).toHaveClass('is-running')
    expect(container.querySelector('.board__state')).toBeNull()
    expect(container.querySelector('.board__run')).toBeNull()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers the full-window drawing while the run is live, and not for a parked one', () => {
    const { rerender } = render(
      <MemoryRouter>
        <TeamBoard {...base} runs={[run()]} spans={[working('lead', 1)]} live fullViewHref="/live" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Watch this run full window' })).toHaveAttribute('href', '/live')
    rerender(
      <MemoryRouter>
        <TeamBoard {...base} runs={[run({ paused: true })]} spans={[call('lead', 1)]} fullViewHref="/live" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: 'Watch this run full window' })).not.toBeInTheDocument()
  })

  it('a long model name is shortened on the seat, and kept whole on hover', () => {
    const long = 'Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP'
    render(<TeamBoard {...base} runs={[run()]} spans={[working('researcher', 1, { model: long })]} live />)
    const ai = seat('Researcher').querySelector('.board__ai') as HTMLElement
    expect(ai.textContent).not.toContain(long)
    expect(ai.textContent).toMatch(/^local · Qwen3\.6-35B.*…$/)
    expect(ai).toHaveAttribute('title', `local · ${long}`)
  })

  it('offers Stop for a run that can really be stopped, and asks the room to stop it', () => {
    const onStop = vi.fn()
    render(<TeamBoard {...base} runs={[run({ stoppable: true })]} spans={[working('lead', 1)]} live onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }))
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    // Asked once: it says it is stopping and cannot be pressed again.
    expect(screen.getByRole('button', { name: 'Stopping this run' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stopping this run' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('offers no Stop where it would do nothing: an unstoppable run, or one parked on the user', () => {
    const onStop = vi.fn()
    const { rerender } = render(<TeamBoard {...base} runs={[run({ kind: 'manager' })]} live onStop={onStop} />)
    expect(screen.queryByRole('button', { name: /^Stop/ })).not.toBeInTheDocument()
    rerender(<TeamBoard {...base} runs={[run({ stoppable: true, paused: true })]} onStop={onStop} />)
    expect(screen.queryByRole('button', { name: /^Stop/ })).not.toBeInTheDocument()
  })

  it('opening a seat hands the page the name the spans use for it', () => {
    const onOpenAgent = vi.fn()
    render(<TeamBoard {...base} runs={[run()]} spans={[working('lead', 1)]} live onOpenAgent={onOpenAgent} />)
    fireEvent.click(seat('Manager'))
    expect(onOpenAgent).toHaveBeenCalledWith('lead')
    // A seat with no span has no record to open.
    fireEvent.click(seat('Critic'))
    expect(onOpenAgent).toHaveBeenCalledTimes(1)
  })

  it('a room with no run of its own says where the engine is busy, and takes you there', () => {
    const onOpenRoom = vi.fn()
    const { container } = render(
      <TeamBoard
        {...base}
        elsewhere={[run({ kind: 'heartbeat', intent: 'checking in' })]}
        onOpenRoom={onOpenRoom}
      />,
    )
    expect(screen.getByText(/Busy in Manager/)).toBeInTheDocument()
    expect(screen.getByText(/checking in/)).toBeInTheDocument()
    // This room's team is still its team — and none of it is at work.
    expect(container.querySelector('.is-running')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Manager' }))
    expect(onOpenRoom).toHaveBeenCalledWith('universal')
  })
})
