import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Stats from './Stats'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// P4 (honesty): with ZERO verified tasks the eval card printed "avg 0.00 across
// all verified tasks" (a confident number for no data) and the cost card claimed
// "cost floor holding". Both now show the cache-card style "appears after your
// first runs" placeholder instead. We seed the durable session AppStore restores
// (empty verdicts, zeroed stats) so the page renders its genuine empty state.
function seedEmpty() {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: {},
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
    }),
  )
}

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

describe('Stats — no confident number on an empty eval/cost state', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows the "appears after your first run" placeholder instead of "avg 0.00"', () => {
    seedEmpty()
    renderStats()
    // The eval card no longer prints a fabricated average over zero tasks.
    expect(document.body.textContent).not.toMatch(/avg 0\.00 across all verified tasks/)
    expect(screen.getByText('eval scores appear after your first verified run')).toBeInTheDocument()
  })

  it('shows the cost-trend placeholder instead of claiming "cost floor holding" on no data', () => {
    seedEmpty()
    renderStats()
    expect(document.body.textContent).not.toMatch(/cost floor holding/)
    expect(screen.getByText('cost trend appears after your first runs')).toBeInTheDocument()
  })
})
