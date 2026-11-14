import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { Dashboard } from '../engine/types'
import statsSrc from '../pages/Stats.tsx?raw'
import consoleSrc from '../pages/Console.tsx?raw'
import memorySrc from '../pages/Memory.tsx?raw'
import automationsSrc from '../pages/Automations.tsx?raw'

// Finding 5 (2026-08-09 honesty pass): Stats / Console / Memory each snapshotted
// the engine dashboard once and then went stale — a run could finish while the
// user watched and nothing moved. One shared hook now refetches while a run is
// genuinely live, and — just as important — never polls when the app is idle.

const calls = vi.hoisted(() => ({
  n: 0,
  /** when set, the next read fails with this message instead of succeeding */
  failWith: null as string | null,
  /** when set, resolve the Nth read only after this many ticks (out-of-order) */
  delay: null as ((n: number) => Promise<void>) | null,
  /** when set, the next read THROWS (a path lookup / bridge failure) */
  throwWith: null as Error | null,
}))

vi.mock('./nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readNativeDashboard: async () => {
      calls.n += 1
      const mine = calls.n
      if (calls.delay) await calls.delay(mine)
      if (calls.throwWith) throw calls.throwWith
      if (calls.failWith) return { kind: 'error' as const, error: calls.failWith }
      return {
        kind: 'ok' as const,
        dash: { vault: '/vault', runs: mine } as unknown as Dashboard,
      }
    },
  }
})

const { DASH_POLL_MS, LiveDashboardProvider, staleNote, useLiveDashboard } = await import('./liveDashboard')

describe('useLiveDashboard', () => {
  beforeEach(() => {
    calls.n = 0
    calls.failWith = null
    calls.throwWith = null
    calls.delay = null
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('a read that THROWS (a path lookup or bridge failure) settles as failed — never an unhandled rejection', async () => {
    // Found 2026-11-08: AppShell mounted this hook under a partial native stub,
    // resolveVaultDir → homeDir() threw, and the rejection escaped the effect.
    calls.throwWith = new Error('no tauri internals')
    const { result } = renderHook(() => useLiveDashboard('/vault', false, 0))
    await flush()
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toContain('no tauri internals')
    expect(result.current.dash).toBeNull()
  })

  it('a throw after a real measurement keeps that measurement and reads stale', async () => {
    const { result, rerender } = renderHook(({ key }) => useLiveDashboard('/vault', false, key), { initialProps: { key: 0 } })
    await flush()
    expect(result.current.status).toBe('ok')
    calls.throwWith = new Error('bridge gone')
    rerender({ key: 1 })
    await flush()
    expect(result.current.status).toBe('stale')
    expect(result.current.dash).not.toBeNull()
  })

  it('fetches once on mount and then does NOT poll while idle', async () => {
    renderHook(() => useLiveDashboard('/vault', false, 0))
    await flush()
    expect(calls.n).toBe(1)

    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS * 10)
    })
    await flush()
    expect(calls.n).toBe(1) // no timer exists at all when nothing is live
  })

  it('refetches on the poll interval while a run is live', async () => {
    renderHook(() => useLiveDashboard('/vault', true, 0))
    await flush()
    expect(calls.n).toBe(1)

    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS)
    })
    await flush()
    expect(calls.n).toBe(2)

    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS * 2)
    })
    await flush()
    expect(calls.n).toBe(4)
  })

  it('stops polling the moment the last live run ends', async () => {
    const { rerender } = renderHook(({ live }) => useLiveDashboard('/vault', live, 0), {
      initialProps: { live: true },
    })
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS)
    })
    await flush()
    const during = calls.n
    expect(during).toBeGreaterThan(1)

    rerender({ live: false })
    await flush()
    const afterRefetch = calls.n // one fetch on the transition, then silence
    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS * 5)
    })
    await flush()
    expect(calls.n).toBe(afterRefetch)
  })

  it('refetches when the caller bumps its key (e.g. a verdict landed)', async () => {
    const { rerender } = renderHook(({ key }) => useLiveDashboard('/vault', false, key), {
      initialProps: { key: 0 },
    })
    await flush()
    expect(calls.n).toBe(1)

    rerender({ key: 1 })
    await flush()
    expect(calls.n).toBe(2)
  })

  it('exposes the fetched dashboard', async () => {
    const { result } = renderHook(() => useLiveDashboard('/vault', false, 0))
    await flush()
    expect(result.current.dash?.runs).toBe(1)
    expect(result.current.status).toBe('ok')
  })

  // Finding 2a: the hook started at `null` — the SAME value it uses for "no
  // engine" — so every mount rendered the session fallback ("local handles 0%
  // of this session's routed work") for a frame before the real 86% landed.
  it('starts in a distinct loading state, not in "no engine"', () => {
    const { result } = renderHook(() => useLiveDashboard('/vault', false, 0))
    expect(result.current.status).toBe('loading')
    expect(result.current.dash).toBeNull()
  })

  // Finding 4a: a transient read failure used to setDash(null) unconditionally,
  // flipping a MEASURED 86% to "0%, this session only" every 2.5s, with the
  // failure itself never surfaced and the note blaming the wrong thing.
  it('keeps the last good dashboard when a read fails, and marks it stale', async () => {
    const { rerender } = renderHook(({ key }) => useLiveDashboard('/vault', false, key), {
      initialProps: { key: 0 },
    })
    await flush()

    calls.failWith = 'engine spawn failed'
    let current!: ReturnType<typeof useLiveDashboard>
    const hook = renderHook(({ key }) => (current = useLiveDashboard('/vault', false, key)), {
      initialProps: { key: 0 },
    })
    await flush()
    // First read of THIS hook failed with nothing measured before it.
    expect(current.status).toBe('failed')
    expect(current.dash).toBeNull()
    expect(current.error).toBe('engine spawn failed')

    // Now a hook that HAS a measurement: it must keep it.
    calls.failWith = null
    hook.rerender({ key: 1 })
    await flush()
    expect(current.status).toBe('ok')
    const measured = current.dash
    expect(measured).not.toBeNull()

    calls.failWith = 'engine read failed'
    hook.rerender({ key: 2 })
    await flush()
    expect(current.status).toBe('stale')
    expect(current.dash).toBe(measured) // the measurement survives the failure
    expect(staleNote(current)).toMatch(/engine read failed at .+ — showing the last measurement/)
    rerender({ key: 0 })
  })

  // Finding 4b: with a 2.5s poll and a read that can outrun it, an older fetch
  // could land after a newer one and install a stale dashboard as current.
  it('a slow earlier fetch cannot overwrite a newer one', async () => {
    // Read #1 resolves only after read #2 has already landed.
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => (releaseFirst = r))
    calls.delay = async (n) => {
      if (n === 1) await firstGate
    }

    let current!: ReturnType<typeof useLiveDashboard>
    const { rerender } = renderHook(({ key }) => (current = useLiveDashboard('/vault', false, key)), {
      initialProps: { key: 0 },
    })
    await flush()
    expect(current.dash).toBeNull() // #1 still in flight

    rerender({ key: 1 }) // fires read #2, which resolves immediately
    await flush()
    expect(current.dash?.runs).toBe(2)

    releaseFirst() // the OLD read finally lands
    await flush()
    expect(current.dash?.runs).toBe(2) // and is dropped, not installed
  })
})

