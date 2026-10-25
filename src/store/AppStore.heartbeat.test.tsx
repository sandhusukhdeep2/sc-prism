import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Verdict } from '../engine/types'
// The wake's client wall, taken from the source rather than re-typed here: it
// is DERIVED from the wake's turn budget (see AppStore.timeout.test.ts), so a
// literal in this file would turn a correct widening of that budget into a
// false failure — which is exactly what it did on 2026-08-27.
import { WAKE_TIMEOUT_MS, WAKE_TOKEN_BUDGET } from './AppStore'

// Hoisted spies for the seams the heartbeat wake drives (same harness shape
// as AppStore.timeoutHonesty: force native, stub the vault side-effects,
// leave storeGet PENDING for every key EXCEPT 'managers' so SettingsProvider
// never flips `hydrated` and the connectivity cold-probe never runs).
// 'managers' reads resolve from a per-test queue: the FIRST is the managers
// module's own disk hydration, the SECOND is heartbeatWake's multi-instance
// double-wake guard — default empty queue → null (no disk copy), so the
// guard proceeds and every pre-guard scenario is byte-identical.
const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  // Default: the write SUCCEEDS (returns the written path) — the failure
  // path is opted into per-test with mockResolvedValueOnce(null).
  writeVaultNote: vi.fn(
    async (_vault: string, rel: string, _content: string): Promise<string | null> =>
      `/vault/${rel}`,
  ),
  cancelEngineRun: vi.fn(async () => {}),
  managersDisk: [] as (string | null)[],
  // The vault's file metadata — the unchanged-state guard's raw material.
  // Default empty: a vault with no notes, stable across wakes.
  vaultMeta: [] as { path: string; mtime: number; size: number }[],
  // The Mac's wake state (2026-08-15 §1). Default 'unknown' — the honest
  // production default when the signal cannot be read, and the one that RUNS,
  // so every pre-existing scenario below is byte-identical.
  power: { state: 'unknown', detail: '' } as { state: string; detail: string },
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
    readPowerState: async () => h.power,
    listVaultTreeMeta: async () => h.vaultMeta,
  }
})

// Seed the persisted managers store BEFORE the module singleton loads (boot()
// resets modules, so the fresh import reads this).
function seedManagersStore(heartbeat: Record<string, unknown>): void {
  localStorage.setItem(
    'scprism.managers',
    JSON.stringify({
      managers: [
        { id: 'mgr-companion', providerId: 'primary', name: 'Companion', enabled: false, heartbeat },
      ],
      jobs: [],
      seeded: true,
    }),
  )
}

// Fresh module registry per test: the managers store is a module singleton
// whose state loads at import time, so each scenario needs its own import.
// EVERY provider must come from the SAME fresh registry — mixing a fresh
// AppProvider with a stale SettingsProvider would split the React contexts.
const captured: {
  state?: import('./AppStore').AppState
  wakeNow?: () => Promise<string | null>
  claimEngine?: () => boolean
} = {}

async function boot() {
  vi.resetModules()
  const settings = await import('../lib/settings')
  const connectivity = await import('../lib/connectivity')
  const store = await import('./AppStore')
  const managers = await import('../lib/managers')
  const S = settings.SettingsProvider
  const C = connectivity.ConnectivityProvider
  const A = store.AppProvider
  // Capture the FRESH module's app state so tests can assert on it (Mission
  // Control's live-run list rides the same heartbeat transition as the orb).
  captured.state = undefined
  captured.wakeNow = undefined
  const Capture = () => {
    const app = store.useApp()
    captured.state = app.state
    // "Wake now" (2026-08-05 §Part 3) is a context action, captured the same
    // way — the tests below drive the REAL button path, not a private copy.
    captured.wakeNow = app.wakeNow
    captured.claimEngine = app.claimEngine
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

// A minimal REAL completion — the wake only reads response + token counts.
const wakeVerdict = (response: string): Verdict =>
  ({ response, tokensIn: 100, tokensOut: 20 }) as unknown as Verdict

const companionHb = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  charter: 'watch the projects and vault',
  everyMinutes: 30,
  lastBeat: 0,
  beats: [],
  ...over,
})

