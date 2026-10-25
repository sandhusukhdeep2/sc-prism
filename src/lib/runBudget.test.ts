import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ABS_CEILING_MS,
  DEFAULT_TURN_BUDGET,
  MAX_STALL_MS,
  MIN_STALL_MS,
  SUSPEND_OUTLIER_MS,
  UNREACHABLE_DETAIL,
  UNREACHABLE_TEXT,
  cancelledDetail,
  cancelledText,
  isLoadFailure,
  lastStepFromSpans,
  latencyFromSpans,
  loadFailedDetail,
  loadFailedText,
  slowLocalNotice,
  stubDetail,
  stubText,
  turnBudget,
  waitWithBudget,
  weStoppedIt,
} from './runBudget'
import type { EngineSpan } from './nativeEngine'

function call(route: 'local' | 'cloud', model: string, ms: number, start = 1): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    duration_ms: ms,
    start,
    attrs: { route, model, is_local: route === 'local' },
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
describe('latencyFromSpans', () => {
  it('rolls real model_call spans up per route', () => {
    const stats = latencyFromSpans([
      call('cloud', 'opus', 27_000),
      call('cloud', 'opus', 27_200),
      call('local', 'Qwen3.8-27B-4bit', 64_800),
      call('local', 'Qwen3.8-27B-4bit', 67_500),
    ])
    expect(stats.cloud).toMatchObject({ route: 'cloud', model: 'opus', samples: 2 })
    expect(stats.local).toMatchObject({ route: 'local', model: 'Qwen3.8-27B-4bit', samples: 2 })
    expect(stats.local!.p90Ms).toBe(67_500)
  })

  // Real evidence from the user's own spans.jsonl: single model_call spans of
  // 46,863s and 18,073s across a darkwake, sitting next to ordinary 65s ones.
  // Those are the Mac sleeping, not the model thinking. Averaging them in would
  // produce a budget of hours, which would hide every stall forever.
  it('drops slept-through calls instead of smoothing them into the budget', () => {
    const stats = latencyFromSpans([
      call('local', 'Qwen3.8-27B-4bit', 64_800),
      call('local', 'Qwen3.8-27B-4bit', 67_500),
      call('local', 'Qwen3.8-27B-4bit', 46_863_147), // 13 hours across a darkwake
    ])
    expect(stats.local!.samples).toBe(2)
    expect(stats.local!.p90Ms).toBeLessThan(SUSPEND_OUTLIER_MS)
  })

  it('budgets the local model actually CONFIGURED, not an average of every one ever used', () => {
    const spans = [
      call('local', 'gemma-4-26b-a4b-it-4bit', 4_900),
      call('local', 'gemma-4-26b-a4b-it-4bit', 5_300),
      call('local', 'Qwen3.8-27B-4bit', 64_800),
      call('local', 'Qwen3.8-27B-4bit', 67_500),
    ]
    expect(latencyFromSpans(spans, 'Qwen3.8-27B-4bit').local!.p50Ms).toBe(67_500)
    expect(latencyFromSpans(spans, 'gemma-4-26b-a4b-it-4bit').local!.p50Ms).toBe(5_300)
  })

  it('ignores non-model spans and unusable rows', () => {
    const stats = latencyFromSpans([
      { name: 'plan', type: 'hook', duration_ms: 0.02, start: 1 },
      { name: 'model_call', type: 'model_call', start: 2 }, // no duration
      { name: 'model_call', type: 'model_call', duration_ms: 500, start: 3 }, // no route
    ])
    expect(stats).toEqual({ local: null, cloud: null })
  })
})

