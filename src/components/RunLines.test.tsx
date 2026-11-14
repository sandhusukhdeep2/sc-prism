import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RunLines, { OutcomeStrip, TurnLines } from './RunLines'
import type { OutcomeView, RunLine, SeatTurn } from '../lib/runLines'

// THE WORK, IN THE CHAT (spec 2026-11-14 "Visible agents"): a run is written
// as seat-attributed lines — who · on which AI · what it did — and closed by
// one outcome strip. These draw what lib/runLines.ts derived, and derive
// nothing themselves.
const line = (over: Partial<RunLine> = {}): RunLine => ({
  key: 'k',
  who: 'Researcher',
  ai: 'local · gemma-3',
  local: true,
  text: 'read notes/brief.md · answered',
  tone: 'plain',
  chips: [],
  ...over,
})

describe('RunLines', () => {
  it('with no lines it draws nothing', () => {
    const { container } = render(<RunLines lines={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('each line says who, on which AI, and what it did', () => {
    render(<RunLines lines={[line(), line({ key: 'm', who: 'Manager', ai: 'claude-cli · fable', local: false, text: 'answered' })]} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Researcher')).toBeInTheDocument()
    expect(within(rows[0]).getByText('local · gemma-3')).toBeInTheDocument()
    expect(within(rows[0]).getByText('read notes/brief.md · answered')).toBeInTheDocument()
    expect(within(rows[1]).getByText('claude-cli · fable')).toBeInTheDocument()
  })

  it('a long model name is shortened on the line, and kept whole on hover', () => {
    const long = 'Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP'
    render(<RunLines lines={[line({ ai: `local · ${long}` })]} />)
    const ai = document.querySelector('.rl__ai') as HTMLElement
    expect(ai.textContent).not.toContain(long)
    expect(ai).toHaveAttribute('title', `local · ${long}`)
  })

  it('a seat at work, a warning and a chip are marked as what they are', () => {
    render(
      <RunLines
        lines={[
          line({ key: 'a', tone: 'live', text: 'thinking' }),
          line({ key: 'b', tone: 'warn', text: 'no answer — local refused the request (HTTP 401)' }),
          line({ key: 'c', chips: [{ text: 'stayed local', kind: 'local' }, { text: '1 blocked by your rules', kind: 'warn' }] }),
        ]}
      />,
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveClass('is-live')
    expect(rows[1]).toHaveClass('is-warn')
    expect(within(rows[2]).getByText('stayed local')).toHaveClass('rl__chip--local')
    expect(within(rows[2]).getByText('1 blocked by your rules')).toHaveClass('rl__chip--warn')
  })

  it('a long run shows its latest lines, and keeps the earlier ones one click away', () => {
    const many = Array.from({ length: 14 }, (_, i) => line({ key: `k${i}`, text: `step ${i + 1}` }))
    render(<RunLines lines={many} />)
    // The latest eight are on screen…
    expect(screen.getByText('step 14')).toBeVisible()
    expect(screen.getByText('step 7')).toBeVisible()
    // …and the six before them are folded under one line that says how many.
    const earlier = screen.getByText('6 earlier steps')
    expect(earlier.closest('details')).not.toHaveAttribute('open')
    expect(within(earlier.closest('details')!).getByText('step 1')).toBeInTheDocument()
  })
})

const turn = (over: Partial<SeatTurn> = {}): SeatTurn => ({
  id: 't1',
  kind: 'seat',
  agent: 'researcher',
  provider: 'local',
  model: 'gemma-3',
  text: 'Solar panels convert light to current.\n\nThe second paragraph, in full.',
  ...over,
})

describe('TurnLines — what each seat contributed, from the saved board', () => {
  it('each turn is one line, and the whole turn opens from it exactly as written', () => {
    render(<TurnLines turns={[turn(), turn({ id: 't2', agent: 'lead', provider: 'claude-cli', model: 'fable', text: 'A plan.' })]} />)
    const rows = document.querySelectorAll('details.rl__turn')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Researcher')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Manager')).toBeInTheDocument()
    expect(rows[0]).not.toHaveAttribute('open')
    // The record is all there, behind the line.
    expect(within(rows[0] as HTMLElement).getByText('The second paragraph, in full.')).toBeInTheDocument()
  })

  it('no turns, nothing drawn', () => {
    const { container } = render(<TurnLines turns={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  // The owner's reference for a chat (2026-11-12): a run's working-out must
  // not bury its answer. A long record keeps its latest turns on screen and
  // folds the earlier ones under one line — all of them still there.
  it('a long record shows its latest turns, and folds the earlier ones under one line', () => {
    const many = Array.from({ length: 9 }, (_, i) => turn({ id: `t${i}`, text: `turn ${i + 1}` }))
    render(<TurnLines turns={many} />)
    const earlier = screen.getByText('3 earlier turns').closest('details')!
    expect(earlier).not.toHaveAttribute('open')
    expect(earlier.querySelectorAll('details.rl__turn')).toHaveLength(3)
    // Six on screen, outside the fold.
    const shown = [...document.querySelectorAll('details.rl__turn')].filter((d) => !earlier.contains(d))
    expect(shown).toHaveLength(6)
  })
})

const outcome = (over: Partial<OutcomeView> = {}): OutcomeView => ({
  tone: 'passed',
  head: '✓ routed → verified → written',
  chips: [
    { text: 'checks: 12/12 tests passed', kind: 'plain' },
    { text: 'stayed local', kind: 'local' },
  ],
  cost: '$0 cloud · 7.5k tokens',
  ...over,
})

describe('OutcomeStrip — a run’s result, once', () => {
  it('says the outcome, what each check said, and what it cost', () => {
    render(<OutcomeStrip o={outcome()} />)
    const strip = screen.getByRole('group', { name: 'How this run ended' })
    expect(strip).toHaveClass('outcome--passed')
    expect(within(strip).getByText('✓ routed → verified → written')).toBeInTheDocument()
    expect(within(strip).getByText('checks: 12/12 tests passed')).toBeInTheDocument()
    expect(within(strip).getByText('stayed local')).toHaveClass('rl__chip--local')
    expect(within(strip).getByText('$0 cloud · 7.5k tokens')).toBeInTheDocument()
  })

  it('carries the engine’s reason when the run did not simply pass', () => {
    render(<OutcomeStrip o={outcome({ tone: 'attention', head: '⚠ needs a look', why: 'the reviewer was not satisfied' })} />)
    expect(screen.getByRole('group', { name: 'How this run ended' })).toHaveClass('outcome--attention')
    expect(screen.getByText('the reviewer was not satisfied')).toBeInTheDocument()
  })

  it('links to the full record when there is one', () => {
    render(
      <MemoryRouter>
        <OutcomeStrip o={outcome()} to="/verdict" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Open the full record of this run' })).toHaveAttribute('href', '/verdict')
  })

  it('a file the result names is revealed by its own name', () => {
    const onReveal = vi.fn()
    render(<OutcomeStrip o={outcome({ path: '/vault/agents/board-r1.jsonl' })} onReveal={onReveal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal board-r1.jsonl' }))
    expect(onReveal).toHaveBeenCalledWith('/vault/agents/board-r1.jsonl')
  })
})
