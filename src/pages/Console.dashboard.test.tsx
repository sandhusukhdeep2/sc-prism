import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Dashboard } from '../engine/types'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// The Console rendered against a dashboard shaped like the user's REAL vault:
// claude-cli burned 69,833 tokens, the stop hook errored 36 times, and dispatch
// (which wraps the whole model call) averaged 687s. Before the honesty pass the
// page showed two empty provider bars, "170039.5ms avg latency", and a green
// "healthy" badge sitting on top of 36 errors.

const REAL_SHAPED: Dashboard = {
  vault: '/vault',
  runs: 51,
  run_series: [],
  total_tokens: 279173,
  total_cost: 0.42,
  cost_by_model: {
    'claude-sonnet-4': { calls: 20, tokens_in: 60000, tokens_out: 9833, tokens: 69833, cost: 0.4, provider: 'claude-cli' },
    'qwen3-local': { calls: 31, tokens_in: 200000, tokens_out: 9340, tokens: 209340, cost: 0.02, provider: 'local' },
  },
  cost_by_operation: {},
  token_burn_by_time: {},
  hooks: {
    dispatch: { fires: 51, total_ms: 35_042_000, avg_ms: 687_098, blocks: 0, errors: 0 },
    stop: { fires: 51, total_ms: 510, avg_ms: 10, blocks: 0, errors: 36 },
  },
  eval_trend: [],
  cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
  drift: [],
  healthy: false,
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

const { default: Console } = await import('./Console')

function renderConsole() {
  return render(
    <MemoryRouter initialEntries={['/console']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Console />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Governance Console against a real-shaped dashboard', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('draws a real bar per provider the engine reported — none stuck at the 6% floor', async () => {
    renderConsole()
    await screen.findByText('claude')
    await screen.findByText('local')
    const bars = [...document.querySelectorAll<HTMLElement>('.console__bar')]
    // claude (69,833) vs local (209,340): the tallest is local at 100%, and
    // claude is well above the 6% stub the old `provider === 'claude'` produced.
    const heights = bars.map((b) => parseInt(b.style.height, 10))
    expect(heights.some((h) => h === 100)).toBe(true)
    expect(heights.every((h) => h > 6)).toBe(true)
  })

  it('never renders "healthy" while hooks carry errors', async () => {
    renderConsole()
    expect(await screen.findByText('36 errors')).toBeInTheDocument()
    expect(screen.queryByText('healthy')).not.toBeInTheDocument()
  })

  it('excludes dispatch from the latency average and says so', async () => {
    renderConsole()
    // 510ms over 51 stop fires = 10ms, not (35,042,510 / 102) = 343,554ms.
    expect(await screen.findByText('10.0ms')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/170039\.5ms/)
    expect(document.body.textContent).toMatch(/dispatch excluded/)
  })

  it('has no hardcoded execution-graph picture left on the page', async () => {
    renderConsole()
    await screen.findByText('claude')
    expect(screen.queryByText(/Agent execution graph/)).not.toBeInTheDocument()
    expect(document.querySelector('.console__graph')).toBeNull()
    expect(document.body.textContent).not.toMatch(/A2A hand-off/)
  })

  it('waits for real data rather than inventing it', async () => {
    renderConsole()
    await waitFor(() => expect(screen.getByText('live engine')).toBeInTheDocument())
  })
})
