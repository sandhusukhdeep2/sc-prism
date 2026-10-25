import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VerdictDetail from './VerdictDetail'
import { tier1Line } from '../components/VerdictCard'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import type { Tier1Result, Verdict } from '../engine/types'

// A SKIPPED Tier-1 must READ as skipped everywhere it surfaces. It is not a
// pass: the gate never ran, because this run had no project bound and therefore
// no codebase for the user's `npm test` to check. Ticks here would claim tests,
// lint and build all passed on a run that executed none of them — the silent
// pass the honesty rules ban.
const SKIP_REASON =
  'skipped — no project bound, nothing to verify. A verify command is configured, but this ' +
  'run has no project directory, so there is no codebase to run it against.'

function verdict(tier1: Tier1Result, passed = true): Verdict {
  return {
    taskId: 't-skip',
    task: 'hello, are you real?',
    route: {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via gateway',
      reason: 'default lane',
      routeLabel: 'local · qwen2.5-coder',
    },
    tier1,
    tier2: { evalScore: 0.82, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 100,
    tokensOut: 40,
    cost: 0,
    durationMs: 900,
    modelRoute: '100 tok in / 40 out',
    hooks: { passed: true, blocked: 0, fired: [] },
    writeback: { committed: true, validated: true, path: 'log.md' },
    passed,
  } as Verdict
}

function seed(v: Verdict) {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: {},
      verdicts: [v],
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

describe('VerdictDetail — a skipped Tier-1 says so', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows the engine reason instead of tests/lint/build ticks', () => {
    seed(
      verdict({
        tests: 'skipped',
        lint: false,
        build: false,
        pass: true,
        skipped: true,
        skipReason: SKIP_REASON,
      }),
    )
    renderDetail()
    const row = screen.getByText(/skipped/i, { selector: 'span' })
    expect(row.textContent).toContain('no project bound')
    expect(row.textContent).toContain('nothing to verify')
    // No tick, and no cross either — neither happened.
    expect(row.textContent).not.toContain('✓')
    expect(row.textContent).not.toContain('✕')
    expect(document.body.textContent).not.toContain('✓ tests skipped')
  })

  it('leaves a gate that really ran rendering its ticks as before', () => {
    seed(verdict({ tests: '14/14', lint: true, build: true, pass: true }))
    renderDetail()
    expect(document.body.textContent).toContain('✓ tests 14/14')
  })
})

describe('tier1Line — the Verdict card in Work / Projects', () => {
  it('renders a skip as a skip with its reason, never as a pass', () => {
    const line = tier1Line(
      { tests: 'skipped', lint: false, build: false, pass: true, skipped: true, skipReason: SKIP_REASON },
      true,
    )
    expect(line).toBe('skipped — no project bound, nothing to verify · deterministic · 0 tokens')
    expect(line).not.toContain('✓')
  })

  it('still says something honest when the reason is missing', () => {
    const line = tier1Line({ tests: 'skipped', lint: false, build: false, pass: true, skipped: true }, true)
    expect(line).toContain('nothing to verify')
    expect(line).not.toContain('✓')
  })

  it('is unchanged for a gate that ran and passed', () => {
    expect(tier1Line({ tests: '14/14', lint: true, build: true, pass: true }, true)).toBe(
      '✓ tests 14/14 ✓ lint ✓ build · deterministic · 0 tokens',
    )
  })

  it('is unchanged for a gate that ran and failed', () => {
    expect(tier1Line({ tests: '?/1', lint: false, build: false, pass: false }, false)).toBe(
      '✕ tests ?/1 · short-circuited · deterministic · 0 tokens',
    )
  })
})
