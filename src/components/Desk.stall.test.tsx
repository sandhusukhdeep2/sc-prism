import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Seeded BEFORE the manager module is imported (hoisted callbacks run first),
// so the store loads a Mac that already has a manager switched on — the only
// state in which a stopped loop is worth reporting.
vi.hoisted(() => {
  localStorage.setItem(
    'scprism.managers',
    JSON.stringify({
      seeded: true,
      jobs: [],
      managers: [
        { id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true },
      ],
    }),
  )
})

// Only the native seam is mocked — the desk polls the vault on mount. The
// manager store, the driver's liveness field and the desk projection are all
// REAL, because the claim under test is about what the PAGE RENDERS when the
// loop has stopped, not about what a store holds.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  readVaultFile: vi.fn(async () => null as string | null),
  writeVaultNote: vi.fn(async (_v: string, rel: string) => `/vault/${rel}`),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import Desk from './Desk'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import {
  DRIVER_TICK_MS,
  getManagers,
  recordDriverTick,
  setManagerEnabled,
} from '../lib/managers'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const STALL = /has not run for .*open Automations/i

// The manager module captured its session floor when it was imported, a moment
// ago — so "the app has been open for eight days" is expressed by reading the
// wall clock eight days after that. Every test below runs at `SETTLED`, well
// clear of the floor, so it is measuring the loop and not the launch.
const OPENED = Date.now()
const SETTLED = OPENED + 8 * DAY

/**
 * Render the desk as it looks at `now`.
 *
 * The clock is INJECTED rather than advanced. AppProvider mounts the genuine
 * driver, so running the fake timers forward would let the real loop tick and
 * refresh the very field under test — the harness would quietly heal the
 * failure it is supposed to be reproducing. Freezing the desk's clock instead
 * models the honest thing: a wall clock that has moved on while the loop has
 * not.
 */
function renderDeskAt(now: number) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Desk show="needs" now={now} />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** The loop last ran at `at`, and nothing has woken it since. */
function lastTickWas(at: number): void {
  act(() => recordDriverTick(at))
}

beforeEach(() => {
  native.isNative.mockReturnValue(true)
  native.readVaultFile.mockReset().mockResolvedValue(null)
  // Managers are module state shared across tests: restore the premise.
  act(() => setManagerEnabled('mgr-local', true))
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('a manager that has stopped SAYS SO on the desk', () => {
  it('stays quiet while the loop is beating', () => {
    const now = SETTLED
    lastTickWas(now - 5_000)
    renderDeskAt(now)
    expect(screen.queryByText(STALL)).not.toBeInTheDocument()
  })

  it('tolerates two missed ticks — a busy engine is not a dead loop', () => {
    const now = SETTLED
    lastTickWas(now - DRIVER_TICK_MS * 2)
    renderDeskAt(now)
    expect(screen.queryByText(STALL)).not.toBeInTheDocument()
  })

  it('renders the notice once the loop has missed three ticks', () => {
    const now = SETTLED
    lastTickWas(now - DRIVER_TICK_MS * 4)
    renderDeskAt(now)
    expect(screen.getByText(STALL)).toBeInTheDocument()
  })

  it('states the real duration, so the line is about his week and not a shrug', () => {
    const now = SETTLED
    lastTickWas(now - 7 * DAY)
    renderDeskAt(now)
    // The exact silence Sukhdeep lived through: seven days, said in days.
    expect(screen.getByText(/has not run for 7 days/)).toBeInTheDocument()
  })

  it('puts it under Needs you, not in the ambient activity that collapses away', () => {
    const now = SETTLED
    lastTickWas(now - 7 * DAY)
    const { container } = renderDeskAt(now)
    const needs = container.querySelector('.desk__section')
    expect(needs?.querySelector('.desk__kicker')?.textContent).toBe('Needs you')
    expect(needs?.textContent).toMatch(STALL)
    // And it is styled as the thing that is wrong, not as neutral chatter.
    expect(needs?.querySelector('.desk__notice--err')).toBeTruthy()
  })

  it('never scolds him for a Mac that was simply shut — the app just opened', () => {
    // Same seven-day-old tick, but read at launch instead of eight days in.
    // The silence is real; it just belongs to hours the app was not running,
    // and the desk must not greet him with an accusation about those.
    lastTickWas(OPENED - 7 * DAY)
    renderDeskAt(OPENED)
    expect(screen.queryByText(STALL)).not.toBeInTheDocument()
  })

  it('never scolds him for a manager HE turned off', () => {
    const now = SETTLED
    act(() => {
      for (const m of getManagers().managers) setManagerEnabled(m.id, false)
    })
    lastTickWas(now - 7 * DAY)
    renderDeskAt(now)
    expect(screen.queryByText(STALL)).not.toBeInTheDocument()
  })
})