describe('manager driver — heartbeat wake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'unknown', detail: '' }
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('a due heartbeat runs ONE wake, records a worked beat, advances lastBeat, and appends the reply to the vault report', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('Drafted a vault summary.\nDetail below.'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // one driver tick
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    // The wake's "ONE small piece of work" is a REAL bound: the budget rides
    // the run as the trailing tokenBudget arg (chat runs pass nothing → 0).
    // Taken from the constant, because the number was SIZED by measuring real
    // wakes — the first one that ever finished its research spent 26,364 and
    // was failed for breaching the old 20k, i.e. graded down for having done
    // the work. A literal here would make that correction look like a
    // regression.
    expect(h.runNativeTask.mock.calls[0][6]).toBe(WAKE_TOKEN_BUDGET)
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.lastBeat).toBeGreaterThan(0) // the cadence advanced
    expect(hb.beats).toHaveLength(1)
    expect(hb.beats[0]).toMatchObject({
      action: 'worked',
      ok: true,
      line: 'Drafted a vault summary.',
      tokens: 120, // REAL in+out sum from the verdict
    })
    // 'worked' appends the FULL reply to reports/<manager-slug>/heartbeat.md.
    expect(h.writeVaultNote).toHaveBeenCalledTimes(1)
    const [, rel, body] = h.writeVaultNote.mock.calls[0]
    expect(rel).toBe('reports/companion/heartbeat.md')
    expect(body).toContain('Drafted a vault summary.')
  })

  it('NOTHING_NEEDED → a rested beat carrying the honest line, and NO vault report write', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet day'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0]).toMatchObject({ action: 'rested', ok: true, line: 'quiet day' })
    expect(h.writeVaultNote).not.toHaveBeenCalled()
  })

  it('a disabled heartbeat NEVER reaches the engine', async () => {
    seedManagersStore(companionHb({ enabled: false }))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000) // several ticks — still nothing
    })

    expect(h.runNativeTask).not.toHaveBeenCalled()
  })

  it('a whitespace-only reply records a FAILED rested beat — no vault write, no clean rest', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('   \n  '))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0]).toMatchObject({
      action: 'rested',
      ok: false,
      line: 'blank reply — nothing recorded',
    })
    expect(h.writeVaultNote).not.toHaveBeenCalled()
  })

  it('a failed report write records ok:false with the honest suffix — never a clean beat over a missing report', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('Drafted a vault summary.'))
    h.writeVaultNote.mockResolvedValueOnce(null) // the write FAILS
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0]).toMatchObject({
      action: 'worked',
      ok: false,
      line: 'Drafted a vault summary. (report write failed)',
    })
  })

  it('a client-wall timeout records its OWN honest line (not "provider offline"), tokens 0, and kills the wedged child', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockImplementation(() => new Promise(() => {})) // wedged run
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // the tick starts the wake
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS) // the client bound fires
    })

    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0]).toMatchObject({
      action: 'rested',
      ok: false,
      // FIX 2 (2026-08-16): the line must name OUR cancellation, never imply
      // the provider failed — and the "held approval" guess is now clearly a
      // hedge among possibilities, not an assertion. The DURATION comes from
      // the constant for the same reason the timer above does: the wall is
      // derived from the wake's turn budget, so a literal here would fail the
      // moment that budget is corrected.
      line: `we stopped it at ${Math.round(WAKE_TIMEOUT_MS / 1000)}s — our own wall, not a provider failure (it may have been on a held tool approval, or still answering on your local model)`,
      tokens: 0, // the killed run's provider-side spend is unknowable
    })
    expect(h.cancelEngineRun).toHaveBeenCalledTimes(1)
  })

  it('skips WITHOUT recording when the DISK store shows another app instance already beat', async () => {
    seedManagersStore(companionHb()) // in-memory copy: lastBeat 0 → due
    // storeGet('managers') queue: hydration read → null (keep the seeded
    // localStorage view), guard read → a disk copy whose lastBeat is NOW
    // (the second instance just beat).
    h.managersDisk.push(
      null,
      JSON.stringify({
        managers: [
          {
            id: 'mgr-companion',
            providerId: 'primary',
            name: 'Companion',
            enabled: false,
            heartbeat: companionHb({ lastBeat: Date.now() }),
          },
        ],
        jobs: [],
        seeded: true,
      }),
    )
    h.runNativeTask.mockResolvedValue(wakeVerdict('should never run'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).not.toHaveBeenCalled() // the other instance's beat is the real one
    expect(managers.getManagers().managers[0].heartbeat!.beats).toHaveLength(0) // nothing recorded
  })
})

