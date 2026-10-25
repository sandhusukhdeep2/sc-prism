// EngineConsole — the expandable STEP DETAIL on Work (region-model rebuild,
// 2026-08-18). It used to be a permanent black box at the bottom of the page
// showing the last 40 spans of the whole file; it is now opened per step and
// shows only the spans of THAT step.
//
// What it must keep proving:
//  · it renders exactly the spans it was handed and never reaches for more —
//    the "which run do these spans belong to?" question is settled upstream by
//    `currentRunSpans`, which returns [] whenever 2+ runs are in flight, so a
//    console that only ever draws its own argument can never mix two runs.
//  · a live step says it is still working; a finished step does not.
//  · a step with nothing recorded SAYS nothing was recorded, rather than
//    rendering an empty box that reads like a completed trace.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return { ...actual, isNative: () => true }
})

import { EngineConsole } from './Workspace'
import type { EngineSpan } from '../lib/nativeEngine'

const spans: EngineSpan[] = [
  {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    attrs: { agent: 'lead', provider: 'local', model: 'qwen' },
  },
  { name: 'tier1', type: 'tool_exec', status: 'ok', attrs: { passed: true } },
]

const draw = (live: boolean, list: EngineSpan[] = spans, label = 'Round 1') =>
  render(
    <MemoryRouter>
      <EngineConsole label={label} spans={list} live={live} />
    </MemoryRouter>,
  )

describe('EngineConsole — the step it was opened on, and nothing else', () => {
  it('names the step and counts its REAL spans', () => {
    draw(false)
    expect(screen.getByText(/engine steps · Round 1 \(2 spans\)/)).toBeInTheDocument()
  })

  it('renders the spans it was handed — the agent and the model that really answered', () => {
    draw(false)
    expect(screen.getByText('lead')).toBeInTheDocument()
    expect(screen.getByText('qwen')).toBeInTheDocument()
  })

  it('shows ONLY its argument — another run’s spans are unreachable from here', () => {
    // The ghost belongs to a different run. The component takes one array, so
    // there is no path by which it could appear.
    draw(false, [spans[0]])
    expect(screen.getByText('lead')).toBeInTheDocument()
    expect(screen.queryByText('ghost')).not.toBeInTheDocument()
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument()
  })

  it('a live step is marked live and says more is coming', () => {
    const { container } = draw(true)
    expect(container.querySelector('.ws__consoledot--live')).not.toBeNull()
    expect(screen.getByText(/spans appear as each phase completes/)).toBeInTheDocument()
  })

  it('a finished step is NOT marked live and invents no working line', () => {
    const { container } = draw(false)
    expect(container.querySelector('.ws__consoledot--live')).toBeNull()
    expect(screen.queryByText(/spans appear as each phase completes/)).not.toBeInTheDocument()
  })

  it('a step with nothing recorded says so — an empty box would read like a finished trace', () => {
    draw(false, [])
    expect(screen.getByText(/the engine recorded no spans for this step/)).toBeInTheDocument()
    expect(screen.getByText(/\(0 spans\)/)).toBeInTheDocument()
  })

  it('a live step with no spans YET says it is working, not that it recorded nothing', () => {
    draw(true, [])
    expect(screen.getByText(/spans appear as each phase completes/)).toBeInTheDocument()
    expect(screen.queryByText(/recorded no spans/)).not.toBeInTheDocument()
  })
})
