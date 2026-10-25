import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Dashboard } from '../engine/types'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Stats rendered against a dashboard shaped like the user's REAL vault: 51 runs,
// every one of them FAILING Tier-1, 75% of tokens local, and a last run that
// cost $0.00. Before the honesty pass the hero read 0 (session store), the
// breakdown read 13 (session verdicts), and the $0 sample produced
// "↓ 100% · cost floor falling".
//
// The honesty pass then over-corrected: it counted every Tier-1 FAILURE as a
// save, so the 36 runs where the gate could not run at all were laundered into
// a gold hero number. Only the 15 runs the gate genuinely ran on and blocked
// are saves; the other 36 verified nothing and get their own line.

const REAL_SHAPED: Dashboard = {
  vault: '/vault',
  runs: 51,
  run_series: [
    { run_id: 'r1', task_id: 't1', start: 1, tokens: 100, cost: 0.02, eval_score: null, passed: false, cache_hit_rate: 0, model_calls: 1 },
    { run_id: 'r2', task_id: 't2', start: 2, tokens: 100, cost: 0, eval_score: null, passed: false, cache_hit_rate: 0, model_calls: 1 },
  ],
  total_tokens: 279173,
  total_cost: 0.42,
  cost_by_model: {
    'claude-sonnet-4': { calls: 20, tokens_in: 60000, tokens_out: 9833, tokens: 69833, cost: 0.42, provider: 'claude-cli' },
    'qwen3-local': { calls: 31, tokens_in: 200000, tokens_out: 9340, tokens: 209340, cost: 0, provider: 'local' },
  },
  cost_by_operation: {},
  token_burn_by_time: {},
  hooks: {},
  eval_trend: [],
  cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
  drift: [],
  healthy: false,
  tier1: {
    runs: 51,
    ran: 51,
    passed: 0,
    failed: 51,
    skipped: 0,
    not_found: 36,
    unknown: 0,
    blocked: 15,
    caught: { tests: 15, lint: 0, build: 0, other: 0 },
    judged_runs: 0,
    avg_judge_tokens: 0,
  },
}

vi.mock('../lib/nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    nativeDashboard: async () => REAL_SHAPED,
    readNativeDashboard: async () => ({ kind: 'ok', dash: REAL_SHAPED }),
  }
})

const { default: Stats } = await import('./Stats')

function renderStats() {
  return render(
    <MemoryRouter initialEntries={['/stats']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Stats />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Stats against a real-shaped dashboard', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows the engine’s 15 genuinely blocked runs, not the session store’s 0 — and not all 51', async () => {
    renderStats()
    await screen.findByText(/all engine runs/)
    expect(document.querySelector('.stats__hero-num')!.textContent).toBe('15')
  })

  it('attributes the breakdown from engine data and flags the unrunnable verify command', async () => {
    renderStats()
    expect(
      await screen.findByText(/36 runs could not run the verify command — nothing was verified/),
    ).toBeInTheDocument()
  })

  it('refuses to price avoided eval tokens with no judged run', async () => {
    renderStats()
    expect(await screen.findByText('no judged run yet to price a save')).toBeInTheDocument()
  })

  it('never turns a $0.00 last run into a "cost floor falling" victory', async () => {
    renderStats()
    await screen.findByText(/all engine runs/)
    expect(document.body.textContent).not.toMatch(/cost floor falling/)
    expect(document.body.textContent).not.toMatch(/↓ 100%/)
    expect(screen.getByText(/no trend can be read from it/)).toBeInTheDocument()
  })

  it('labels the token-share bar with token share, not a cost it does not measure', async () => {
    renderStats()
    // 209,340 of 279,173 tokens are local = 75%.
    expect(await screen.findByText('local 75%')).toBeInTheDocument()
    expect(screen.getByText('cloud 25%')).toBeInTheDocument()
    // The old label put a $0.00 cost inside the 75%-wide local segment.
    expect(document.querySelector('.stats__seg--local')!.textContent).not.toMatch(/\$/)
  })
})