// Mission Control (2026-08-05): the wake's live CARD and the orb's pulse are
// the SAME signal (`SET_HEARTBEAT_LIVE`) — not a second heartbeat flag that
// could drift or leak. These pin that unification in both directions.
describe('manager driver — the heartbeat wake is ONE live signal (orb + card)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'unknown', detail: '' }
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('registers a heartbeat live run WHILE the wake runs and clears it when the beat is recorded', async () => {
    seedManagersStore(companionHb())
    let release: ((v: Verdict) => void) | null = null
    h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // the tick starts the wake
    })

    // Live: the orb line and the live-run entry appear together, from the one
    // transition — a card cannot glow without the orb also being live.
    expect(captured.state!.heartbeatLive).not.toBeNull()
    expect(captured.state!.liveRuns).toHaveLength(1)
    expect(captured.state!.liveRuns[0].kind).toBe('heartbeat')
    expect(captured.state!.liveRuns[0].intent).toBe(captured.state!.heartbeatLive)

    await act(async () => {
      release!(wakeVerdict('Drafted a vault summary.'))
      await Promise.resolve()
    })

    // Idle again: both cleared by the SAME finally, with the real beat outcome.
    expect(captured.state!.heartbeatLive).toBeNull()
    expect(captured.state!.liveRuns).toHaveLength(0)
    expect(captured.state!.finishedRuns[0]).toMatchObject({
      kind: 'heartbeat',
      outcome: 'passed',
      detail: 'Drafted a vault summary.',
    })
  })

  it('a wake that TIMES OUT still clears the live run and records it as stopped', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockImplementation(() => new Promise(() => {})) // wedged run
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(captured.state!.liveRuns).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS) // the client bound fires
    })

    expect(captured.state!.liveRuns).toHaveLength(0) // no card left glowing
    expect(captured.state!.heartbeatLive).toBeNull()
    expect(captured.state!.finishedRuns[0]).toMatchObject({ kind: 'heartbeat', outcome: 'stopped' })
  })

  it('a disabled heartbeat registers NO live run at all', async () => {
    seedManagersStore(companionHb({ enabled: false }))
    await boot()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(captured.state!.liveRuns).toHaveLength(0)
    expect(captured.state!.finishedRuns).toHaveLength(0)
  })
})

