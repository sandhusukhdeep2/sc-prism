import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VerdictCard, { attemptLine, toVerdictView } from './VerdictCard'
import type { Verdict } from '../engine/types'

/**
 * F1, the surface half — attempt N has to be visible where a user looks.
 *
 * A verified refine loop's whole claim is that attempt 2 improves on attempt 1.
 * The engine keeps both verdicts and links them; if the card renders them
 * identically, the product still cannot show whether refining did anything.
 *
 * The complementary rule matters just as much: a run with no recorded attempt
 * says NOTHING. Labelling it "attempt 1" would manufacture history for runs that
 * were never part of a refine loop at all.
 */
function engineVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 'build-a-small-node-cli-called-vault-dige-ff759f1b',
    task: 'build a small node CLI called vault-digest',
    route: {
      target: 'cloud',
      model: 'claude-opus',
      via: 'via Bifrost',
      reason: 'reasoning load',
      routeLabel: 'internal → cloud · claude-opus',
    },
    tier1: { tests: '2/6', lint: true, build: true, pass: false },
    tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
    tokensIn: 12000,
    tokensOut: 0,
    cost: 0.04,
    durationMs: 61000,
    modelRoute: '12,000 tok in / 0 out',
    hooks: { blocked: 1, passed: false },
    writeback: { path: 'verdicts/build-a-small-node-cli-called-vault-dige-ff759f1b.json', validated: false, committed: false },
    passed: false,
    outcome: 'failed',
    ...over,
  }
}

function renderCard(v: Verdict) {
  return render(
    <MemoryRouter>
      <VerdictCard v={toVerdictView(v)} />
    </MemoryRouter>,
  )
}

describe('VerdictCard — attempt history', () => {
  it('names the refine attempt and says what it came from', () => {
    renderCard(
      engineVerdict({
        attempt: { number: 2, group: 'p1:step-0', isRefine: true, previousTaskId: 'x-aaaa1111' },
      }),
    )
    expect(screen.getByText('Attempt')).toBeTruthy()
    expect(
      screen.getByText(/attempt 2 · refined after the previous attempt failed verification/),
    ).toBeTruthy()
  })

  it('marks the first try as the first try', () => {
    expect(
      attemptLine(engineVerdict({ attempt: { number: 1, group: 'p1:step-0', isRefine: false } })),
    ).toBe('attempt 1 · first try')
  })

  it('says nothing at all for an untracked run — no invented "attempt 1"', () => {
    const v = engineVerdict()
    expect(attemptLine(v)).toBeUndefined()
    const { container } = renderCard(v)
    expect(container.textContent).not.toContain('Attempt')
    expect(container.textContent).not.toContain('attempt')
  })
})
