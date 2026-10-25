import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Always-on manager (2026-08-05 spec §Part 3). The heartbeat turns ON by
// itself once setup completes — the user asked not to have to flip a toggle to
// have a manager. That flip spends real tokens on a background loop, so it is
// only defensible if he SEES it: these tests pin the flip, the visible consent
// notice that comes with it, its one-click off, and the rule that a heartbeat
// he turned off stays off through the next launch.
//
// Native is forced (the heartbeat driver only exists there) and storeGet is
// left PENDING so SettingsProvider never flips `hydrated` and the connectivity
// cold-probe never runs — same harness shape as FloatingPulse.test.
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

const ONBOARDING_DONE = JSON.stringify({
  completedSteps: ['welcome', 'providers', 'companion', 'vault', 'grants', 'interview', 'review'],
  done: true,
})

/** A companion in the managers store, with whatever heartbeat the test wants. */
function seedManagers(hb: Record<string, unknown>): void {
  localStorage.setItem(
    'scprism.managers',
    JSON.stringify({
      managers: [
        { id: 'mgr-companion', providerId: 'primary', name: 'Companion', enabled: false, heartbeat: hb },
      ],
      jobs: [],
      seeded: true,
    }),
  )
}

const NEVER_DECIDED = { enabled: false, charter: 'watch the vault', everyMinutes: 30, lastBeat: 0, beats: [] }

// Fresh module registry per test: the managers store is a module singleton
// whose state loads at import time, so each scenario needs its own import —
// and every provider must come from the SAME fresh registry.
async function boot() {
  vi.resetModules()
  const settings = await import('../lib/settings')
  const connectivity = await import('../lib/connectivity')
  const onboarding = await import('../lib/onboarding')
  const store = await import('../store/AppStore')
  const managers = await import('../lib/managers')
  const shellMod = await import('./AppShell')
  const S = settings.SettingsProvider
  const C = connectivity.ConnectivityProvider
  const O = onboarding.OnboardingProvider
  const A = store.AppProvider
  const AppShell = shellMod.default
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <S>
          <C>
            <O>
              <A>
                <Routes>
                  <Route element={<AppShell />}>
                    <Route index element={<div>work page</div>} />
                    <Route path="agents" element={<div>agents page</div>} />
                  </Route>
                </Routes>
              </A>
            </O>
          </C>
        </S>
      </MemoryRouter>,
    )
  })
  return { managers }
}

const hbOf = (managers: typeof import('../lib/managers')) =>
  managers.getManagers().managers.find((m) => m.id === 'mgr-companion')!.heartbeat!

describe('setup completion turns the heartbeat on — visibly', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('a finished setup enables the heartbeat with lastBeat stamped, and surfaces the consent notice', async () => {
    localStorage.setItem('scprism.onboarding', ONBOARDING_DONE)
    seedManagers(NEVER_DECIDED)
    const before = Date.now()
    const { managers } = await boot()

    const hb = hbOf(managers)
    expect(hb.enabled).toBe(true)
    // Stamped, so the first check is a full cadence away — no wake within 30s
    // of finishing setup (the prior audit's fix, kept for the automatic flip).
    expect(hb.lastBeat).toBeGreaterThanOrEqual(before)
    expect(managers.beatDue(hb.lastBeat + 1_000, hb)).toBe(false)

    // And he SEES it: the consent copy, stating what runs and that it costs.
    expect(screen.getByText(/heartbeat is now on/i)).toBeInTheDocument()
    expect(screen.getByText(/spends real tokens/i)).toBeInTheDocument()
    expect(screen.getByText(/First check in one cadence/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn it off' })).toBeInTheDocument()
  })

  it('the notice’s one-click off really turns it off, and does not come back', async () => {
    localStorage.setItem('scprism.onboarding', ONBOARDING_DONE)
    seedManagers(NEVER_DECIDED)
    const { managers } = await boot()
    expect(hbOf(managers).enabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }))
    })

    expect(hbOf(managers)).toMatchObject({ enabled: false, consent: 'off' })
    expect(screen.queryByText(/heartbeat is now on/i)).not.toBeInTheDocument()
  })

  it('"Keep it on" answers the notice — it stays on and is never asked again', async () => {
    localStorage.setItem('scprism.onboarding', ONBOARDING_DONE)
    seedManagers(NEVER_DECIDED)
    const { managers } = await boot()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }))
    })

    expect(hbOf(managers)).toMatchObject({ enabled: true, consent: 'on' })
    expect(screen.queryByText(/heartbeat is now on/i)).not.toBeInTheDocument()
  })

  it('a user who turned it OFF stays off across a RELOAD — and is not re-notified', async () => {
    localStorage.setItem('scprism.onboarding', ONBOARDING_DONE)
    seedManagers(NEVER_DECIDED)
    const first = await boot()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }))
    })
    expect(hbOf(first.managers).enabled).toBe(false)

    // RELAUNCH: fresh registry, state rehydrated from the persisted store.
    const second = await boot()
    expect(hbOf(second.managers)).toMatchObject({ enabled: false, consent: 'off' })
    expect(screen.queryByText(/heartbeat is now on/i)).not.toBeInTheDocument()
  })

  it('an EXISTING install that was already done gets the same flip and the same notice — once', async () => {
    // Already `done` before this build shipped, with a pre-consent heartbeat
    // record (no consent field at all) that was never turned on.
    localStorage.setItem('scprism.onboarding', ONBOARDING_DONE)
    seedManagers(NEVER_DECIDED)
    const first = await boot()
    expect(hbOf(first.managers).enabled).toBe(true)
    expect(screen.getByText(/heartbeat is now on/i)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }))
    })
    // Next launch: still on, but the notice is spent — not re-shown forever.
    const second = await boot()
    expect(hbOf(second.managers).enabled).toBe(true)
    expect(screen.queryByText(/heartbeat is now on/i)).not.toBeInTheDocument()
  })

  it('setup NOT finished → nothing is enabled and nothing is claimed', async () => {
    localStorage.setItem(
      'scprism.onboarding',
      JSON.stringify({ completedSteps: ['welcome'], done: false }),
    )
    seedManagers(NEVER_DECIDED)
    const { managers } = await boot()
    expect(hbOf(managers)).toMatchObject({ enabled: false, consent: 'undecided', autoOnAt: 0 })
    expect(screen.queryByText(/heartbeat is now on/i)).not.toBeInTheDocument()
  })
})