// --- "Wake now" (2026-08-05 spec §Part 3) -----------------------------------
//
// The orb popover and the Agents card both fire ONE immediate beat down the
// SAME governed path a scheduled wake takes. These pin that it really is the
// same path (engine call with the 20k budget, a real Beat record, the live-run
// registration that lights the card/orb/console), that it fires exactly once
// per click, and that it refuses with an honest reason instead of doing
// nothing quietly.
describe('heartbeat — Wake now', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'unknown', detail: '' }
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  // lastBeat = now → NOT due, so nothing the driver tick does can be mistaken
  // for the manual wake under test.
  const notDueHb = (over: Record<string, unknown> = {}) =>
    companionHb({ lastBeat: Date.now(), ...over })

  it('fires exactly ONE real wake: the engine call, a real beat, and the live run registered then cleared', async () => {
    seedManagersStore(notDueHb())
    let release: ((v: Verdict) => void) | null = null
    h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
    const { managers } = await boot()
    const before = managers.getManagers().managers[0].heartbeat!.lastBeat

    let result: string | null = 'unset'
    let pending: Promise<string | null> | null = null
    await act(async () => {
      pending = captured.wakeNow!()
      await Promise.resolve()
    })

    // ONE governed run, with the SAME 20k token budget a scheduled wake carries.
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    expect(h.runNativeTask.mock.calls[0][6]).toBe(WAKE_TOKEN_BUDGET)
    // ...and the orb + card light up from the one existing transition.
    expect(captured.state!.heartbeatLive).toContain('you asked')
    expect(captured.state!.liveRuns).toHaveLength(1)
    expect(captured.state!.liveRuns[0].kind).toBe('heartbeat')

    await act(async () => {
      release!(wakeVerdict('Drafted a vault summary.'))
      result = await pending!
    })

    expect(result).toBeNull() // null = it really ran
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats).toHaveLength(1)
    expect(hb.beats[0]).toMatchObject({
      action: 'worked',
      ok: true,
      line: 'Drafted a vault summary.',
      tokens: 120, // the REAL in+out sum, same as any beat
    })
    // The cadence moves exactly as a real beat moves it — no more, no less:
    // lastBeat IS the recorded beat's timestamp, nothing custom for a manual
    // wake. (`before` was the seeded stamp this wake replaced.)
    expect(hb.lastBeat).toBe(hb.beats[0].at)
    expect(hb.lastBeat).toBeGreaterThanOrEqual(before)
    // Nothing left glowing.
    expect(captured.state!.liveRuns).toHaveLength(0)
    expect(captured.state!.heartbeatLive).toBeNull()
    expect(captured.state!.finishedRuns[0]).toMatchObject({ kind: 'heartbeat', outcome: 'passed' })
  })

  it('cannot double-fire: a second click while one is in flight refuses, and the engine runs once', async () => {
    seedManagersStore(notDueHb())
    let release: ((v: Verdict) => void) | null = null
    h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
    const { managers } = await boot()

    let second: string | null = 'unset'
    let first: Promise<string | null> | null = null
    await act(async () => {
      first = captured.wakeNow!()
      second = await captured.wakeNow!() // the rapid second click
    })

    expect(second).toBe('a wake is already running')
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)

    await act(async () => {
      release!(wakeVerdict('Drafted a vault summary.'))
      await first!
    })
    // ONE beat for ONE wake — a double-fire would have recorded two.
    expect(managers.getManagers().managers[0].heartbeat!.beats).toHaveLength(1)
  })

  it('an OFF heartbeat refuses with the honest reason and never reaches the engine', async () => {
    seedManagersStore(companionHb({ enabled: false }))
    const { managers } = await boot()

    let reason: string | null = null
    await act(async () => {
      reason = await captured.wakeNow!()
    })

    expect(reason).toBe('heartbeat is off — turn it on first')
    expect(h.runNativeTask).not.toHaveBeenCalled()
    expect(managers.getManagers().managers[0].heartbeat!.beats).toHaveLength(0)
  })

  it('a busy engine refuses with the honest reason — it does not queue or silently no-op', async () => {
    seedManagersStore(notDueHb())
    await boot()
    // Another runner holds the app's ONE engine slot — the same claim a team
    // launch or the loop driver takes.
    expect(captured.claimEngine!()).toBe(true)

    let reason: string | null = null
    await act(async () => {
      reason = await captured.wakeNow!()
    })

    expect(reason).toBe('the engine is busy with another run')
    expect(h.runNativeTask).not.toHaveBeenCalled()
  })

  it('a manual wake still records an honest FAILED beat when no real reply comes back', async () => {
    seedManagersStore(notDueHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('')) // blank = not a real completion
    const { managers } = await boot()

    await act(async () => {
      await captured.wakeNow!()
    })

    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0].ok).toBe(false)
    expect(h.writeVaultNote).not.toHaveBeenCalled()
    expect(captured.state!.liveRuns).toHaveLength(0)
  })
})

