// The manager driver — 2026-08-16 honesty pass, Findings 2b and 3.
//
// F2b: a finished standing job used to leave NO trace the user could find. It
//      wrote a real report to the vault and a real run record, then the live
//      card vanished with the run and the app said nothing. One notice per
//      completion now lands on the Companion orb, pointing at the report.
//
// F3:  a DISABLED manager's heartbeat kept waking (40 beats on a manager whose
//      `enabled` was false). The switch the user can see must be the switch
//      that governs — and it now is, in both directions.
//
// Harness shape copied from AppStore.heartbeat.test.tsx: force native, stub the
// vault writes, keep `storeGet` pending for every key except 'managers' so
// settings never hydrate and the connectivity cold-probe never runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  writeVaultNote: vi.fn(
    async (_vault: string, rel: string, _content: string): Promise<string | null> => `/vault/${rel}`,
  ),
  cancelEngineRun: vi.fn(async () => {}),
  managersDisk: [] as (string | null)[],
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    readVaultFile: async () => null,
    writeVaultNote: h.writeVaultNote,
    storeGet: (key: string) =>
      key === 'managers'
        ? Promise.resolve(h.managersDisk.shift() ?? null)
        : new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
    readPowerState: async () => ({ state: 'unknown', detail: '' }),
  }
})

const captured: { state?: import('./AppStore').AppState } = {}

/** Fresh module registry per test — the managers store is a load-time singleton. */
async function boot() {
  vi.resetModules()
  const settings = await import('../lib/settings')
  const connectivity = await import('../lib/connectivity')
  const store = await import('./AppStore')
  const managers = await import('../lib/managers')
  const S = settings.SettingsProvider
  const C = connectivity.ConnectivityProvider
  const A = store.AppProvider
  captured.state = undefined
  const Capture = () => {
    captured.state = store.useApp().state
    return null
  }
  render(
    <S>
      <C>
        <A>
          <Capture />
        </A>
      </C>
    </S>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { managers }
}

const reply = (response: string): Verdict =>
  ({ response, tokensIn: 100, tokensOut: 20 }) as unknown as Verdict

function seedStore(state: unknown): void {
  localStorage.setItem('scprism.managers', JSON.stringify(state))
}

/** A manager on the default-enabled 'local' provider, with one DUE report job. */
const withDueJob = {
  seeded: true,
  managers: [{ id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true }],
  jobs: [
    {
      id: 'job-vault',
      managerId: 'mgr-local',
      title: 'Vault health',
      department: 'operations',
      prompt: 'check the vault',
      everyMinutes: 24 * 60,
      lastRun: 0, // never run → due now
      runs: [],
      kind: 'report',
    },
  ],
}

const companionHb = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  charter: 'watch the projects and vault',
  everyMinutes: 30,
  lastBeat: 0,
  beats: [],
  consent: 'on',
  autoOnAt: 0,
  today: { day: '', beats: 0, tokens: 0 },
  ...over,
})

/** A companion store whose manager flag and heartbeat switch are as given. */
const withCompanion = (managerEnabled: boolean, hbEnabled: boolean) => ({
  seeded: true,
  managers: [
    {
      id: 'mgr-companion',
      providerId: 'primary',
      name: 'Companion',
      enabled: managerEnabled,
      heartbeat: companionHb({ enabled: hbEnabled }),
    },
  ],
  jobs: [],
})

