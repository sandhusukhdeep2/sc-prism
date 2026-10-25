import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Dashboard } from '../engine/types'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Finding 2a. `local handles {share.pct}%` sat OUTSIDE the `share.measured`
// guard, so with nothing measured the page printed
//
//     no model call measured yet — nothing to divide
//     local handles 0% of this session's routed work
//
// — a percentage of nothing, stated as a fact, directly under the sentence
// saying there was nothing to compute it from. The caption now lives inside the
// guard, and the un-measured branch says what it is instead.

// A dashboard the engine really answered with, that has measured NO model call.
const EMPTY_SHAPED: Dashboard = {
  vault: '/vault',
  runs: 0,
  run_series: [],
  total_tokens: 0,
  total_cost: 0,
  cost_by_model: {},
  cost_by_operation: {},
  token_burn_by_time: {},
  hooks: {},
  eval_trend: [],
  cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
  drift: [],
  healthy: true,
} as Dashboard

vi.mock('../lib/nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    nativeDashboard: async () => EMPTY_SHAPED,
    readNativeDashboard: async () => ({ kind: 'ok', dash: EMPTY_SHAPED }),
    readSpansTail: async () => [],
    runNativeOkf: async () => null,
  }
})

const { default: Memory } = await import('./Memory')

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

describe('Memory — an unmeasured share prints no percentage at all', () => {
  it('never claims a percentage under "no model call measured yet"', async () => {
    renderMemory()
    await waitFor(() =>
      expect(screen.getByText(/no model call measured yet/)).toBeInTheDocument(),
    )
    // THE regression: no percentage claim of any kind while nothing is measured.
    expect(document.body.textContent).not.toMatch(/local handles \d+%/)
  })

  it('says where the split will come from instead', async () => {
    renderMemory()
    await waitFor(() =>
      expect(screen.getByText(/no model call measured yet/)).toBeInTheDocument(),
    )
    expect(document.body.textContent).toMatch(/the split appears on your first measured model call/)
  })

  // The first frame, before the engine has answered anything at all.
  it('reads "reading the engine…" before the first read resolves', () => {
    renderMemory()
    expect(document.body.textContent).toMatch(/reading the engine/)
    expect(document.body.textContent).not.toMatch(/local handles \d+%/)
    // And the hero shows no number it has not read.
    expect(document.querySelector('.mem-saves__num')!.textContent).toBe('—')
  })
})
