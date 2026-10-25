import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Dashboard } from '../engine/types'
import type { EngineSpan } from '../lib/nativeEngine'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Finding 2 (2026-08-09 honesty pass). Ground truth from the user's live vault:
// the engine measured 209,340 local tokens of 279,173 = 75% local, while the
// Memory page rendered "local now handles 0% of routine work" from session
// verdict routing — the OPPOSITE of the truth. The budget gauge compared
// cumulative session tokens against a per-injection cap and so read "over cap !"
// forever, and four of its five ramp bars were hardcoded (14/22/32/42).

const REAL_SHAPED: Dashboard = {
  vault: '/vault',
  runs: 51,
  run_series: [],
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

// A REAL memory retrieval span, exactly as loop.py writes it (mem_s.set).
const MEMORY_SPAN: EngineSpan = {
  name: 'memory',
  type: 'retrieval',
  status: 'ok',
  start: 1,
  attrs: { session_id: 's', budget: 8000, injected: 3, injected_tokens: 1450 },
}

vi.mock('../lib/nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    nativeDashboard: async () => REAL_SHAPED,
    readNativeDashboard: async () => ({ kind: 'ok', dash: REAL_SHAPED }),
    readSpansTail: async () => [MEMORY_SPAN],
    runNativeOkf: async () => null,
  }
})

const { default: Memory, memInjection } = await import('./Memory')

function renderMemory() {
  return render(
    <MemoryRouter initialEntries={['/memory']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Memory />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Memory reports the ENGINE measurement, not session routing', () => {
  it('reads local share off the dashboard: 75%, never 0%', async () => {
    renderMemory()
    await waitFor(() => expect(screen.getByText(/local handles 75%/)).toBeInTheDocument())
    expect(document.body.textContent).not.toMatch(/local (now )?handles 0%/)
  })

  it('says WHICH scope the share is: engine-measured model calls, not the session', async () => {
    renderMemory()
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/measured by the engine over every recorded run/),
    )
    expect(document.body.textContent).toMatch(/209,340 local · 69,833 cloud tokens/)
  })

  it('has no hardcoded w1-w4 ramp bars left', async () => {
    const { container } = renderMemory()
    await waitFor(() => expect(screen.getByText(/local handles 75%/)).toBeInTheDocument())
    for (const label of ['w1', 'w2', 'w3', 'w4']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    expect(container.querySelector('.bar__local')).toBeNull()
  })

  it('draws the budget gauge from the REAL memory span attrs (1,450 of 8,000, under cap)', async () => {
    const { container } = renderMemory()
    await waitFor(() => expect(screen.getByText('1,450')).toBeInTheDocument())
    expect(screen.getByText(/\/ 8,000 tokens injected/)).toBeInTheDocument()
    expect(screen.getByText('under cap ✓')).toBeInTheDocument()
    const fill = container.querySelector('.mem-gauge__fill') as HTMLElement
    expect(fill.style.width).toBe(`${(1450 / 8000) * 100}%`)
  })

  it('takes Tier-1 saves from the engine (15 blocked), not the session counter', async () => {
    renderMemory()
    await waitFor(() => expect(screen.getByText('15')).toBeInTheDocument())
    expect(screen.getByText(/Tier-1 saves · all recorded runs/)).toBeInTheDocument()
    // The 36 runs the gate could not RUN are reported, and are NOT saves.
    expect(document.body.textContent).toMatch(
      /36 runs could not run the verify command — nothing was verified/,
    )
  })
})

describe('memInjection — the pure reading behind the gauge', () => {
  it('takes the NEWEST memory span carrying both attrs', () => {
    const older: EngineSpan = { ...MEMORY_SPAN, attrs: { budget: 8000, injected_tokens: 100 } }
    const got = memInjection([older, MEMORY_SPAN])
    expect(got).toMatchObject({ budget: 8000, injected: 1450, items: 3, under: true })
  })

  it('is null when no run has injected memory — the page must then say so', () => {
    expect(memInjection([])).toBeNull()
    expect(memInjection([{ name: 'route', attrs: {} }])).toBeNull()
    // A memory span with no measurement on it is not a measurement.
    expect(memInjection([{ name: 'memory', attrs: { session_id: 's' } }])).toBeNull()
  })

  it('reports an over-budget injection honestly rather than clamping it away', () => {
    const over = memInjection([{ name: 'memory', attrs: { budget: 1000, injected_tokens: 1500 } }])
    expect(over).toMatchObject({ under: false, pct: 100 })
  })
})
