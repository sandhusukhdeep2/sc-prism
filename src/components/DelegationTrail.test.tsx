import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import DelegationTrail from './DelegationTrail'
import type { EngineSpan } from '../lib/nativeEngine'

function modelCall(attrs: Record<string, unknown>, start = 1): EngineSpan {
  return { name: 'model_call', type: 'model_call', start, attrs }
}

describe('DelegationTrail — agent + which AI + what it was asked + outcome', () => {
  it('renders all four facts for every delegated step', () => {
    render(
      <DelegationTrail
        spans={[
          modelCall(
            {
              agent: 'Market scout',
              provider: 'local',
              model: 'gemma-4-26b',
              round: '1',
              is_real: true,
              tokens_out: 412,
            },
            1,
          ),
          modelCall(
            {
              agent: 'Lead',
              provider: 'claude-cli',
              model: 'opus',
              round: 'synthesis',
              is_real: true,
              tokens_out: 900,
            },
            2,
          ),
        ]}
      />,
    )
    // agent
    expect(screen.getByText('Market scout')).toBeInTheDocument()
    expect(screen.getByText('Lead')).toBeInTheDocument()
    // which AI
    expect(screen.getByText('local · gemma-4-26b')).toBeInTheDocument()
    expect(screen.getByText('claude-cli · opus')).toBeInTheDocument()
    // what it was asked
    expect(screen.getByText(/asked to contribute to the board \(round 1\)/)).toBeInTheDocument()
    // outcome
    expect(screen.getByText(/412 tokens back/)).toBeInTheDocument()
  })

  it('renders NOTHING when nothing was delegated — never an empty frame', () => {
    const { container } = render(
      <DelegationTrail spans={[modelCall({ provider: 'local', model: 'g', is_real: true })]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('says a provider was unreachable rather than showing a completed turn', () => {
    render(
      <DelegationTrail
        spans={[modelCall({ agent: 'Scout', provider: 'gemini-cli', model: 'opus', is_real: false })]}
      />,
    )
    expect(screen.getByText(/could not reach gemini-cli — nothing was sent/)).toBeInTheDocument()
    expect(screen.queryByText(/answered/)).not.toBeInTheDocument()
  })

  it('shows an open turn as still working, never as a pass', () => {
    render(<DelegationTrail spans={[modelCall({ agent: 'Scout', provider: 'local', model: 'g' })]} />)
    expect(screen.getAllByText('still working').length).toBeGreaterThan(0)
  })

  it('shows a capability the ENGINE refused — enforcement is visible', () => {
    render(
      <DelegationTrail
        spans={[
          {
            name: 'tool_exec',
            type: 'tool_exec',
            start: 3,
            attrs: {
              agent: 'Scribe',
              provider: 'web',
              tool: 'web_fetch',
              refused: true,
              reason: "Scribe was not granted the 'web' capability",
            },
          },
        ]}
      />,
    )
    expect(screen.getByText('asked to use web_fetch')).toBeInTheDocument()
    expect(screen.getByText(/was not granted the 'web' capability/)).toBeInTheDocument()
    expect(screen.getByText(/1 tool call refused by the engine/)).toBeInTheDocument()
  })

  it('changes only its heading between the live and after-the-fact views', () => {
    const spans = [modelCall({ agent: 'A', provider: 'local', model: 'g', is_real: true })]
    const { unmount } = render(<DelegationTrail spans={spans} live />)
    expect(screen.getByText('who is doing what')).toBeInTheDocument()
    unmount()
    render(<DelegationTrail spans={spans} />)
    expect(screen.getByText('who did what')).toBeInTheDocument()
  })
})
