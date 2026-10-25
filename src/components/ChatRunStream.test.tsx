// The project-room centerpiece (Sukhdeep, 2026-08-29: "I need it in a chat,
// like a cloud coworker — which file you are accessing, which agent of which
// AI is working on it"). While a run is live in the active room, the chat
// itself carries the seat-attributed action stream — every row a real span,
// rendered by the same RunStream the stage uses (nothing invented, no second
// renderer to drift). Empty spans → nothing (never an empty shell).
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ChatRunStream from './ChatRunStream'
import { SettingsProvider } from '../lib/settings'
import type { EngineSpan } from '../lib/nativeEngine'

const seated: EngineSpan[] = [
  {
    run_id: 'r1',
    span_id: 's1',
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    duration_ms: 2100,
    attrs: {
      agent: 'researcher',
      provider: 'claude',
      model: 'sonnet',
      is_real: true,
      tokens_in: 900,
      tokens_out: 120,
    },
  } as unknown as EngineSpan,
]

describe('ChatRunStream', () => {
  it('renders the seat-attributed stream inside the chat', () => {
    render(<SettingsProvider><ChatRunStream spans={seated} /></SettingsProvider>)
    expect(screen.getByTestId('chat-run-stream')).toBeInTheDocument()
    expect(screen.getByText('researcher')).toBeInTheDocument()
    expect(screen.getByText(/every line a real recorded action/i)).toBeInTheDocument()
  })

  it('renders nothing at all for an empty run', () => {
    const { container } = render(<SettingsProvider><ChatRunStream spans={[]} /></SettingsProvider>)
    expect(container.firstChild).toBeNull()
  })
})
