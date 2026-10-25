// The DRIVER-side share of the tool_call guard (2026-08-18).
//
// `answerText.test.ts` pins the guard itself and the three pure surfaces (chat
// turn, team answer, project answer). The remaining paths the fix had to cover
// live inside the manager/heartbeat driver, so they are pinned here against
// the REAL store: the manager report written to the vault, the desk's
// finished-run row built from `recordJobRun`, and the heartbeat beat line.
//
// Harness shape copied from AppStore.managerJob.test.tsx.
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

/** Verbatim from the saved Verdict the user's chat rendered on 2026-08-17. */
const LIVE_BUG =
  "The HTTPS fetcher hit a local issue, so I'll search for this instead.\n\n" +
  '```tool_call\n{"tool": "web_search", "arguments": {"query": "themeforest.net slashcreative"}}\n```'

async function boot() {
  vi.resetModules()
  const settings = await import('../lib/settings')
  const connectivity = await import('../lib/connectivity')
  const store = await import('./AppStore')
  const managers = await import('../lib/managers')
  const S = settings.SettingsProvider
  const C = connectivity.ConnectivityProvider
  const A = store.AppProvider
  // The provider drives everything under test; nothing needs rendering.
  const Nothing = () => null
  render(
    <S>
      <C>
        <A>
          <Nothing />
        </A>
      </C>
    </S>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { managers, store }
}

const reply = (response: string): Verdict =>
  ({ response, tokensIn: 100, tokensOut: 20 }) as unknown as Verdict

function seedStore(state: unknown): void {
  localStorage.setItem('scprism.managers', JSON.stringify(state))
}

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
      lastRun: 0,
      runs: [],
      kind: 'report',
    },
  ],
}

const withCompanion = {
  seeded: true,
  managers: [
    {
      id: 'mgr-companion',
      providerId: 'primary',
      name: 'Companion',
      enabled: true,
      heartbeat: {
        enabled: true,
        charter: 'watch the projects and vault',
        everyMinutes: 30,
        lastBeat: 0,
        beats: [],
        consent: 'on',
        autoOnAt: 0,
        today: { day: '', beats: 0, tokens: 0 },
      },
    },
  ],
  jobs: [],
}

describe('a raw tool_call fence never reaches a manager surface', () => {
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

  it('THE MANAGER REPORT and THE DESK FINISHED-RUN ROW are both stripped and marked', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply(LIVE_BUG))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    // The report body written to the vault.
    const written = h.writeVaultNote.mock.calls[0][2] as string
    expect(written).not.toContain('```tool_call')
    expect(written).toContain('[incomplete:')
    // The run record the desk's "recent manager runs" row renders.
    const run = managers.getManagers().jobs[0].runs[0]
    expect(run.summary).not.toContain('```tool_call')
    expect(run.summary).toContain('[incomplete:')
    // The prose the model DID write survives — nothing real was thrown away.
    expect(written).toContain('The HTTPS fetcher hit a local issue')
  })

  it('an ordinary manager report is untouched', async () => {
    seedStore(withDueJob)
    h.runNativeTask.mockResolvedValue(reply('Three notes need front-matter.'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(managers.getManagers().jobs[0].runs[0].summary).toBe('Three notes need front-matter.')
    expect(h.writeVaultNote.mock.calls[0][2]).toContain('Three notes need front-matter.')
    expect(h.writeVaultNote.mock.calls[0][2]).not.toContain('[incomplete:')
  })

  it('THE HEARTBEAT BEAT LINE is stripped and marked', async () => {
    seedStore(withCompanion)
    h.runNativeTask.mockResolvedValue(reply(LIVE_BUG))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    expect(beat.line).not.toContain('```tool_call')
    expect(beat.line).toContain('[incomplete:')
  })

  it('a heartbeat wake asks the engine for its OWN smaller tool-turn cap', async () => {
    // The engine default rose to 12 for research; a wake must not silently
    // inherit that appetite. The per-run value is argument 8 of runNativeTask.
    seedStore(withCompanion)
    h.runNativeTask.mockResolvedValue(reply('Tidied the vault index.'))
    const { store } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).toHaveBeenCalled()
    const args = h.runNativeTask.mock.calls[0]
    // Both bounds come from the constants, not from literals here: they were
    // sized by measuring real wakes and will be resized the same way. Pinning
    // a number in this file made a correct widening look like a regression.
    expect(args[6]).toBe(store.WAKE_TOKEN_BUDGET)
    expect(args[7]).toBe(store.WAKE_TOOL_TURNS)
    // Still the wake's OWN smaller appetite, not the engine's research default.
    expect(store.WAKE_TOOL_TURNS).toBeLessThan(12)
  })
})
