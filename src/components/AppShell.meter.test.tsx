import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import { SettingsProvider, DEFAULT_SETTINGS } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// The local share at the foot of the rail (design 2026-11-08 §C). Same
// provider stack as AppShell.nav.test.tsx; runs non-native, so the live
// dashboard hook reports 'none' and the meter must claim nothing unless the
// only honest thing to say is that there is no local model to measure.
function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<div>work page</div>} />
                  <Route path="providers" element={<div>providers page</div>} />
                  <Route path="stats" element={<div>stats page</div>} />
                </Route>
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'scprism.onboarding',
    JSON.stringify({ completedSteps: ['welcome', 'providers', 'companion', 'vault', 'interview', 'review'], done: true }),
  )
})
afterEach(() => {
  localStorage.clear()
})

describe('the rail carries the local share', () => {
  it('with the local provider disabled and nothing measured it says 0% local and offers to turn it on', () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        providers: DEFAULT_SETTINGS.providers.map((p) => (p.id === 'local' ? { ...p, enabled: false } : p)),
      }),
    )
    renderShell()
    expect(screen.getByText(/0% local/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'turn it on' })).toHaveAttribute('href', '/providers')
  })

  it('with a local provider but no dashboard read (non-native) it claims nothing', () => {
    renderShell()
    expect(document.querySelector('.meter')).toBeNull()
  })
})
