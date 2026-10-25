import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VerdictDetail from './VerdictDetail'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import type { Verdict } from '../engine/types'

/**
 * The verdict detail page, three-valued (owed follow-up #1 to dc4124e).
 *
 * ATTENTION = the deterministic Tier-1 gate ran the project's checks over real
 * written files and PASSED, and only the Tier-2 LLM reviewer dissented. The
 * page's two badges used to be booleans off `passed`, which filed that run
 * under the same "⚠ REVIEW / ✕ NOT PASSED" as a run whose tests actually broke.
 */

const ATTENTION_REASON =
  'tests passed, reviewer dissented — the deterministic tier-1 gate ran `npm test` against 6 written file(s) ' +
  'and PASSED, but the tier-2 reviewer scored 0.5 below its 0.7 threshold. This run is NOT a failure: the work ' +
  'exists and its checks pass. It needs a look, not a redo.'

const CONTRADICTION =
  'judge claimed "the produced artifact is truncated, failing to provide the actual implementation or the ' +
  'required files" over 6 file(s) measured on disk behind a passing tier-1 gate'

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 'A-1042',
    task: 'build the todo CLI',
    route: {
      target: 'cloud',
      model: 'claude-opus',
      via: 'via Bifrost',
      reason: 'reasoning load',
      routeLabel: 'internal → cloud · claude-opus',
    },
    tier1: { tests: '11/11', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.5, passed: false, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 1200,
    tokensOut: 380,
    cost: 0.012,
    durationMs: 4200,
    modelRoute: '1,200 tok in / 380 out',
    hooks: { passed: true, blocked: 0 },
    writeback: { committed: false, validated: false, path: 'log.md' },
    passed: false,
    ...over,
  } as Verdict
}

function seed(verdicts: Verdict[]) {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: {},
      verdicts,
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
    }),
  )
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/verdict']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <VerdictDetail />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('VerdictDetail — the three outcomes read differently', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('ATTENTION: amber badges that name WHICH tier objected', () => {
    seed([verdict({ outcome: 'attention', outcomeReason: ATTENTION_REASON })])
    const { container } = renderDetail()

    const badge = container.querySelector('.vd__badge')
    expect(badge?.textContent).toBe('⚠ NEEDS A LOOK')
    expect(badge?.className).toMatch(/vd__badge--attention/)

    const trail = container.querySelector('.vd__trailbadge')
    expect(trail?.textContent).toBe('⚠ CHECKS PASSED · REVIEWER DISSENTED')
    expect(trail?.className).toMatch(/vd__trailbadge--attention/)

    // Never the old flat verdicts.
    expect(screen.queryByText('✕ NOT PASSED')).not.toBeInTheDocument()
    expect(screen.queryByText('✓ VERIFIED')).not.toBeInTheDocument()
  })

  it('ATTENTION: the engine’s own reason is shown, verbatim', () => {
    seed([verdict({ outcome: 'attention', outcomeReason: ATTENTION_REASON })])
    renderDetail()
    expect(screen.getByText('Outcome')).toBeInTheDocument()
    expect(screen.getByText(ATTENTION_REASON)).toBeInTheDocument()
  })

  it('PASSED: the gold pass badges, unchanged', () => {
    seed([
      verdict({
        passed: true,
        outcome: 'passed',
        tier2: { evalScore: 0.91, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
      }),
    ])
    const { container } = renderDetail()
    expect(container.querySelector('.vd__badge')?.textContent).toBe('✓ VERIFIED')
    expect(container.querySelector('.vd__badge')?.className).not.toMatch(/attention|fail/)
    expect(container.querySelector('.vd__trailbadge')?.textContent).toBe('✓ PASSED')
  })

  it('FAILED: the fail badges, and nothing amber', () => {
    seed([verdict({ outcome: 'failed', outcomeReason: 'tier-1 failed; no files were produced' })])
    const { container } = renderDetail()
    expect(container.querySelector('.vd__badge')?.textContent).toBe('⚠ REVIEW')
    expect(container.querySelector('.vd__badge')?.className).toMatch(/vd__badge--fail/)
    expect(container.querySelector('.vd__trailbadge')?.textContent).toBe('✕ NOT PASSED')
    expect(container.querySelector('.vd__badge--attention')).toBeNull()
  })

  it('the run picker gives attention its own mark, not the failure ✕', () => {
    seed([
      verdict({ taskId: 'A-1', outcome: 'attention' }),
      verdict({ taskId: 'A-2', outcome: 'failed' }),
      verdict({ taskId: 'A-3', passed: true, outcome: 'passed' }),
    ])
    const { container } = renderDetail()
    const chips = [...container.querySelectorAll('.vd__pick')].map((c) => c.textContent)
    expect(chips).toEqual(['⚠ #A-1', '✕ #A-2', '✓ #A-3'])
    expect(container.querySelector('.vd__pick--attention')).not.toBeNull()
  })
})

describe('VerdictDetail — a judge contradiction reaches the user', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('names the disproved claim and what it means for the score', () => {
    seed([
      verdict({
        outcome: 'attention',
        outcomeReason: ATTENTION_REASON,
        tier2: {
          evalScore: 0.5,
          passed: false,
          judge: 'DeepEval judge',
          trajectory: 'trajectory ok',
          contradictions: [CONTRADICTION],
        },
      }),
    ])
    renderDetail()
    expect(screen.getByText('Judge contradiction')).toBeInTheDocument()
    expect(document.body.textContent).toContain(CONTRADICTION)
    expect(document.body.textContent).toContain('score is unreliable for this run')
  })

  it('shows no contradiction row when the engine recorded none', () => {
    seed([verdict({ outcome: 'attention', outcomeReason: ATTENTION_REASON })])
    renderDetail()
    expect(screen.queryByText('Judge contradiction')).not.toBeInTheDocument()
  })
})

describe('VerdictDetail — an OLD verdict renders exactly as before', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('a non-pass with NO `outcome` keeps its original badges and gains no rows', () => {
    const legacy = verdict()
    expect(legacy.outcome).toBeUndefined()
    seed([legacy])
    const { container } = renderDetail()
    expect(container.querySelector('.vd__badge')?.textContent).toBe('⚠ REVIEW')
    expect(container.querySelector('.vd__trailbadge')?.textContent).toBe('✕ NOT PASSED')
    // No back-filled attention, no invented explanation.
    expect(container.querySelector('.vd__badge--attention')).toBeNull()
    expect(screen.queryByText('Outcome')).not.toBeInTheDocument()
    expect(screen.queryByText('Judge contradiction')).not.toBeInTheDocument()
  })

  it('a legacy PASS keeps its original badges', () => {
    seed([
      verdict({
        passed: true,
        tier2: { evalScore: 0.91, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
      }),
    ])
    const { container } = renderDetail()
    expect(container.querySelector('.vd__badge')?.textContent).toBe('✓ VERIFIED')
    expect(container.querySelector('.vd__trailbadge')?.textContent).toBe('✓ PASSED')
  })
})
