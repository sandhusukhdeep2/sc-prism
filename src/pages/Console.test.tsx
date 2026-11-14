import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Console from './Console'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Mirrors the provider stack from Memory.test.tsx. Runs non-native (no
// __TAURI_INTERNALS__), so the real engine dashboard never loads and `dash`
// stays null — the exact "no real hook data" state.
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

// Five places (2026-11-08 §D): Stats left the rail; the Console — the truth
// page — points at it from its header.
describe('the Console points at Stats', () => {
  it('carries a Stats link in its header', () => {
    renderConsole()
    expect(screen.getByRole('link', { name: 'Stats ›' })).toHaveAttribute('href', '/stats')
  })
})

// P2 honesty: the hook-latency card used to ship a hardcoded green "EKG"
// sparkline and a "healthy" badge that rendered even with NO real hook data —
// a fabricated healthy claim. With no engine hook data the badge must read a
// NEUTRAL "no data yet", never green "healthy".
describe('Governance Console — hook card is honest with no real data', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows a neutral "no data yet" badge instead of a fabricated green "healthy"', () => {
    renderConsole()
    const badge = screen.getByText('no data yet')
    expect(badge).toHaveClass('console__badge--muted')
    expect(screen.queryByText('healthy')).not.toBeInTheDocument()
    // The green "ok" badge class must not be used for the empty hook state.
    expect(document.querySelector('.console__badge--ok')).toBeNull()
  })
})

// THE RUN RECORD LIVES HERE (2026-11-14, "Visible agents"). Recent runs and
// This week used to sit under the chat on Work, where they were one more
// block on a page whose job is the conversation. The Console is "the truth:
// spans, stats, what was blocked and what it cost" — so the record is here.
describe('the Console holds the run record', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows Recent runs as a table of the runs really recorded, beside This week', () => {
    renderConsole()
    const record = screen.getByRole('region', { name: 'Your measured run history' })
    expect(record).toHaveTextContent('Recent runs')
    expect(record).toHaveTextContent('This week')
    // The store this test mounts holds one recorded run: one row, no more.
    expect(record.querySelectorAll('.ledger__table tbody tr')).toHaveLength(1)
  })
})
