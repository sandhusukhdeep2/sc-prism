import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RunStrip from './RunStrip'
import type { EngineSpan } from '../lib/nativeEngine'
import type { LiveRun } from '../lib/liveRuns'

// The run strip (spec 2026-11-14 "The chat is the room"). One slim band above
// the chat says the three things a run has to say, once each: what is running
// and for how long, who is on it (the seats, with packets on the handoff in
// flight), and who is speaking. It replaces the Stage tab, the run card above
// the chat, the board's count line and the stage caption.
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
  elsewhere: [] as LiveRun[],
  roomName: (room: string) => (room === 'universal' ? 'Manager' : room),
  now: 43_000,
}

describe('RunStrip', () => {
  it('with nothing running here or anywhere, there is no strip at all', () => {
    const { container } = render(<RunStrip {...base} runs={[]} spans={[]} live={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says what is running and for how long — once', () => {
    render(<RunStrip {...base} runs={[run()]} spans={[working('lead', 1)]} live />)
    expect(screen.getAllByText('compare the two plans')).toHaveLength(1)
    expect(screen.getByText('0:42')).toBeInTheDocument()
  })

  it('draws a seat for each agent that took a turn, in order', () => {
    render(
      <RunStrip {...base} runs={[run()]} spans={[call('lead', 1), working('researcher', 2)]} live />,
    )
    const seats = screen.getAllByRole('button', { name: /^What .* is doing$/ })
    expect(seats.map((s) => s.getAttribute('aria-label'))).toEqual([
      'What lead is doing',
      'What researcher is doing',
    ])
  })

  it('packets travel only the handoff in flight', () => {
    stubReducedMotion(false)
    const { container } = render(
      <RunStrip
        {...base}
        runs={[run()]}
        spans={[call('lead', 1), call('researcher', 2), working('critic', 3)]}
        live
      />,
    )
    expect(container.querySelectorAll('.strip__link')).toHaveLength(2)
    expect(container.querySelectorAll('.strip__link.is-live')).toHaveLength(1)
    expect(container.querySelectorAll('.strip__packet')).toHaveLength(3)
  })

  it('says who is speaking, on which AI, in one sentence', () => {
    render(
      <RunStrip {...base} runs={[run()]} spans={[call('lead', 1), working('researcher', 2)]} live />,
    )
    const caption = screen.getByRole('status')
    expect(caption).toHaveTextContent('researcher')
    expect(caption).toHaveTextContent('local · gemma')
  })

  it('a run parked on the user says so, and nothing moves or speaks', () => {
    stubReducedMotion(false)
    const { container } = render(
      <RunStrip
        {...base}
        runs={[run({ paused: true, kind: 'project', intent: 'my site' })]}
        spans={[call('lead', 1), call('developer', 2)]}
        live={false}
      />,
    )
    expect(screen.getByText('waiting on you')).toBeInTheDocument()
    expect(container.querySelector('.strip')).not.toHaveClass('is-live')
    expect(container.querySelectorAll('.strip__packet')).toHaveLength(0)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('with reduced motion asked for, the live link is marked and nothing travels', () => {
    stubReducedMotion(true)
    const { container } = render(
      <RunStrip {...base} runs={[run()]} spans={[call('lead', 1), working('researcher', 2)]} live />,
    )
    expect(container.querySelectorAll('.strip__link.is-live')).toHaveLength(1)
    expect(container.querySelectorAll('.strip__packet')).toHaveLength(0)
  })

  it('two runs at once: each has its line, and no crew is claimed for either', () => {
    render(
      <RunStrip
        {...base}
        runs={[run(), run({ id: 'r2', kind: 'chat', intent: 'a question' })]}
        spans={[]}
        live
      />,
    )
    expect(screen.getByText('compare the two plans')).toBeInTheDocument()
    expect(screen.getByText('a question')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /is doing$/ })).not.toBeInTheDocument()
  })

  it('before the engine has reported a step it says exactly that, and draws no one', () => {
    render(<RunStrip {...base} runs={[run()]} spans={[]} live />)
    expect(screen.getByRole('status')).toHaveTextContent('working — no engine step reported yet')
    expect(screen.queryByRole('button', { name: /is doing$/ })).not.toBeInTheDocument()
  })

  it('offers the full-window drawing while the run is live, and not for a parked one', () => {
    const { rerender } = render(
      <MemoryRouter>
        <RunStrip {...base} runs={[run()]} spans={[working('lead', 1)]} live fullViewHref="/live" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Watch this run full window' })).toHaveAttribute('href', '/live')
    rerender(
      <MemoryRouter>
        <RunStrip {...base} runs={[run({ paused: true })]} spans={[call('lead', 1)]} live={false} fullViewHref="/live" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: 'Watch this run full window' })).not.toBeInTheDocument()
  })

  it('with a second engine at work it says why no crew is drawn — never "no step yet"', () => {
    const { rerender } = render(
      <RunStrip {...base} runs={[run(), run({ id: 'r2', kind: 'chat', intent: 'a question' })]} spans={[]} live />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 runs at once — their steps can’t be told apart, so no crew is drawn',
    )
    // The same holds when the other run belongs to another room.
    rerender(
      <RunStrip {...base} runs={[run()]} spans={[]} live elsewhere={[run({ id: 'beat', kind: 'heartbeat' })]} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('2 runs at once')
    expect(screen.queryByText(/no engine step reported yet/)).not.toBeInTheDocument()
  })

  it('opening a seat hands the page that agent', () => {
    const onOpenAgent = vi.fn()
    render(
      <RunStrip {...base} runs={[run()]} spans={[working('lead', 1)]} live onOpenAgent={onOpenAgent} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'What lead is doing' }))
    expect(onOpenAgent).toHaveBeenCalledWith('lead')
  })

  it('a room with no run of its own says where the engine is busy, and takes you there', () => {
    const onOpenRoom = vi.fn()
    render(
      <RunStrip
        {...base}
        runs={[]}
        spans={[]}
        live={false}
        elsewhere={[run({ kind: 'heartbeat', intent: 'checking in' })]}
        onOpenRoom={onOpenRoom}
      />,
    )
    expect(screen.getByText(/Busy in Manager/)).toBeInTheDocument()
    expect(screen.getByText(/checking in/)).toBeInTheDocument()
    // No seats: this is not this room's run to draw.
    expect(screen.queryByRole('button', { name: /is doing$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Manager' }))
    expect(onOpenRoom).toHaveBeenCalledWith('universal')
  })
})
