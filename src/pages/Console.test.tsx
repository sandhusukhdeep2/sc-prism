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
