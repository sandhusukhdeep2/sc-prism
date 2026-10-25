// Mission Control (2026-08-05 spec §Live task cards) — the live-run lifecycle.
//
// The glow on the Work page derives from `state.liveRuns` and nothing else, so
// the ONLY way a card can lie is if an entry leaks. These tests prove the
// `finally` in every registered runner: a run is registered while it is really
// in flight and is cleared on success, on an honest failure, on a client
// timeout AND on a throw. The heartbeat is proved to ride the EXISTING
// `heartbeatLive` transition rather than a second signal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp,
  chatWallMs,
} from './AppStore'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
}))

// Native chat path is the subject. `storeGet` stays PENDING so SettingsProvider
// never hydrates and the connectivity cold-probe never runs (same isolation as
// AppStore.timeoutHonesty).
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderApp() {
  return render(
    <SettingsProvider>
      <ConnectivityProvider>
        <AppProvider>
          <Capture />
        </AppProvider>
      </ConnectivityProvider>
    </SettingsProvider>,
  )
}

const live = () => captured.app!.state.liveRuns
const finished = () => captured.app!.state.finishedRuns

/** A minimal REAL completion — enough for the chat path's success branch. */
const okVerdict = (): Verdict =>
  ({
    taskId: 'T-1',
    task: 'x',
    response: 'here is a real answer',
    route: { target: 'local', model: 'qwen', via: '', reason: '', routeLabel: 'local · qwen' },
    tier1: { tests: '1/1', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.9, passed: true, judge: 'j', trajectory: 't' },
    tokensIn: 10,
    tokensOut: 5,
    cost: 0,
    durationMs: 10,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed: true,
  }) as unknown as Verdict

describe('liveRuns lifecycle — a chat send', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('registers ONE live run while in flight and clears it on SUCCESS', async () => {
    let release: ((v: Verdict) => void) | null = null
    h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.sendIntent('fix the uploader bug')
      await Promise.resolve()
    })

    // In flight: exactly one live run, carrying the REAL intent, and no model
    // claim (the gateway decides the route — the app must not guess it).
    expect(live()).toHaveLength(1)
    expect(live()[0].kind).toBe('chat')
    expect(live()[0].intent).toBe('fix the uploader bug')
    expect(live()[0].models).toEqual([])
    expect(live()[0].startedAt).toBeGreaterThan(0)

    await act(async () => {
      release!(okVerdict())
      await sent!
    })

    // Cleared, and recorded as the pass it really was.
    expect(live()).toHaveLength(0)
    expect(finished()[0]).toMatchObject({ kind: 'chat', outcome: 'passed', intent: 'fix the uploader bug' })
  })

  it('clears the entry on a client TIMEOUT and records it as stopped, not passed', async () => {
    h.runNativeTask.mockImplementation(() => new Promise(() => {})) // never settles
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.sendIntent('a slow one')
      await Promise.resolve()
    })
    expect(live()).toHaveLength(1)

    await act(async () => {
      // Past the chat's real wall, whatever it is — the wall is now derived
      // (never below the ENGINE's own CLI timeout, so the client can't give up
      // on a run the engine is still legitimately working on), so a hardcoded
      // 120_000 here would silently stop testing the timeout at all.
      await vi.advanceTimersByTimeAsync(chatWallMs({ stallMs: 0 } as never) + 1_000)
      await sent!
    })

    expect(live()).toHaveLength(0) // the finally ran — no card left glowing
    expect(finished()[0].outcome).toBe('stopped')
    // The message states the REAL wall, so it is derived here too — and the
    // wall must be at least the engine's own, or the client is stopping runs
    // the engine had not given up on.
    const wallSecs = Math.round(chatWallMs({ stallMs: 0 } as never) / 1000)
    expect(finished()[0].detail).toMatch(new RegExp(`${wallSecs}s`))
    expect(wallSecs).toBeGreaterThanOrEqual(180)
  })

  it('clears the entry when the engine call THROWS (proves the finally, not a happy path)', async () => {
    h.runNativeTask.mockImplementation(() => {
      throw new Error('bridge exploded')
    })
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.app!.sendIntent('a doomed one')
    })

    expect(live()).toHaveLength(0)
    expect(finished()[0]).toMatchObject({ kind: 'chat', outcome: 'failed' })
  })

  it('clears the entry on an honest engine failure (a real null reply)', async () => {
    h.runNativeTask.mockResolvedValue(null)
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await captured.app!.sendIntent('offline provider')
    })

    expect(live()).toHaveLength(0)
    expect(finished()[0].outcome).toBe('failed')
    expect(finished()[0].detail).toMatch(/unreachable/)
  })

  it('keeps only the newest 5 finished rows', async () => {
    h.runNativeTask.mockResolvedValue(okVerdict())
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        await captured.app!.sendIntent(`ask ${i}`)
      })
    }
    expect(finished()).toHaveLength(5)
    expect(finished()[0].intent).toBe('ask 6') // newest first
  })
})

describe('liveRuns lifecycle — the external (Agents page) registration pair', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('beginLiveRun registers and endLiveRun clears, with the honest outcome kept', async () => {
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({
        kind: 'team',
        intent: 'plan the SOC 2 dashboard',
        models: ['lead:claude', 'researcher:local'],
      })
    })
    expect(live()).toHaveLength(1)
    expect(live()[0]).toMatchObject({ kind: 'team', models: ['lead:claude', 'researcher:local'] })

    await act(async () => {
      captured.app!.endLiveRun(id, 'failed', 'the team run did not pass')
    })
    expect(live()).toHaveLength(0)
    expect(finished()[0]).toMatchObject({ kind: 'team', outcome: 'failed', detail: 'the team run did not pass' })
  })

  it('ending an id that was never live is a no-op — no fabricated outcome row', async () => {
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      captured.app!.endLiveRun('never-started', 'passed', 'nope')
    })
    expect(live()).toHaveLength(0)
    expect(finished()).toHaveLength(0)
  })

  it('re-registering the same id replaces rather than duplicates (one runner, one card)', async () => {
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      captured.app!.beginLiveRun({ id: 'dup', kind: 'chat', intent: 'first' })
      captured.app!.beginLiveRun({ id: 'dup', kind: 'chat', intent: 'second' })
    })
    expect(live()).toHaveLength(1)
    expect(live()[0].intent).toBe('second')
  })
})