// Wiring pin: the data pages must read the ONE shared hook and drive it
// from the live-run registry — not from four private useEffects (the pre-2026-
// 08-09 shape, which fetched once with deps [verdicts.length, vaultPath] and
// then never moved), and not from a timer that runs while the app is idle.
describe('the data pages are wired to the shared hook', () => {
  const pages: Array<[string, string]> = [
    ['Stats.tsx', statsSrc],
    ['Console.tsx', consoleSrc],
  ]

  // Memory stopped repeating the dashboard's figures on 2026-11-14 (Stats,
  // Console and the rail's meter own them), so it reads no dashboard at all —
  // and must not grow a private fetch of its own.
  it('Memory.tsx reads no dashboard, by the hook or by a fetch of its own', () => {
    expect(memorySrc).not.toMatch(/useLiveDashboard\(/)
    expect(memorySrc).not.toMatch(/nativeDashboard\(/)
  })

  for (const [name, src] of pages) {
    it(`${name} refetches via useLiveDashboard, gated on activeRuns(state.liveRuns)`, () => {
      expect(src).toMatch(/useLiveDashboard\(/)
      expect(src).toMatch(/activeRuns\(state\.liveRuns\)\.length > 0/)
      // No page keeps its own nativeDashboard fetch effect any more.
      expect(src).not.toMatch(/nativeDashboard\(/)
    })
  }

  it('Automations drives its live rows off the same registry', () => {
    expect(automationsSrc).toMatch(/activeRuns\(state\.liveRuns\)/)
  })
})

// ONE POLL, however many readers. The shell mounts this hook for the rail's
// meter, and Stats / Console / Memory mount it again for their own numbers —
// so on those pages the engine's dashboard was read twice per tick. Inside the
// shell's provider a page's hook reuses the shell's reading instead.
describe('inside LiveDashboardProvider the hook shares one poll', () => {
  beforeEach(() => {
    calls.n = 0
    calls.failWith = null
    calls.throwWith = null
    calls.delay = null
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  it('the shell provides its reading to every page below it', async () => {
    const shellSrc = (await import('../components/AppShell.tsx?raw')).default
    expect(shellSrc).toContain('LiveDashboardContext.Provider value={dashRead}')
  })
  it('two readers under one provider cost one read per tick, and read the same dashboard', async () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(LiveDashboardProvider, { vaultPath: '/vault', live: true, refetchKey: 0 }, children)
    // Two readers under ONE provider.
    const both = renderHook(
      () => [useLiveDashboard('/vault', true, 0), useLiveDashboard('/vault', true, 0)] as const,
      { wrapper },
    )
    await flush()
    expect(calls.n).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(DASH_POLL_MS)
    })
    await flush()
    expect(calls.n).toBe(2)
    const [a, b] = both.result.current
    expect(a.status).toBe('ok')
    expect(b).toBe(a)
  })
})