// --- Don't work on a sleeping Mac (2026-08-15 spec §1) ----------------------
//
// A maintenance DarkWake gave a wake ~90s of real CPU time spread over 48
// minutes of wall clock (4f95483 measured it from pmset) before the app's own
// cancel killed it — a run that cannot finish, paid for anyway. These pin the
// three states: dark SKIPS (and says so), full RUNS, and an unreadable signal
// RUNS, because work is never skipped on a guess.
describe('heartbeat — the dark-wake gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'unknown', detail: '' }
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('a DARK wake spends nothing and records the honest skipped beat', async () => {
    h.power = { state: 'dark', detail: 'a maintenance (dark) wake — capabilities: CPU Network' }
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('should never run'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    // Nothing was spent: no engine call, no vault write, no live run left over.
    expect(h.runNativeTask).not.toHaveBeenCalled()
    expect(h.writeVaultNote).not.toHaveBeenCalled()
    expect(captured.state!.liveRuns).toHaveLength(0)
    // …and the gap is EXPLAINED rather than silent.
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats).toHaveLength(1)
    expect(hb.beats[0]).toMatchObject({ action: 'rested', ok: true, tokens: 0 })
    expect(hb.beats[0].line).toContain('skipped — the Mac was in a maintenance wake, nothing ran')
    expect(hb.beats[0].line).toContain('CPU Network') // the machine's own words
    // The cadence advanced, so a long dark wake cannot flood the beat log.
    expect(hb.lastBeat).toBe(hb.beats[0].at)
  })

  it('a REAL (full) wake still runs exactly as before', async () => {
    h.power = { state: 'full', detail: 'awake — capabilities: CPU Graphics Audio Network' }
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('Drafted a vault summary.'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    expect(managers.getManagers().managers[0].heartbeat!.beats[0]).toMatchObject({
      action: 'worked',
      line: 'Drafted a vault summary.',
    })
  })

  it('an INDETERMINATE state runs — never skip work on a guess', async () => {
    h.power = { state: 'unknown', detail: 'pmset could not be run' }
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('Drafted a vault summary.'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
  })

  it('a MANUAL wake is never refused on a power reading — the user is at the machine', async () => {
    h.power = { state: 'dark', detail: 'a maintenance (dark) wake — capabilities: CPU Network' }
    seedManagersStore(companionHb({ lastBeat: Date.now() })) // not due: only the button can fire
    h.runNativeTask.mockResolvedValue(wakeVerdict('Drafted a vault summary.'))
    const { managers } = await boot()

    await act(async () => {
      await captured.wakeNow!()
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    expect(managers.getManagers().managers[0].heartbeat!.beats[0]).toMatchObject({
      action: 'worked',
    })
  })
})

// --- He interviews the user to earn the business leg (2026-08-15 spec §4) ---
//
// The wake may END its reply with an ASK_BUSINESS block. These pin the whole
// contract from the driver's side: the questions land on the DESK (never in a
// chat), asking is not "work", an unanswered question becomes no content
// anywhere, and the same question is never asked twice.
describe('heartbeat — the business interview', () => {
  const askBlock = (...qs: string[]) =>
    ['```ASK_BUSINESS', ...qs.map((q) => `q: ${q}`), '```'].join('\n')

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'full', detail: 'awake' }
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('offers the interview in the prompt when nothing is waiting and the note is thin', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet'))
    await boot()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const intent = h.runNativeTask.mock.calls[0][0] as string
    // The ladder facts, the honest "you were told nothing", and the ask block.
    expect(intent).toContain('Ladder state, as the app can actually verify it right now')
    expect(intent).toContain('You have been given NO business context')
    expect(intent).toContain('ASK_BUSINESS')
    expect(intent).toContain('never write as if a question had been answered')
  })

  it('parks up to three questions on the DESK, and asking is not counted as work', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(
        `NOTHING_NEEDED — nothing to do until I know more\n\n${askBlock('Who are your biggest clients?', 'What do you charge?', 'Who signs off on spend?', 'A fourth one?')}`,
      ),
    )
    const { managers } = await boot()
    const interview = await import('../lib/businessInterview')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    const set = interview.openSet(interview.list())
    expect(set).not.toBeNull()
    expect(set!.questions).toEqual([
      'Who are your biggest clients?',
      'What do you charge?',
      'Who signs off on spend?',
    ])
    // Asking is NOT work: the beat still rests, and no report is written.
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0].action).toBe('rested')
    expect(hb.beats[0].line).toContain('asked you 3 questions on the desk')
    expect(hb.beats[0].line).toContain('1 more were dropped')
    // No heartbeat REPORT entry — a rested wake writes none. (The only vault
    // write here is the questions ledger, which holds questions, never facts.)
    const wroteReport = h.writeVaultNote.mock.calls.some((c) => c[1].startsWith('reports/'))
    expect(wroteReport).toBe(false)
  })

  it('an UNANSWERED set never becomes knowledge — no note is written, and the next wake is told it knows nothing', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(`NOTHING_NEEDED — quiet\n\n${askBlock('Who are your biggest clients?')}`),
    )
    await boot()
    const interview = await import('../lib/businessInterview')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(interview.openSet(interview.list())).not.toBeNull()
    // The question exists; the ANSWER does not — nothing was written to the
    // context note (writeVaultNote here only ever wrote the questions ledger).
    const wroteContext = h.writeVaultNote.mock.calls.some((c) => c[1] === 'business/context.md')
    expect(wroteContext).toBe(false)
  })

  it('does NOT ask again while a set is open, and says why', async () => {
    seedManagersStore(companionHb())
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(`NOTHING_NEEDED — quiet\n\n${askBlock('Who are your biggest clients?')}`),
    )
    const { managers } = await boot()
    const interview = await import('../lib/businessInterview')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    // Second wake: same reply, one open set already on the desk.
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(`NOTHING_NEEDED — quiet\n\n${askBlock('What do you charge?')}`),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 60_000)
    })

    expect(interview.list().filter((s) => s.status === 'open')).toHaveLength(1)
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0].line).toContain('questions ignored (a question set is already open')
    // …and that wake's prompt never invited a question in the first place.
    const secondIntent = h.runNativeTask.mock.calls[1][0] as string
    expect(secondIntent).not.toContain('ASK_BUSINESS')
  })
})

