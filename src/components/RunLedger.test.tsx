// RULE 7, rendered: every number under the conversation is measured, and an
// empty week SAYS SO rather than drawing a hollow arc.
//
// These tests assert what the PANEL RENDERS, not what a store holds — the
// agent-stats lie of 2026-08-14 survived 56 green tests precisely because every
// one of them checked the stored field instead of the rendered text.
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import RunLedger from './RunLedger'
import type { Verdict } from '../engine/types'

const NOW = Date.parse('2026-08-18T12:00:00Z')

const verdict = (over: Partial<Verdict>): Verdict =>
  ({ passed: true, task: 'a recorded run', ...over }) as Verdict

const draw = (p: Partial<Parameters<typeof RunLedger>[0]> = {}) =>
  render(<RunLedger verdicts={[]} now={NOW} {...p} />)

describe('rule 7 — recent runs are real rows with real outcomes', () => {
  it('with no runs at all, the whole ledger is one quiet line (UI pass 2026-08-29)', () => {
    draw()
    expect(screen.getByText(/no runs yet — your first run's story lands here/)).toBeInTheDocument()
    expect(document.querySelector('.ledger__row')).toBeNull()
    expect(document.querySelector('.ledger__panel')).toBeNull()
  })

  it('a row shows the verdict’s own task, outcome and MEASURED duration', () => {
    draw({
      verdicts: [
        verdict({
          taskId: 'v1',
          task: 'Weekly vault digest',
          at: '2026-08-17T10:00:00Z',
          outcome: 'passed',
          durationMs: 64_000,
          route: { target: 'local' },
        } as Partial<Verdict>),
      ],
    })
    const runs = within(screen.getByLabelText('Recent runs'))
    expect(runs.getByText('Weekly vault digest')).toBeInTheDocument()
    expect(runs.getByText('passed')).toBeInTheDocument()
    // 64_000ms of RECORDED duration — nothing rounded up or guessed
    expect(runs.getByText(/1:04/)).toBeInTheDocument()
    expect(runs.getByText(/local/)).toBeInTheDocument()
  })

  it('a run that needed a look says so — never rounded up to a pass', () => {
    draw({
      verdicts: [
        verdict({
          taskId: 'v2',
          task: 'Compliance sweep',
          at: '2026-08-17T10:00:00Z',
          passed: false,
          outcome: 'attention',
        } as Partial<Verdict>),
      ],
    })
    const runs = within(screen.getByLabelText('Recent runs'))
    expect(runs.getByText('needed a look')).toBeInTheDocument()
    expect(runs.queryByText('passed')).toBeNull()
  })

  it('a verdict with nothing else recorded carries NO meta line rather than an invented one', () => {
    draw({ verdicts: [verdict({ taskId: 'v3', task: 'Bare run', at: '2026-08-17T10:00:00Z' })] })
    expect(screen.getByText('Bare run')).toBeInTheDocument()
    expect(document.querySelector('.ledger__rowmeta')).toBeNull()
  })

  it('states plainly that nothing on the panel is an estimate', () => {
    // The no-estimate line rides the real panels, which need at least one run.
    draw({ verdicts: [verdict({ taskId: 'v-any', outcome: 'passed' })] })
    expect(
      screen.getByText('Every row is a real run. Nothing here is an estimate.'),
    ).toBeInTheDocument()
  })
})

describe('rule 7 — the arcs, and the week that has nothing in it', () => {
  it('an EMPTY week (with runs on the books) says so and draws NO arc', () => {
    // A timestampless run keeps the panels visible while the week stays empty.
    draw({ verdicts: [verdict({ taskId: 'v-old', outcome: 'passed' })] })
    expect(screen.getByText(/no timed runs this week/)).toBeInTheDocument()
    expect(document.querySelector('.ledger__donut')).toBeNull()
  })

  it('verdicts with no timestamp cannot be placed in a week — reported, never drawn', () => {
    draw({ verdicts: [verdict({ taskId: 'v4', outcome: 'passed' })] })
    expect(screen.getByText(/1 earlier run carries no timestamp/)).toBeInTheDocument()
    expect(document.querySelector('.ledger__donut')).toBeNull()
  })

  it('draws the arcs from dated verdicts, counting the engine’s own outcomes', () => {
    draw({
      verdicts: [
        verdict({ taskId: 'a', at: '2026-08-17T10:00:00Z', passed: true, outcome: 'passed' }),
        verdict({ taskId: 'b', at: '2026-08-17T11:00:00Z', passed: true, outcome: 'passed' }),
        verdict({ taskId: 'c', at: '2026-08-16T11:00:00Z', passed: false, outcome: 'attention' }),
        verdict({ taskId: 'd', at: '2026-08-15T11:00:00Z', passed: false, outcome: 'failed' }),
      ],
    })
    expect(screen.getByRole('img', { name: '2 passed' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '2 needed a look' })).toBeInTheDocument()
    // the sweep is the real ratio (2 of 4), not a decorative fill
    const donut = document.querySelector('.ledger__donut') as HTMLElement
    expect(donut.style.getPropertyValue('--sweep')).toBe('50%')
  })

  it('a run OUTSIDE the week is not padded into this week’s arc', () => {
    draw({ verdicts: [verdict({ taskId: 'old', at: '2026-07-01T10:00:00Z', outcome: 'passed' })] })
    expect(document.querySelector('.ledger__donut')).toBeNull()
    expect(screen.getByText('no runs recorded this week yet')).toBeInTheDocument()
  })

  it('the footer states measured stats only once there is something measured', () => {
    // With runs on the books but nothing measured-today, the footer still
    // refuses to claim spend (same rule, has-runs path).
    draw({ verdicts: [verdict({ taskId: 'v-old2', outcome: 'passed' })] })
    expect(screen.getByText(/nothing spent on cloud today/)).toBeInTheDocument()

    // Spend TODAY is derived from the SAME verdicts the panels read — a run
    // dated today with a real cost is the only thing that may claim spend.
    draw({
      verdicts: [
        verdict({ taskId: 'z', at: '2026-08-18T10:00:00Z', outcome: 'passed', cost: 0.42 }),
      ],
    })
    expect(
      screen.getByText(/0% of runs ran on your own Mac · \$0\.42 spent on cloud today/),
    ).toBeInTheDocument()
  })

  it("yesterday's spend is not laundered into 'today'", () => {
    draw({
      verdicts: [
        verdict({ taskId: 'y', at: '2026-08-17T10:00:00Z', outcome: 'passed', cost: 0.42 }),
      ],
    })
    expect(screen.getByText(/nothing spent on cloud today/)).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.42/)).toBeNull()
  })
})

