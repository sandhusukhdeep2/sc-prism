import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatTurnFromOutcome,
  connectivityErrorText,
  raceCancelable,
  raceEngineWithTimeout,
  timeoutErrorText,
  type RaceOutcome,
  CHAT_TIMEOUT_MS,
  ENGINE_CLI_WALL_MS,
  WAKE_MAX_TOKENS,
  WAKE_STEPS,
  WAKE_TIMEOUT_MS,
  chatWallMs,
  wakeWallMs,
} from './AppStore'
import { ABS_CEILING_MS, UNATTENDED_CEILING_MS } from '../lib/runBudget'
import type { Verdict } from '../engine/types'

// The engine-timeout seam. When an engine call outruns its hard timeout the
// race now reports a TAGGED outcome so a caller can tell a slow-but-live
// provider (timeout) apart from a genuine null-from-the-engine (real error) —
// the honesty fix. The abandoned run's late resolution is still discarded (it
// can never surface a stale verdict), and on a timeout the retained subprocess
// is really cancelled (raceCancelable → cancelEngineRun). These tests pin all
// of that so a future refactor can't quietly reintroduce the old "unreachable —
// nothing was sent" lie or a stale-write.
describe('raceEngineWithTimeout (tagged timeout seam)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tags the engine value when the engine WINS the race', async () => {
    const work = Promise.resolve({ verdict: 'real' })
    await expect(raceEngineWithTimeout(work, 1000)).resolves.toEqual({
      timedOut: false,
      value: { verdict: 'real' },
    })
  })

  it('tags a TIMEOUT distinctly (never collapsed into the engine value)', async () => {
    // A run that never settles — only the timeout can resolve the race.
    const neverSettles = new Promise<{ verdict: string }>(() => {})
    const p = raceEngineWithTimeout(neverSettles, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    // The distinguishing bit: { timedOut: true }, NOT a bare null (which used to
    // be indistinguishable from a real engine null).
    await expect(p).resolves.toEqual({ timedOut: true })
  })

  it('preserves the ability to carry a real ENGINE null under timedOut:false', async () => {
    // A genuine null from the engine (error / not-native) is NOT a timeout — it
    // rides under timedOut:false so callers can treat it as a real failure.
    await expect(raceEngineWithTimeout(Promise.resolve(null), 1000)).resolves.toEqual({
      timedOut: false,
      value: null,
    })
  })

  it('a timed-out run: its LATE result is dropped, never applied over the timeout outcome', async () => {
    let resolveWork!: (v: { verdict: string }) => void
    const work = new Promise<{ verdict: string }>((r) => (resolveWork = r))

    let applied: unknown = 'UNSET'
    const done = raceEngineWithTimeout(work, 1000).then((res) => (applied = res))

    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(applied).toEqual({ timedOut: true })

    // The abandoned engine run resolves LATE — Promise.race dropped the loser, so
    // this has no continuation and the caller's outcome must stay the timeout.
    resolveWork({ verdict: 'stale — should be ignored' })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(applied).toEqual({ timedOut: true })
  })

  it('a slow OLDER run cannot apply its LATE result over a NEWER run (run-id guard)', async () => {
    const applied: string[] = []
    let currentRunId = 0
    const drive = async (work: Promise<{ verdict: string }>, myRunId: number) => {
      const res = await raceEngineWithTimeout(work, 5000)
      if (currentRunId !== myRunId) return 'superseded'
      if (!res.timedOut && res.value) applied.push(res.value.verdict)
      return 'applied'
    }

    let resolveOld!: (v: { verdict: string }) => void
    const oldWork = new Promise<{ verdict: string }>((r) => (resolveOld = r))
    const oldRunId = ++currentRunId
    const oldRun = drive(oldWork, oldRunId)

    ++currentRunId // a newer run supersedes the old one

    resolveOld({ verdict: 'stale from the superseded run' })
    await vi.advanceTimersByTimeAsync(0)

    await expect(oldRun).resolves.toBe('superseded')
    expect(applied).toEqual([])
  })
})

// raceCancelable — the real cancel. On a timeout it must fire cancelEngineRun so
// the retained subprocess is killed (no zombie, no overlap with the next tick);
// on the normal engine-wins path it must NEVER cancel.
describe('raceCancelable (cancel-on-timeout)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('issues cancel(runId) exactly once when the run TIMES OUT', async () => {
    const cancel = vi.fn()
    const neverSettles = new Promise<Verdict | null>(() => {})
    const p = raceCancelable(neverSettles, 1000, 'run-abc', cancel)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toEqual({ timedOut: true })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('run-abc')
  })

  it('never cancels when the engine WINS (normal path is untouched)', async () => {
    const cancel = vi.fn()
    const work = Promise.resolve<Verdict | null>(null)
    const outcome = await raceCancelable(work, 1000, 'run-xyz', cancel)
    expect(outcome).toEqual({ timedOut: false, value: null })
    expect(cancel).not.toHaveBeenCalled()
  })
})

