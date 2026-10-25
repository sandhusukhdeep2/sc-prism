import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CrewBoard from './CrewBoard'
import type { EngineSpan } from '../lib/nativeEngine'

// THE GAP THIS CLOSES, in Sukhdeep's words: "when I click on that agent, I can
// see what that specific agent is working on." The crew cluster has always been
// visible and never openable — you could count your coworkers and learn nothing
// about any one of them.
//
// These assertions are about what the PAGE RENDERS after a real click, not
// about what a derivation returns; agentDossier.test.ts already pins the facts.

const call = (
  agent: string,
  over: Record<string, unknown> = {},
  span: Partial<EngineSpan> = {},
): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'ok',
  duration_ms: 9_000,
  start: 1,
  ...span,
  attrs: {
    agent,
    provider: 'local',
    model: 'Qwen3.8-27B-4bit',
    is_local: true,
    is_real: true,
    round: 1,
    tokens_in: 900,
    tokens_out: 120,
    ...over,
  },
})

/** A crew shaped like the real three-agent run: lead, researcher, critic. */
const CREW: EngineSpan[] = [
  call('lead', { provider: 'claude-cli', model: 'opus', is_local: false }, { start: 1 }),
  call('researcher', {}, { start: 2 }),
  call('critic', {}, { start: 3 }),
]

function board(spans: EngineSpan[], live = false) {
  return render(<CrewBoard spans={spans} live={live} runs={[]} />)
}

describe('clicking a coworker opens what THAT coworker is doing', () => {
  it('every coworker is openable from BOTH places they appear', () => {
    board(CREW)
    // An agent shows up twice on this board — once as a seat in the cluster,
    // once as a card in its pipeline column. Both name the same coworker, so
    // both open the same file; clicking the one you happen to be looking at is
    // the whole point.
    for (const agent of ['lead', 'researcher', 'critic']) {
      const ways = screen.getAllByRole('button', { name: new RegExp(`What ${agent} is doing`, 'i') })
      expect(ways.length, `${agent} should be openable from the cluster AND its card`).toBe(2)
    }
  })

  it('opens a panel naming that agent and the AI that really answered it', () => {
    board(CREW)
    fireEvent.click(screen.getAllByRole('button', { name: /What lead is doing/i })[0])

    const panel = screen.getByRole('dialog', { name: /What lead is doing/i })
    expect(panel).toBeInTheDocument()
    // The lead ran on the cloud CLI; the researcher's local model must not leak in.
    expect(panel.textContent).toMatch(/claude-cli · opus/)
    expect(panel.textContent).not.toMatch(/Qwen/)
  })

  it('opens the RIGHT one — a second agent’s panel shows the second agent', () => {
    board(CREW)
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    const panel = screen.getByRole('dialog', { name: /What researcher is doing/i })
    expect(panel.textContent).toMatch(/Qwen3.8-27B-4bit/)
    expect(panel.textContent).not.toMatch(/opus/)
  })

  it('quotes the ENGINE’s reason for where the work ran, verbatim', () => {
    const reason = 'vault content read -> kept local (no egress)'
    board([call('researcher', { reason })])
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toContain(reason)
  })

  it('closes on the close button and on Escape', () => {
    board(CREW)
    fireEvent.click(screen.getAllByRole('button', { name: /What critic is doing/i })[0])
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /What critic is doing/i })[0])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the panel keeps the board’s honesty rules', () => {
  it('says “working now” only when the run is REALLY live', () => {
    const open = call('researcher', {}, { status: 'running' })
    // Same open span, paused run: it must not claim to be working.
    board([open], false)
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toMatch(/Not running right now/)
  })

  it('and says it when the run genuinely is', () => {
    board([call('researcher', {}, { status: 'running' })], true)
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toMatch(/Working now/)
  })

  it('names a stand-in as a stand-in, never as an answer', () => {
    board([call('researcher', { is_real: false })])
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toMatch(/stand-in, not a real reply/)
  })

  it('a cut-off reply is labelled as cut off, not presented as the answer', () => {
    board([call('researcher', { truncated: true })])
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toMatch(/cut off at the output cap/)
  })

  it('a gate refusal reads as a refusal, NOT as a failure', () => {
    const spans: EngineSpan[] = [
      call('researcher'),
      {
        name: 'tool_exec',
        type: 'tool_exec',
        duration_ms: 12,
        attrs: { agent: 'researcher', tool: 'web_fetch', url: 'https://x.test', blocked: true, ok: false },
      },
    ]
    board(spans)
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toMatch(/refused by a gate/)
    expect(text).not.toMatch(/failed/)
  })

  it('an agent that read nothing SAYS so, rather than showing a blank section', () => {
    board([call('researcher')])
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toMatch(/read nothing on this run/)
  })

  it('claims the lock only when every turn really stayed on the Mac', () => {
    board([call('researcher', { is_local: true })])
    fireEvent.click(screen.getAllByRole('button', { name: /What researcher is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).toContain('🔒')

    fireEvent.keyDown(document, { key: 'Escape' })
    board([call('lead', { is_local: false, provider: 'claude-cli', model: 'opus' })])
    fireEvent.click(screen.getAllByRole('button', { name: /What lead is doing/i })[0])
    expect(screen.getByRole('dialog').textContent).not.toContain('🔒')
  })
})

// The board's own crew, asked to review the board, said the screen could not
// answer "is it stuck?". These assert the answer now renders.
describe('the board says how long it has been waiting', () => {
  const NOW_MS = 1_000_000_000

  const running = (startSec: number): EngineSpan => ({
    name: 'model_call',
    type: 'model_call',
    status: 'running',
    start: startSec,
    attrs: { agent: 'researcher', provider: 'local', model: 'Qwen', is_real: true, round: 1 },
  })

  it('states the gap in seconds once a step has been quiet a while', () => {
    render(<CrewBoard spans={[running(NOW_MS / 1000 - 45)]} live runs={[]} now={NOW_MS} />)
    expect(screen.getByText(/45s since the last step/)).toBeInTheDocument()
  })

  it('switches to minutes for a long wait, which is how a person waits', () => {
    render(<CrewBoard spans={[running(NOW_MS / 1000 - 240)]} live runs={[]} now={NOW_MS} />)
    expect(screen.getByText(/nothing new for 4 min/)).toBeInTheDocument()
  })

  it('says nothing at all when the run is not live', () => {
    render(<CrewBoard spans={[running(NOW_MS / 1000 - 240)]} live={false} runs={[]} now={NOW_MS} />)
    expect(screen.queryByText(/nothing new for/)).not.toBeInTheDocument()
  })

  it('never calls it stuck — the app does not know that', () => {
    render(<CrewBoard spans={[running(NOW_MS / 1000 - 900)]} live runs={[]} now={NOW_MS} />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/nothing new for 15 min/)
    expect(text).not.toMatch(/stuck|hung|frozen/i)
  })
})