describe('lastStepFromSpans', () => {
  it('returns the newest closed step with its route and model', () => {
    const step = lastStepFromSpans([
      call('cloud', 'opus', 27_000, 100),
      { name: 'vault_read', type: 'tool_exec', start: 150, attrs: {} },
      call('local', 'Qwen3.8-27B-4bit', 64_800, 200),
    ])
    expect(step).toMatchObject({ at: 200, route: 'local', model: 'Qwen3.8-27B-4bit' })
  })

  it('returns null when the tail carries nothing usable', () => {
    expect(lastStepFromSpans([])).toBeNull()
    expect(lastStepFromSpans([{ name: 'x' }])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
describe('turnBudget', () => {
  it('with nothing measured, reproduces the historical 90s wall exactly', () => {
    expect(DEFAULT_TURN_BUDGET.stallMs).toBe(90_000)
    expect(DEFAULT_TURN_BUDGET.measured).toBe(false)
    expect(DEFAULT_TURN_BUDGET.basis).toContain('no calls measured yet')
  })

  // The heart of FIX 1. The old wall was set when every turn was cloud-fast;
  // the egress floor then made vault-reading runs local-speed by design.
  it('pays for the SLOWER route, because a vault read can pin the rest of a run local', () => {
    const stats = latencyFromSpans([
      call('cloud', 'opus', 27_000),
      call('cloud', 'opus', 27_200),
      call('local', 'Qwen3.8-27B-4bit', 115_000),
      call('local', 'Qwen3.8-27B-4bit', 295_000),
    ])
    const b = turnBudget(stats)
    expect(b.perCallMs).toBe(295_000) // local, not the 27s cloud number
    expect(b.stallMs).toBeGreaterThan(90_000)
    expect(b.basis).toContain('your local model')
    expect(b.basis).toContain('Qwen3.8-27B-4bit')
  })

  it('never drops below the historical wall and never becomes an unbounded constant', () => {
    const fast = turnBudget(latencyFromSpans([call('cloud', 'fable', 3_100), call('cloud', 'fable', 4_100)]))
    expect(fast.stallMs).toBe(MIN_STALL_MS)

    const glacial = turnBudget(latencyFromSpans([call('local', 'slow', 800_000)]))
    expect(glacial.stallMs).toBe(MAX_STALL_MS)
    expect(glacial.ceilingMs).toBeLessThanOrEqual(ABS_CEILING_MS)
  })

  it('the ceiling always exceeds the stall, so progress can actually be re-earned', () => {
    for (const ms of [3_000, 60_000, 200_000, 500_000]) {
      const b = turnBudget(latencyFromSpans([call('local', 'm', ms)]))
      expect(b.ceilingMs).toBeGreaterThan(b.stallMs)
    }
  })
})

// ---------------------------------------------------------------------------
// The egress floor is UNCHANGED — this fix pays for it, it does not weaken it.
// ---------------------------------------------------------------------------
describe('the vault egress floor is untouched', () => {
  it('a vault-pinned local run raises the BUDGET; nothing here re-routes it', () => {
    // The exact shape of the reported run: cloud, cloud, then (after a vault
    // read) local for the remainder. The honest response is a bigger budget.
    const vaultRun = latencyFromSpans([
      call('cloud', 'opus', 27_000),
      call('cloud', 'opus', 27_200),
      call('local', 'Qwen3.8-27B-4bit', 64_800),
      call('local', 'Qwen3.8-27B-4bit', 67_500),
    ])
    const budget = turnBudget(vaultRun)
    expect(budget.perCallMs).toBe(67_500) // the LOCAL tail sets the price
    expect(budget.stallMs).toBeGreaterThanOrEqual(MIN_STALL_MS)
  })

  it('no client-side code in this fix can force a run off the local route', () => {
    // A grep-shaped guard: the budget/copy layer and the interview turn must
    // never carry a route override. The floor lives in loop.py
    // (VAULT_LOCAL_REASON) and is asserted there by the engine suite; what this
    // pins is that the CLIENT never learned to argue with it.
    for (const f of ['src/lib/runBudget.ts', 'src/lib/projectInterview.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/route\s*[:=]\s*['"]cloud['"]/)
      expect(src).not.toMatch(/is_local\s*[:=]\s*false/)
      expect(src).not.toMatch(/VAULT_LOCAL_REASON\s*=/)
    }
  })
})

// ---------------------------------------------------------------------------
// The bounded wait
// ---------------------------------------------------------------------------
describe('waitWithBudget', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('returns the work when it finishes inside the stall window', async () => {
    const out = await waitWithBudget(sleep(5).then(() => 'ok'), { stallMs: 200, ceilingMs: 400 })
    expect(out).toEqual({ done: true, value: 'ok' })
  })

  it('a run that keeps closing steps keeps earning stall windows', async () => {
    let step = 0
    const t = setInterval(() => {
      step += 1
    }, 10)
    const out = await waitWithBudget(sleep(200).then(() => 'ok'), {
      stallMs: 30,
      ceilingMs: 5_000,
      progress: () => step,
    })
    clearInterval(t)
    expect(out).toEqual({ done: true, value: 'ok' })
  })

  it('a stalled run is still cut at the stall window', async () => {
    const out = await waitWithBudget(new Promise(() => {}), {
      stallMs: 20,
      ceilingMs: 5_000,
      progress: () => 42, // frozen
    })
    expect(out).toMatchObject({ done: false, reason: 'stalled' })
  })

  it('with no progress probe at all it degrades to one flat wall', async () => {
    const out = await waitWithBudget(new Promise(() => {}), { stallMs: 20, ceilingMs: 5_000 })
    expect(out).toMatchObject({ done: false, reason: 'stalled' })
  })

  it('the ceiling bites a run that progresses forever', async () => {
    let step = 0
    const t = setInterval(() => {
      step += 1
    }, 5)
    const out = await waitWithBudget(new Promise(() => {}), {
      stallMs: 15,
      ceilingMs: 60,
      progress: () => step,
    })
    clearInterval(t)
    expect(out).toMatchObject({ done: false, reason: 'ceiling' })
  })

  it('reports honest elapsed time', async () => {
    const out = await waitWithBudget(new Promise(() => {}), { stallMs: 30, ceilingMs: 500 })
    expect(out.done).toBe(false)
    if (!out.done) expect(out.elapsedMs).toBeGreaterThanOrEqual(25)
  })

  it('re-throws the work’s rejection exactly as a bare race did', async () => {
    await expect(
      waitWithBudget(Promise.reject(new Error('boom')), { stallMs: 100, ceilingMs: 200 }),
    ).rejects.toThrow('boom')
  })

  // Bailing out early must not leave the abandoned promise unhandled: a bare
  // `Promise.race` that attaches a fresh `.then` per poll would, and an
  // unhandled rejection can take the whole app down.
  it('a bail-out leaves no unhandled rejection when the abandoned work later fails', async () => {
    const onUnhandled = vi.fn()
    const proc = (globalThis as { process?: { on: Function; off: Function } }).process!
    proc.on('unhandledRejection', onUnhandled)
    const work = sleep(40).then(() => {
      throw new Error('late failure')
    })
    const out = await waitWithBudget(work, { stallMs: 10, ceilingMs: 20 })
    expect(out.done).toBe(false)
    await sleep(80)
    proc.off('unhandledRejection', onUnhandled)
    expect(onUnhandled).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The three honest endings (FIX 2)
// ---------------------------------------------------------------------------
describe('the three endings never wear each other’s words', () => {
  const facts = {
    elapsedMs: 187_000,
    reason: 'stalled' as const,
    stallMs: 90_000,
    ceilingMs: 360_000,
    lastStep: { at: 1, route: 'local' as const, model: 'Qwen3.8-27B-4bit' },
    localTypicalMs: 115_000,
  }

  it('(a) cancellation names US, the elapsed, and what it was doing', () => {
    const t = cancelledText(facts)
    expect(t).toContain('Stopped after 187s')
    expect(t).toContain('we cancelled this run')
    expect(t).toContain('The AI did not fail and was not unreachable.')
    expect(t).toContain('your local model (Qwen3.8-27B-4bit)')
    expect(t).toContain('reading your vault keeps the rest of a run local')
    expect(t).not.toMatch(/could not be reached/i)
    expect(t).not.toMatch(/placeholder/i)
  })

  it('(a) makes no claim about the model when there is no span evidence', () => {
    const t = cancelledText({ ...facts, lastStep: undefined, localTypicalMs: undefined })
    expect(t).toContain('we cancelled this run')
    expect(t).not.toMatch(/local model|cloud/i)
  })

  it('(a) the ceiling variant says it was still working, not that it stalled', () => {
    const t = cancelledText({ ...facts, reason: 'ceiling', elapsedMs: 604_000 })
    expect(t).toContain('at its 360s ceiling')
    expect(t).toContain('still working when we stopped it')
    expect(t).not.toContain('looked stuck')
  })

  it('(a) the one-line row detail says the same thing', () => {
    const d = cancelledDetail(facts)
    expect(d).toContain('we stopped it at 187s')
    expect(d).toContain('our cancellation, not a provider failure')
    expect(d).not.toMatch(/could not be reached/i)
  })

  it('(b) unreachable says nothing came back — and that nothing was cancelled', () => {
    expect(UNREACHABLE_TEXT).toContain('no reply at all')
    expect(UNREACHABLE_TEXT).toContain('nothing was cancelled')
    expect(UNREACHABLE_TEXT).not.toMatch(/placeholder/i)
    expect(UNREACHABLE_DETAIL).toContain('could not be reached')
  })

  it('(c) stub says placeholder — and that nothing stalled or was cancelled', () => {
    const named = stubText('the claude CLI did not answer within 180s')
    expect(named).toContain('placeholder')
    expect(named).toContain('the claude CLI did not answer within 180s')
    expect(named).toContain('Nothing was cancelled here')
    expect(named).not.toMatch(/could not be reached/i)

    const bare = stubText('')
    expect(bare).toContain('no real provider to call')
    expect(stubDetail('')).toContain('placeholder reply')
    expect(stubDetail('x')).toBe('placeholder reply — x')
  })

  it('the short background form still names our own wall', () => {
    expect(weStoppedIt(240_000)).toBe('we stopped it at 240s — our own wall, not a provider failure')
    expect(weStoppedIt(240_000, 'maybe a held approval')).toContain('(maybe a held approval)')
  })
})

// ---------------------------------------------------------------------------
// FIX 3 — the measured warning
// ---------------------------------------------------------------------------
describe('slowLocalNotice', () => {
  it('says nothing when there is nothing measured, or the local model is fast', () => {
    expect(slowLocalNotice({ local: null, cloud: null })).toBe('')
    expect(slowLocalNotice(latencyFromSpans([call('local', 'gemma-4-26b-a4b-it-4bit', 5_000)]))).toBe('')
  })

  it('states the measured numbers, and the floor that makes them matter', () => {
    const n = slowLocalNotice(
      latencyFromSpans([
        call('local', 'Qwen3.8-27B-4bit', 115_000),
        call('local', 'Qwen3.8-27B-4bit', 295_000),
      ]),
    )
    expect(n).toContain('Qwen3.8-27B-4bit')
    expect(n).toContain('295s')
    expect(n).toContain('reads your vault stays on this model')
    expect(n).toContain('not a fault') // factual, not an accusation
  })
})

// ---------------------------------------------------------------------------
// (d) The FOURTH ending — the local model could not be LOADED (2026-08-17)
// ---------------------------------------------------------------------------
//
// The server answered in milliseconds with HTTP 507 and "projected memory
// 42.36GB would exceed the metal_cap memory ceiling 24.96GB". The engine
// swallowed the status into the deterministic stub and the app told the user
// his provider was unreachable — so he looked for a network fault that never
// existed while his server sat there, up, answering.
describe('the local model could not load', () => {
  // Exactly what the engine emits (gateway.py :: local_load_failure).
  const REASON =
    'local model could not load: not enough GPU memory — this model needs 42.4 GB ' +
    'and the server’s ceiling is 25.0 GB (the server said, HTTP 507: ' +
    '"projected memory 42.36GB would exceed the metal_cap memory ceiling 24.96GB")'

  it('recognises the engine’s marker, and nothing else', () => {
    expect(isLoadFailure(REASON)).toBe(true)
    expect(isLoadFailure('the claude CLI did not answer within 180s')).toBe(false)
    expect(isLoadFailure('')).toBe(false)
  })

  it('says out of memory with the server’s own numbers — never "unreachable"', () => {
    const text = loadFailedText(REASON)
    expect(text).toContain('couldn’t load')
    expect(text).toContain('not enough GPU memory')
    expect(text).toContain('42.4 GB')
    expect(text).toContain('25.0 GB')
    expect(text).toMatch(/unload a model/i)
    // The two lies this replaces.
    expect(text).not.toMatch(/unreachable/i)
    expect(text).not.toMatch(/start the server/i)
    expect(loadFailedDetail(REASON)).toContain('couldn’t load')
    expect(loadFailedDetail(REASON)).toContain('not unreachable')
  })

  it('routes through the stub copy, so no caller can print the old wording', () => {
    // Every surface that renders an engine reason goes through stubText/detail.
    expect(stubText(REASON)).toBe(loadFailedText(REASON))
    expect(stubDetail(REASON)).toBe(loadFailedDetail(REASON))
    expect(stubText(REASON)).not.toContain('placeholder')
    // An ordinary named stub is untouched.
    expect(stubText('the claude CLI did not answer within 180s')).toContain('placeholder')
  })
})