// A REPLIED chat turn (engine outcome 'replied') is conversation, not work.
// The live bug: every Work-page chat message was judged as a write task, and
// good replies filled this very panel with red "failed" badges and skip-reason
// noise. A replied row wears its own neutral tag, carries no check line, and
// is folded into NEITHER weekly arc.
describe('a replied chat turn renders as conversation, not as judged work', () => {
  const replied = (over: Partial<Verdict> = {}) =>
    verdict({
      taskId: 'chat-1',
      task: 'Create a wordpress theme like moppers slashcreative',
      at: '2026-08-17T10:00:00Z',
      passed: true,
      outcome: 'replied',
      ...over,
    } as Partial<Verdict>)

  it('wears the neutral tag — never the coral non-pass treatment', () => {
    draw({ verdicts: [replied()] })
    const runs = within(screen.getByLabelText('Recent runs'))
    const tag = runs.getByText('replied')
    expect(tag.className).toContain('ledger__tag--said')
    expect(tag.className).not.toContain('ledger__tag--att')
  })

  it('carries NO check line — a chat never had checks to skip', () => {
    draw({
      verdicts: [
        replied({
          tier1: { skipped: true, skipReason: 'skipped — no project bound, nothing to verify.' },
        } as Partial<Verdict>),
      ],
    })
    expect(document.body.textContent).not.toMatch(/checks skipped/)
  })

  it('is folded into NEITHER weekly arc', () => {
    draw({
      verdicts: [
        verdict({ taskId: 'w1', at: '2026-08-17T09:00:00Z', passed: true, outcome: 'passed' }),
        replied({ taskId: 'w2' }),
      ],
    })
    expect(screen.getByRole('img', { name: '1 passed' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '0 needed a look' })).toBeInTheDocument()
  })

  it('a week of only replies says what it holds instead of "no runs recorded"', () => {
    draw({ verdicts: [replied()] })
    expect(screen.queryByText('no runs recorded this week yet')).toBeNull()
    expect(screen.getByText(/1 chat reply/)).toBeInTheDocument()
    // No arc is drawn from conversation alone — a ring at zero task runs
    // would still look like a measurement of work.
    expect(document.querySelector('.ledger__donut')).toBeNull()
  })
})

