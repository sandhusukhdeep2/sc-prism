import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider, DEFAULT_SETTINGS, type Settings } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import {
  COMPANION_MANAGER_ID,
  ensureSeeded,
  getManagers,
  updateHeartbeat,
} from '../lib/managers'
import type { InterviewState } from '../lib/interview'

// Always-on manager (2026-08-05 spec §Part 3). Sukhdeep's complaint, verbatim:
// "Think my manager is always on, and I don't need to, like, make him always on
// with the toggle." The companion card used to open with a consent SWITCH and
// copy that read as an invitation to keep flipping it. It now STATES the real
// state ("On · resting · next check in 30m"), keeps a quiet off switch, and
// adds Wake now. The charter editor and cadence select are unchanged.
//
// The panel is native-only, so native is forced; storeGet is left PENDING so
// SettingsProvider never flips `hydrated` (no connectivity cold-probe) —
// mirrors FloatingPulse.test's harness, and the managers store is driven
// through its real API (a module singleton, so these tests share it in order).
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

const interview: InterviewState = {
  business: 'Finance practice',
  companyName: 'Sukh',
  website: '',
  departments: ['operations'],
  teamSize: '20+ people',
  budget: '$1k+/mo',
  sensitiveWords: [],
  verifyCommand: '',
  compliance: [],
  roles: [],
  priorities: [],
  signoffs: [],
  neverTouch: [],
  adaptive: [],
}

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, enabled: p.id === 'local' })),
}

function renderAgents() {
  const view = render(
    <MemoryRouter initialEntries={['/agents']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Agents />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
  // Behind a tab since the crew-first restructure (2026-08-29): this suite
  // drives the heartbeat card, so open its tab first.
  fireEvent.click(screen.getByRole('tab', { name: /managers/i }))
  return view
}

const companionHb = () =>
  getManagers().managers.find((m) => m.id === COMPANION_MANAGER_ID)!.heartbeat!

describe('Agents companion card — on and resting, not a toggle to keep flipping', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('states the real state ("On · resting · next check in Xm") instead of offering a switch', () => {
    ensureSeeded(settings, interview)
    // The enable transition stamps lastBeat = now → a full 2h cadence ahead,
    // which the label says in HOURS (2026-08-15 §2).
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true, charter: 'watch the projects and vault' })
    renderAgents()

    expect(screen.getByText(/^On · resting · next check in \d+h$/)).toBeInTheDocument()
    // The old consent SWITCH is gone — the nag the user complained about.
    expect(screen.queryByRole('switch', { name: /heartbeat/i })).not.toBeInTheDocument()
    // ...replaced by a quiet, still-one-click off switch.
    expect(screen.getByRole('button', { name: /Turn off the heartbeat/i })).toBeInTheDocument()
    // The charter editor and the cadence select stay.
    expect(screen.getByDisplayValue('watch the projects and vault')).toBeInTheDocument()
    expect(screen.getByLabelText('Heartbeat cadence')).toBeInTheDocument()
  })

  it('offers Wake now, live, with no excuse line when a wake can actually run', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    renderAgents()

    expect(screen.getByRole('button', { name: 'Wake now' })).toBeEnabled()
    expect(screen.queryByText(/can’t wake now/)).not.toBeInTheDocument()
  })

  it('the quiet off switch really turns it off — always-on is a default, not a lock-in', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    renderAgents()

    fireEvent.click(screen.getByRole('button', { name: /Turn off the heartbeat/i }))

    // A real decision is recorded, which is what stops the setup default-on
    // from ever switching it back on.
    expect(companionHb()).toMatchObject({ enabled: false, consent: 'off' })
    expect(screen.getByText(/^Off — .* will not wake on its own$/)).toBeInTheDocument()
  })

  it('an OFF heartbeat disables Wake now WITH the honest reason', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: false })
    renderAgents()

    expect(screen.getByText(/^Off — .* will not wake on its own$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Wake now' })).toBeDisabled()
    expect(
      screen.getByText('can’t wake now — heartbeat is off — turn it on first'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Turn on the heartbeat/i })).toBeInTheDocument()
  })
})