describe('a finished manager job tells the user — exactly once (Finding 2b)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.managersDisk.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('produces ONE notice naming the manager, the job and the real report file', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply('Three notes need front-matter.'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // one driver tick
    })

    // The run really happened: a run record and a report on disk.
    expect(managers.getManagers().jobs[0].runs).toHaveLength(1)
    expect(h.writeVaultNote.mock.calls[0][1]).toBe('reports/local-manager/vault-health.md')

    const notices = captured.state!.notices
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('done')
    expect(notices[0].text).toContain('Local manager')
    expect(notices[0].text).toContain('Vault health')
    // The pointer is the REAL path the driver just wrote, not a description.
    expect(notices[0].text).toContain('reports/local-manager/vault-health.md')
    // "View →" must land somewhere that actually shows this job.
    expect(notices[0].to).toBe('/automations')
  })

  it('does not repeat on later ticks — one notice per COMPLETION, never per tick', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply('All clear.'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(captured.state!.notices).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000) // ten more ticks
    })
    expect(captured.state!.notices).toHaveLength(1)
  })

  it('a job that FAILED says so and asks for attention — never a quiet "done"', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply('[offline:local:local-model] handled: nothing to call'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const notices = captured.state!.notices
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('attention')
    expect(notices[0].text).toContain('needs attention')
  })
})

describe('a manager that is OFF does not work (Finding 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.managersDisk.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('a disabled companion never reaches the engine, however due the beat is', async () => {
    seedStore(withCompanion(false, false))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000) // several ticks
    })

    expect(h.runNativeTask).not.toHaveBeenCalled()
    expect(managers.getManagers().managers[0].enabled).toBe(false)
  })

  it('an enabled one does run — the gate is the switch, not a blanket stop', async () => {
    seedStore(withCompanion(true, true))
    h.runNativeTask.mockResolvedValue(reply('Tidied the vault index.'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
  })

  it('the stored contradiction self-heals: a beating heartbeat means the manager IS on', async () => {
    // Exactly the user's store: heartbeat ON (40 real beats), manager flag
    // false. The flag was never settable from any screen, so gating on it
    // alone would have killed a feature he had consented to. Load reconciles
    // them toward the switch he can actually see.
    seedStore(withCompanion(false, true))
    h.runNativeTask.mockResolvedValue(reply('Drafted the morning summary.'))
    const { managers } = await boot()

    expect(managers.getManagers().managers[0].enabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
  })

  it('turning the heartbeat off turns the MANAGER off, and the engine is never called again', async () => {
    seedStore(withCompanion(true, true))
    const { managers } = await boot()

    await act(async () => {
      managers.updateHeartbeat('mgr-companion', { enabled: false })
    })
    expect(managers.getManagers().managers[0].enabled).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(h.runNativeTask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Timeout honesty (2026-08-28): the manager tick raced a FIXED 420s wall and
// then wrote "(no real reply — provider offline?)" into the report and the
// job's run line — while jobLive.detail said "we stopped it". Two surfaces,
// two stories, and the red ✗ on Automations blamed a provider that was fine.
// The manager job reads the vault, the egress floor pins it local, and the
// local model at 4-6 tok/s simply needed longer than the wall.
// ---------------------------------------------------------------------------
describe('a timed-out manager job says WE stopped it — never "provider offline?"', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.managersDisk.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('the report entry and the run line both carry the honest stop', async () => {
    seedStore(withDueJob)
    // The engine never answers — a slow local model still generating.
    h.runNativeTask.mockImplementation(() => new Promise(() => {}))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // tick starts the job
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21 * 60_000) // past any measured wall
    })

    const run = managers.getManagers().jobs[0].runs[0]
    expect(run.ok).toBe(false)
    expect(run.summary).toContain('we stopped it')
    expect(run.summary).not.toContain('provider offline')
    // The vault report tells the same story as the run line.
    expect(h.writeVaultNote).toHaveBeenCalledTimes(1)
    const [, , body] = h.writeVaultNote.mock.calls[0]
    expect(body).toContain('we stopped it')
    expect(body).not.toContain('provider offline')
  })

  it('a report job rides a REAL token/tool bound, like the wake', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply('All notes healthy.'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    // Positional args mirror the wake's call: [6] tokenBudget, [7] toolTurns.
    const call = h.runNativeTask.mock.calls[0]
    expect(call[6]).toBeGreaterThan(0)
    expect(call[7]).toBeGreaterThan(0)
  })
})
