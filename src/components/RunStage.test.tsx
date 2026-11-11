import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import RunStage from './RunStage'
import type { EngineSpan } from '../lib/nativeEngine'

// The stage is the run, drawn to be watched (2026-11-11). Motion is a claim:
// a packet travels a link only while that handoff's receiver is really working
// on a live run. A finished run is a still picture.
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

describe('RunStage', () => {
  it('draws nothing when no agent has taken a turn', () => {
    const { container } = render(<RunStage spans={[]} live />)
    expect(container).toBeEmptyDOMElement()
  })

  it('gives every agent a seat you can open, with its AI and what it is doing', () => {
    render(<RunStage spans={[call('lead', 1), working('researcher', 2)]} live />)
    const lead = screen.getByRole('button', { name: 'What lead is doing' })
    expect(lead).toHaveTextContent('lead')
    expect(lead).toHaveTextContent('local · gemma')
    expect(screen.getByRole('button', { name: 'What researcher is doing' })).toHaveClass('is-running')
    expect(lead).not.toHaveClass('is-running')
  })

  it('a packet travels the link while the receiver is working on a live run', () => {
    const { container } = render(<RunStage spans={[call('lead', 1), working('researcher', 2, { stage: 'research' })]} live />)
    expect(container.querySelectorAll('.stage__link')).toHaveLength(1)
    expect(container.querySelector('.stage__link')).toHaveClass('is-live')
    expect(container.querySelectorAll('.stage__packet').length).toBeGreaterThan(0)
    expect(screen.getByText('research')).toBeInTheDocument()
  })

  it('a finished run is a still picture: the link stays, nothing travels', () => {
    const { container } = render(<RunStage spans={[call('lead', 1), call('researcher', 2)]} live={false} />)
    expect(container.querySelectorAll('.stage__link')).toHaveLength(1)
    expect(container.querySelector('.stage__link')).not.toHaveClass('is-live')
    expect(container.querySelectorAll('.stage__packet')).toHaveLength(0)
  })

  it('with reduced motion asked for, the live link is marked but nothing moves', () => {
    stubReducedMotion(true)
    const { container } = render(<RunStage spans={[call('lead', 1), working('researcher', 2)]} live />)
    expect(container.querySelector('.stage__link')).toHaveClass('is-live')
    expect(container.querySelectorAll('.stage__packet')).toHaveLength(0)
  })

  it('says who is speaking now, as a sentence', () => {
    render(<RunStage spans={[call('lead', 1), working('researcher', 2)]} live />)
    const caption = screen.getByRole('status')
    expect(caption).toHaveTextContent('researcher')
    expect(caption).toHaveTextContent('local · gemma')
  })

  it('opening a seat tells the page which agent was asked about', () => {
    const onOpen = vi.fn()
    render(<RunStage spans={[call('lead', 1)]} live={false} onOpenAgent={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'What lead is doing' }))
    expect(onOpen).toHaveBeenCalledWith('lead')
  })

  it('a seat that got no answer is marked by form, not colour alone', () => {
    const noAnswer = call('writer', 3, { status: 'error', attrs: { is_real: false, error: 'HTTP 401' } })
    render(<RunStage spans={[call('lead', 1), noAnswer]} live={false} />)
    expect(screen.getByRole('button', { name: 'What writer is doing' })).toHaveClass('is-no')
  })
})
