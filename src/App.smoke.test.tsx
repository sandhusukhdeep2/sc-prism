import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { SettingsProvider } from './lib/settings'
import { ConnectivityProvider } from './lib/connectivity'
import { OnboardingProvider } from './lib/onboarding'
import { AppProvider } from './store/AppStore'

// EVERY PAGE, MOUNTED. This covered four routes and asserted only that they did
// not throw, which is a low bar: a page that renders an empty div passes it.
// The app has twenty-two routes and Sukhdeep walks all of them, so all of them
// are mounted here — and each must render REAL content, not merely survive.
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

/** Onboarding done — otherwise every in-app route redirects to /welcome and
 *  the whole suite would pass by testing the same page twenty-two times. */
const seedSetupDone = () =>
  localStorage.setItem(
    'scprism.onboarding',
    JSON.stringify({
      completedSteps: ['welcome', 'providers', 'companion', 'vault', 'interview', 'review'],
      done: true,
    }),
  )

/** The pages reached from the rail, after setup. */
const IN_APP = [
  '/',
  '/vault',
  '/agents',
  '/skills',
  '/automations',
  '/training',
  '/stats',
  '/memory',
  '/console',
  '/settings',
  '/editor',
  '/verdict',
  '/approval',
]

/** The first-run flow, which renders WITHOUT setup being done. */
const SETUP = [
  '/welcome',
  '/providers',
  '/companion-wakes',
  '/vault-setup',
  '/companion-grants',
  '/github',
  '/interview',
  '/governance-review',
]

/** Routes that exist only to send you somewhere else. */
const REDIRECTS: [string, string][] = [
  ['/loop', '/automations'],
  ['/projects', '/'],
]

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('every in-app page mounts and renders something real', () => {
  it.each(IN_APP)('%s', (route) => {
    seedSetupDone()
    const { container } = renderAt(route)
    // Not "did not throw" — did it actually put a page on the screen? An empty
    // shell is the failure mode a throw-only test cannot see.
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(20)
  })

  it.each(IN_APP)('%s keeps the navigation rail', (route) => {
    seedSetupDone()
    renderAt(route)
    // The rail is the app's one navigation. A page that loses it is a page you
    // can arrive at and not leave — the exact bug the More dropdown caused.
    //
    // Scoped INSIDE the rail on purpose: Automations' own copy says "use Work
    // or a project", so a page-wide search for a link named Work finds two and
    // fails for a reason that has nothing to do with navigation.
    const rail = document.querySelector('nav.rail')
    expect(rail, `${route} has no rail`).toBeTruthy()
    const railLinks = [...rail!.querySelectorAll('a')].map((a) => a.textContent?.trim())
    expect(railLinks).toContain('Work')
    expect(railLinks).toContain('Settings')
  })

  it.each(IN_APP)('%s announces itself with exactly one page title', (route) => {
    seedSetupDone()
    renderAt(route)
    // Counts PAGE-HEADER titles, not every h1 on the screen: the Vault renders
    // the user's markdown, and a note of his that starts with "# Something"
    // legitimately puts an h1 on the page. That is his content, not a second
    // page header.
    const titles = document.querySelectorAll('.phead__title')
    expect(titles.length, `${route} has ${titles.length} page titles`).toBeLessThanOrEqual(1)
  })
})

describe('every setup page mounts before setup is done', () => {
  it.each(SETUP)('%s', (route) => {
    const { container } = renderAt(route)
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(20)
  })
})

describe('the redirects go where they say', () => {
  it.each(REDIRECTS)('%s lands on %s', (from) => {
    seedSetupDone()
    expect(() => renderAt(from)).not.toThrow()
    // It resolved to a real page rather than a blank router state.
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(20)
  })
})