// chatTurnFromOutcome — the pure decision sendIntent makes. A TIMEOUT is a
// distinct 'timeout' (slow but live → do NOT mark the provider down); a real
// null / offline-stub is 'error' (genuine unreachable → mark down). This is the
// exact fork that keeps a slow provider from being falsely reported unreachable.
describe('chatTurnFromOutcome (honest timeout vs genuine error)', () => {
  const verdict = (response: string | undefined): Verdict =>
    ({ response, taskId: 't1' }) as unknown as Verdict

  it('classifies a TIMEOUT as its own kind — never an error', () => {
    expect(chatTurnFromOutcome({ timedOut: true })).toEqual({ kind: 'timeout' })
  })

  it('classifies a real completion as ok (carrying the verdict + real response)', () => {
    const v = verdict('here is your answer')
    expect(chatTurnFromOutcome({ timedOut: false, value: v })).toEqual({
      kind: 'ok',
      verdict: v,
      response: 'here is your answer',
    })
  })

  it('classifies a genuine null from the engine as error', () => {
    expect(chatTurnFromOutcome({ timedOut: false, value: null })).toEqual({ kind: 'error' })
  })

  it('classifies an offline-stub completion as error (not a real reply)', () => {
    const stub: RaceOutcome<Verdict | null> = { timedOut: false, value: verdict('[offline: sim]') }
    expect(chatTurnFromOutcome(stub)).toEqual({ kind: 'error' })
  })

  // 2026-08-17: the local server ANSWERED — HTTP 507, "would exceed the
  // metal_cap memory ceiling" — and the app called it unreachable, sending the
  // user after a network fault that never existed. A refused LOAD is its own
  // kind, so the send path can name the real cause and must NOT mark a live
  // server down (which would gate the next send and tell him to start it).
  it('classifies a refused LOAD as its own kind, never as an unreachable provider', () => {
    const reason =
      'local model could not load: not enough GPU memory — this model needs 42.4 GB ' +
      'and the server’s ceiling is 25.0 GB (the server said, HTTP 507: ' +
      '"projected memory 42.36GB would exceed the metal_cap memory ceiling 24.96GB")'
    const turn = chatTurnFromOutcome({
      timedOut: false,
      value: verdict(`[offline:local:Qwen3.8-27B-4bit] ${reason}`),
    })
    expect(turn.kind).toBe('loadFailed')
    expect(turn.kind === 'loadFailed' && turn.reason).toBe(reason)
  })
})

// timeoutErrorText — the honest copy. It must NOT reuse the "unreachable —
// nothing was sent" claim (which was the lie on a timeout: the run WAS sent),
// and since 2026-08-16 it must positively name WHO stopped the run and after
// how long. A user comparing this card to a real outage had nothing to tell
// them apart; "we stopped the run" is the difference.
describe('timeoutErrorText (honest timeout copy)', () => {
  it('names our own cancellation and the wall — never "unreachable / nothing was sent"', () => {
    const text = timeoutErrorText('Local model')
    expect(text).toContain('Local model')
    expect(text).toContain('we stopped the run')
    expect(text).toContain('our own wall, not a provider failure')
    // The default floor, whatever it is set to — hardcoding it here is how the
    // floor came to sit BELOW the engine's own CLI wall without a test noticing.
    expect(text).toContain(`${Math.round(CHAT_TIMEOUT_MS / 1000)}s`)
    expect(text).not.toContain('unreachable')
    expect(text).not.toContain('nothing was sent')
  })

  it('reports the REAL wall it was given, not a hardcoded floor', () => {
    expect(timeoutErrorText('Local model', 300_000)).toContain('300s')
  })

  it('is DISTINCT from the genuine-unreachable copy', () => {
    expect(timeoutErrorText('Local model')).not.toBe(
      connectivityErrorText('Local model', 'unreachable'),
    )
  })
})

// THE BUG THIS EXISTS TO PREVENT, stated plainly because it cost 34 runs.
//
// The client wall was 120s while the ENGINE allows an agentic CLI 180s. So on
// every call slower than two minutes the app killed a run the engine was still
// legitimately working on, and then told Sukhdeep — accurately, and uselessly —
// "that was our own wall, not a provider failure". Claude Code was stopped at
// 137s on a call it would have finished; his 35B local model was stopped at
// 120s on a laptop where one call can honestly cost minutes. The whole product
// looked broken because of one number.
//
// A client wall below the engine's can never be a useful stop: it cannot report
// a provider's verdict, only our own impatience.
describe('the client never gives up before the engine does', () => {
  it('the chat floor clears the engine’s own CLI wall', () => {
    expect(CHAT_TIMEOUT_MS).toBeGreaterThanOrEqual(ENGINE_CLI_WALL_MS)
  })

  it('the derived wall clears it with a margin, on any machine budget', () => {
    for (const stallMs of [0, 30_000, 200_000, 600_000]) {
      expect(chatWallMs({ stallMs } as never)).toBeGreaterThan(ENGINE_CLI_WALL_MS)
    }
  })

  it('a slower machine still wins — the floor never caps a real measurement', () => {
    expect(chatWallMs({ stallMs: 600_000 } as never)).toBe(600_000)
  })
})

