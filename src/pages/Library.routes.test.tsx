import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Design 2026-11-08 §D: "every route keeps rendering". The rail stopped listing
// /skills, /memory, /vault and /training; the pages themselves did not move.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...p: string[]) => p.join('/'),
}))

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <App />
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

describe('the old routes still render after the rail shrank', () => {
  it.each([
    ['/skills', 'Skill library'],
    ['/memory', 'Memory & learning'],
    ['/vault', 'Your vault'],
    ['/training', 'Improve routing'],
  ])('%s renders its page', async (route, heading) => {
    renderAt(route)
    // PageHead renders `Skill<span> library</span>`; the accessible-name walk
    // drops that inner space, so match the heading's text, not its name.
    const h1s = await screen.findAllByRole('heading', { level: 1 })
    expect(h1s.map((h) => h.textContent)).toContain(heading)
  })

  it('/library renders the tablist', async () => {
    renderAt('/library')
    expect(await screen.findByRole('tablist', { name: 'Library sections' })).toBeInTheDocument()
  })
})