// The bug this component was rebuilt to make impossible: the two panels used to
// read DIFFERENT sources — session-only finished runs on the left, persisted
// verdicts on the right — so the app rendered "no runs yet" directly beside
// "1 passed · 14 needed a look". One array in means they can never disagree.
describe('one source — the two panels cannot contradict each other', () => {
  it('a week with counted runs can never sit beside "no runs yet"', () => {
    draw({
      verdicts: Array.from({ length: 15 }, (_, i) =>
        verdict({
          taskId: `r${i}`,
          at: '2026-08-17T10:00:00Z',
          passed: i === 0,
          outcome: i === 0 ? 'passed' : 'attention',
        }),
      ),
    })
    expect(screen.queryByText(/no runs yet/)).toBeNull()
    expect(screen.getByRole('img', { name: '1 passed' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '14 needed a look' })).toBeInTheDocument()
    expect(document.querySelectorAll('.ledger__row').length).toBeGreaterThan(0)
  })

  it('and a runless ledger is the single line — no half-empty pair of panels', () => {
    draw()
    expect(screen.getByText(/no runs yet — your first run's story lands here/)).toBeInTheDocument()
    expect(screen.queryByText('no runs recorded this week yet')).not.toBeInTheDocument()
  })

  // THE SCREENSHOT OF 2026-08-28: 'This week — no runs recorded this week yet'
  // sat directly above '$0.45 spent on cloud today'. The card was honest; the
  // footer read a persisted all-time accumulator that nothing ever reset —
  // 'today' was decoration. The footer now derives from the same array as the
  // card, so the two are structurally incapable of contradicting each other.
  it('an empty week can never sit above a claim of spend today', () => {
    draw({
      verdicts: Array.from({ length: 3 }, (_, i) =>
        verdict({
          taskId: `old${i}`,
          at: '2026-08-01T10:00:00Z',
          outcome: 'passed',
          cost: 0.15,
        }),
      ),
    })
    expect(screen.getByText('no runs recorded this week yet')).toBeInTheDocument()
    expect(screen.getByText(/nothing spent on cloud today/)).toBeInTheDocument()
    expect(screen.queryByText(/\$\d/)).toBeNull()
  })
})

// Sukhdeep's design note draws Recent runs as a TABLE — Task, Outcome, Checks,
// Ran on, Took. The row already carried exactly those five facts; only the
// shape was missing. The caller picks the shape, because the caller is what
// knows how much room it is giving this component.
describe('Recent runs takes the shape its caller has room for', () => {
  it('draws a real table with headers when asked for a row', () => {
    draw({ verdicts: [verdict({ task: 'Weekly vault digest' })], layout: 'row' })
    expect(screen.getByRole('table')).toBeInTheDocument()
    for (const h of ['Task', 'Outcome', 'Checks', 'Ran on', 'Took']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument()
    }
  })

  it('stacks into a list in a rail, where five columns would truncate every one', () => {
    draw({ verdicts: [verdict({ task: 'Weekly vault digest' })] })
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(document.querySelector('.ledger__rows')).toBeTruthy()
  })

  it('renders ONE shape, never both — two would read every run twice aloud', () => {
    const { container } = draw({
      verdicts: [verdict({ task: 'Weekly vault digest' })],
      layout: 'row',
    })
    expect(container.querySelectorAll('.ledger__rows')).toHaveLength(0)
    expect(screen.getAllByText('Weekly vault digest')).toHaveLength(1)
  })

  it('an unrecorded column is an em dash, never an invented check', () => {
    draw({ verdicts: [verdict({ task: 'bare run' })], layout: 'row' })
    // The fixture records no checks/route/duration, so those cells say nothing.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

// UI pass (2026-08-29, first-user walk): a brand-new install rendered TWO
// large ledger panels for nothing — empty chrome dominating the page. With
// zero verdicts the whole ledger is ONE quiet line; the full panels appear
// with the first real run.
describe('a runless ledger collapses to one line', () => {
  it('renders a single compact line and no panel headings', () => {
    draw()
    expect(screen.getByText(/no runs yet — your first run's story lands here/i)).toBeInTheDocument()
    expect(screen.queryByText(/recent runs/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/this week/i)).not.toBeInTheDocument()
  })
})

// Audit fix (2026-08-30): the footer's local-share % was an accumulator PROP
// while every other number derives from `verdicts` — the file's own ONE
// SOURCE rule, broken in its own footer (demo seed: '61%' beside one run).
// Now it derives: count of route.target==='local' over the total.
describe('the footer derives local share from the same verdicts', () => {
  it('one local run of two shows 50%, whatever any prop claims', () => {
    draw({
      verdicts: [
        verdict({ taskId: 'l1', at: '2026-08-18T10:00:00Z', outcome: 'passed', route: { target: 'local' } as never }),
        verdict({ taskId: 'c1', at: '2026-08-18T11:00:00Z', outcome: 'passed', route: { target: 'cloud' } as never }),
      ],
    })
    expect(screen.getByText(/50% of runs ran on your own Mac/)).toBeInTheDocument()
    expect(screen.queryByText(/61%/)).not.toBeInTheDocument()
  })
})