// THE SECOND HALF OF THE SAME BUG, found on 2026-08-27 in the real beat log.
//
// Clearing the engine's CLI wall was necessary and not sufficient. The wake's
// 240s wall cleared 180s and still killed EVERY unattended beat, because a CLI
// call is not what a wake spends its time on: it reads the business note, the
// egress floor then pins the rest of the run to the on-device model, and a
// local call on Sukhdeep's Mac was timed between 33s and 413s. A whole wake is
// six to eight of those — ten to fifteen minutes. Twenty-two of his last forty
// beats read "we stopped it at 240s"; not one wake in that window completed.
//
// The lesson that cost the most: a FIXED wall is the wrong shape, whatever its
// value, because the honest number depends on how fast this particular Mac
// answers. So the wake now spends the same measured per-machine budget the chat
// uses. These tests pin that it can never again be capped below what the
// machine has actually been observed to need.
describe('a wake waits as long as THIS machine actually takes', () => {
  const budget = (ceilingMs: number, stallMs = 0) => ({ ceilingMs, stallMs }) as never

  it('spends the measured ceiling when the machine is slower than the floor', () => {
    // The measured reality on the user's Mac: a wake needs ten minutes plus.
    expect(wakeWallMs(budget(600_000))).toBe(600_000)
  })

  it('never drops below the floor on a machine with no measurements yet', () => {
    expect(wakeWallMs(budget(0))).toBe(WAKE_TIMEOUT_MS)
    expect(wakeWallMs(budget(60_000))).toBe(WAKE_TIMEOUT_MS)
  })

  // THE CLIP THAT KEPT KILLING IT. The measured ceiling is capped for
  // interactive work at ten minutes — a patience budget for someone watching a
  // spinner. A wake that does its work honestly measured eleven to fifteen
  // minutes here, so that cap, not the old 240s, was the next thing in its way.
  it('is not clipped at the INTERACTIVE ceiling — nobody is waiting on a beat', () => {
    // A machine whose stall window alone implies more than ten minutes of work.
    const slow = budget(ABS_CEILING_MS, 300_000)
    expect(wakeWallMs(slow)).toBeGreaterThan(ABS_CEILING_MS)
  })

  it('is still clipped SOMEWHERE — a wedged run may not hold the hour', () => {
    expect(wakeWallMs(budget(99_999_999, 99_999_999))).toBe(UNATTENDED_CEILING_MS)
  })

  it('the unattended ceiling clears the slowest wake actually observed', () => {
    // 15 minutes was the worst measured; the ceiling must sit above it or it
    // becomes the new 240s.
    expect(UNATTENDED_CEILING_MS).toBeGreaterThan(15 * 60_000)
  })

  it('clears the engine’s own CLI wall at every machine speed', () => {
    for (const ceilingMs of [0, 60_000, 240_000, 600_000]) {
      expect(wakeWallMs(budget(ceilingMs))).toBeGreaterThan(ENGINE_CLI_WALL_MS)
    }
  })

  it('the wall that broke — 240s — is one no machine can produce any more', () => {
    for (const ceilingMs of [0, 100_000, 240_000, 600_000]) {
      expect(wakeWallMs(budget(ceilingMs))).toBeGreaterThan(240_000)
    }
  })

  it('a faster machine is never made to wait for a slower one’s floor... upward only', () => {
    // The floor is a floor, not a target: a genuinely slower measurement always
    // wins, and a faster one can never shorten the wall below what unattended
    // work is allowed to take.
    expect(wakeWallMs(budget(900_000))).toBe(900_000)
    expect(wakeWallMs(budget(1_000))).toBe(WAKE_TIMEOUT_MS)
  })
})

// The other half of making a wake finish: not just waiting longer, but costing
// less. The wake's answer ceiling is what the local model spends its minutes
// on — measured, capping it took the worst call in a wake from 413s to 237s.
describe('a wake asks for a summary, not an essay', () => {
  it('caps the answer well below the engine’s research-sized default of 4096', () => {
    expect(WAKE_MAX_TOKENS).toBeLessThan(4096)
  })

  it('still leaves a reasoning model room to think AND answer', () => {
    // The replies that carried real content measured ~200 output tokens; a cap
    // that tight would truncate a model that thinks before it speaks.
    expect(WAKE_MAX_TOKENS).toBeGreaterThanOrEqual(600)
  })
})

// The engine gained `--steps` and the app did not use it for two hours — the
// fix existed and never reached the product. These pin the wiring, not just
// the number.
describe('a wake is one piece of work, so it plans one step', () => {
  it('plans exactly one step', () => {
    expect(WAKE_STEPS).toBe(1)
  })

  it('the wake’s own charter calls it ONE piece of work, so three was a mismatch', () => {
    // Measured: the default three-step plan cost 15m24s and 69,976 tokens to
    // return "I ran out of tool turns"; one step cost 4m29s and 8,993.
    expect(WAKE_STEPS).toBeLessThan(3)
  })
})