// ---------------------------------------------------------------------------
// The unchanged-state guard (2026-08-28): a wake must never pay a model call
// to discover that nothing changed. The day this fixes: eleven hourly wakes,
// 48,826 tokens, seven of them concluding "Same 8 notes, the same 'new' node
// cli project". The comparison is deterministic and free; the model is only
// woken for state it has not already seen.
// ---------------------------------------------------------------------------
describe('unchanged-state guard — an unchanged world rests for free', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.cancelEngineRun.mockClear()
    h.managersDisk.length = 0
    h.power = { state: 'unknown', detail: '' }
    h.vaultMeta = []
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('the second wake over identical state rests for FREE — no engine call, no live run', async () => {
    seedManagersStore(companionHb({ everyMinutes: 30 }))
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet day'))
    const { managers } = await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000) // first wake: pays, stamps the print
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 60_000) // next cadence: nothing changed
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1) // still one — the rest was free
    const hb = managers.getManagers().managers[0].heartbeat!
    expect(hb.beats[0]).toMatchObject({ action: 'rested', ok: true, tokens: 0 })
    expect(hb.beats[0].line).toContain('nothing changed')
    expect(captured.state!.liveRuns).toHaveLength(0) // no orb flash for a free rest
  })

  it('changed vault state wakes the model again', async () => {
    seedManagersStore(companionHb({ everyMinutes: 30 }))
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet day'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)

    // Someone edits a note between beats — genuinely new state.
    h.vaultMeta = [{ path: 'notes/idea.md', mtime: 111, size: 5 }]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 60_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(2)
  })

  it('a MANUAL wake always runs — the user pressed the button', async () => {
    seedManagersStore(companionHb({ everyMinutes: 30 }))
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet day'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)

    await act(async () => {
      await captured.wakeNow!() // unchanged state, but he asked
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(2)
  })

  it('after half a day of quiet the wake re-anchors with one real beat', async () => {
    seedManagersStore(companionHb({ everyMinutes: 30 }))
    h.runNativeTask.mockResolvedValue(wakeVerdict('NOTHING_NEEDED — quiet day'))
    await boot()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)

    // Thirteen quiet hours: every cadence beat in between rests free; the
    // first one past the 12h re-anchor floor runs for real — an idle vault
    // must not mean the companion never checks in again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13 * 60 * 60_000)
    })
    expect(h.runNativeTask).toHaveBeenCalledTimes(2)
  })
})
