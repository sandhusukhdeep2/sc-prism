import { describe, expect, it } from 'vitest'
import type { Verdict } from '../engine/types'
import type { EngineSpan } from './nativeEngine'
import {
  buildLocalModelReport,
  modelStatusUrl,
  parseModelStatus,
  qualityForModel,
  speedForModel,
  verdictRanOnModel,
  type LocalServerStatus,
} from './localModels'

// Choosing a local model on EVIDENCE (2026-08-17).
//
// He ran his slowest local model for days (115s p50) while a faster, stronger
// one sat unused, because the picker was a bare list of ids. These tests hold
// the rules that make the picker honest: measured numbers only, a model that
// cannot load says so BEFORE it is chosen, and an unrun model is never ranked.

function call(model: string, ms: number, extra: Record<string, unknown> = {}): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    duration_ms: ms,
    start: 1,
    attrs: { route: 'local', is_local: true, model, ...extra },
  }
}

function verdict(models: string[], evalScore: number, judged = true): Verdict {
  return {
    taskId: 't',
    task: 'do the thing',
    route: { target: 'local', model: models[0] ?? '', via: '', reason: '', routeLabel: '' },
    tier1: { tests: '1/1', lint: true, build: true, pass: true },
    tier2: {
      evalScore,
      passed: evalScore >= 0.6,
      judge: 'DeepEval judge',
      trajectory: judged ? 'trajectory ok' : 'not run',
    },
    tokensIn: 10,
    tokensOut: 10,
    cost: 0,
    durationMs: 10,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed: true,
    native: {
      hooksFired: [],
      hookDecisions: [],
      blocks: 0,
      approvals: 0,
      memoryInjected: 0,
      disclosed: [],
      rejectedWrites: 0,
      cacheHits: 0,
      cacheMisses: 0,
      spansPath: '/vault/spans.jsonl',
      models_used: models.map((m) => `local · ${m}`),
    },
  }
}

const FAST = 'gemma-4-26b-a4b-it-4bit'
const SLOW = 'Qwen3.8-27B-4bit'
const UNRUN = 'glm-4.5-air-6bit'

describe('speed — measured from this vault, with runBudget\'s outlier drop', () => {
  it('reports p50 and tokens/sec from that model\'s own spans', () => {
    const spans = [
      call(FAST, 10_000, { tokens_out: 280 }),
      call(FAST, 10_000, { tokens_out: 280 }),
      call(FAST, 20_000, { tokens_out: 280 }),
    ]
    const s = speedForModel(spans, FAST)!
    expect(s.samples).toBe(3)
    expect(s.p50Ms).toBe(10_000)
    // 840 tokens over 40s.
    expect(s.tokensPerSec).toBeCloseTo(21, 0)
  })

  it('DROPS the sleep artefacts (>15 min) instead of averaging them in', () => {
    // Real shape from the vault: ordinary 65s calls next to a 13-HOUR span the
    // Mac slept through. Averaging that in would report this model at hours a
    // call and hide every real stall.
    const spans = [call(SLOW, 65_000), call(SLOW, 46_863_000), call(SLOW, 67_000)]
    const s = speedForModel(spans, SLOW)!
    expect(s.samples).toBe(2)
    expect(s.p90Ms).toBeLessThan(100_000)
  })

  it('never lends one model another model\'s numbers', () => {
    expect(speedForModel([call(FAST, 5_000)], UNRUN)).toBeNull()
  })

  it('ignores placeholder (is_real=false) calls — a stub is not a timing', () => {
    expect(speedForModel([call(FAST, 400, { is_real: false })], FAST)).toBeNull()
  })
})

describe('quality — the Tier-2 judge, on his own runs', () => {
  it('averages the judged scores of runs that named this model', () => {
    const q = qualityForModel([verdict([SLOW], 0.9), verdict([SLOW], 0.72), verdict([FAST], 0.4)], SLOW)!
    expect(q.runs).toBe(2)
    expect(q.mean).toBeCloseTo(0.81, 2)
  })

  it('never attributes a run to a model that did not appear in models_used', () => {
    expect(qualityForModel([verdict([FAST], 0.9)], UNRUN)).toBeNull()
    expect(verdictRanOnModel(verdict([FAST], 0.9), UNRUN)).toBe(false)
  })

  it('never attributes a sim verdict (no native block) to anything', () => {
    const sim = verdict([FAST], 0.9)
    delete (sim as { native?: unknown }).native
    expect(qualityForModel([sim], FAST)).toBeNull()
  })

  it('does not average in the zero of a run the judge never looked at', () => {
    // mapVerdict writes evalScore 0 when Tier-2 was short-circuited. Counting
    // it would invent a bad review nobody gave.
    const q = qualityForModel([verdict([SLOW], 0.9), verdict([SLOW], 0, false)], SLOW)!
    expect(q.runs).toBe(1)
    expect(q.mean).toBeCloseTo(0.9, 5)
  })

  it('matches the model EXACTLY — a prefix is a different model', () => {
    expect(verdictRanOnModel(verdict(['qwen3-8b-4bit'], 0.8), 'qwen3-8b')).toBe(false)
    expect(verdictRanOnModel(verdict(['qwen3-8b'], 0.8), 'qwen3-8b')).toBe(true)
  })
})

describe('the server\'s own report', () => {
  const raw = JSON.stringify({
    load_seconds_per_gb_estimate: 1.6,
    memory: { final_ceiling: 24.96, current_model_memory: 21.0 },
    models: [
      { id: FAST, size_gb: 15.2 },
      { id: SLOW, size_gb: 21.36, loaded: true },
      { id: UNRUN, size_gb: 42.36 },
    ],
  })

  it('reads the ceiling, what is resident, the load rate and per-model sizes', () => {
    const s = parseModelStatus(raw)!
    expect(s.ceilingGb).toBeCloseTo(24.96, 2)
    expect(s.residentGb).toBeCloseTo(21.0, 2)
    expect(s.loadSecondsPerGb).toBeCloseTo(1.6, 2)
    expect(s.sizeGb[UNRUN]).toBeCloseTo(42.36, 2)
    expect(s.resident).toContain(SLOW)
  })

  it('reports nothing rather than a default when the server says nothing', () => {
    const s = parseModelStatus('{"models":[{"id":"a"}]}')!
    expect(s.ceilingGb).toBeNull()
    expect(s.loadSecondsPerGb).toBeNull()
    expect(s.sizeGb).toEqual({})
  })

  it('returns null for a body it cannot parse — never a fabricated status', () => {
    expect(parseModelStatus('<html>nope</html>')).toBeNull()
  })

  it('builds the status URL from the configured base', () => {
    expect(modelStatusUrl('http://localhost:1234/')).toBe('http://localhost:1234/v1/models/status')
  })
})

describe('the rows', () => {
  // Nothing resident: every listed model fits, so the speed/quality rules are
  // what the rows are about.
  const status: LocalServerStatus = {
    ceilingGb: 24.96,
    residentGb: 0,
    loadSecondsPerGb: 1.6,
    sizeGb: { [FAST]: 15.2, [SLOW]: 21.36, [UNRUN]: 42.36 },
    resident: [],
  }
  // The real machine at the moment of the 507: the 21.36 GB model is loaded, so
  // a second one projects to 42.36 GB against a 24.96 GB ceiling — exactly the
  // arithmetic the server printed.
  const tight: LocalServerStatus = { ...status, residentGb: 21.0, resident: [SLOW] }
  const spans = [
    call(FAST, 9_800, { tokens_out: 280 }),
    call(FAST, 9_800, { tokens_out: 280 }),
    call(SLOW, 115_000, { tokens_out: 300 }),
    call(SLOW, 115_000, { tokens_out: 300 }),
  ]
  const verdicts = [verdict([SLOW], 0.81), verdict([SLOW], 0.81), verdict([FAST], 0.6)]

  const report = () =>
    buildLocalModelReport({ models: [SLOW, FAST, UNRUN], spans, verdicts, status, selected: SLOW })

  it('shows each measured model its own speed and judged quality', () => {
    const rows = report().rows
    const fast = rows.find((r) => r.id === FAST)!
    expect(fast.speed!.p50Ms).toBe(9_800)
    expect(fast.speed!.tokensPerSec).toBeCloseTo(28.6, 1)
    expect(fast.quality!.mean).toBeCloseTo(0.6, 2)
    expect(fast.suggestion).toContain('fastest here')
    expect(fast.suggestion).toContain('tok/s')

    const slow = rows.find((r) => r.id === SLOW)!
    expect(slow.quality!.mean).toBeCloseTo(0.81, 2)
    expect(slow.suggestion).toContain('highest judged quality')
    expect(slow.suggestion).toContain('0.81')
  })

  it('an unrun model shows the honest empty state and is NOT ranked', () => {
    const rows = report().rows
    const unrun = rows.find((r) => r.id === UNRUN)!
    expect(unrun.measured).toBe(false)
    expect(unrun.ranked).toBe(false)
    expect(unrun.speed).toBeNull()
    expect(unrun.quality).toBeNull()
    // Unmeasured rows sort last — after every ranked one — and say why.
    expect(rows[rows.length - 1].id).toBe(UNRUN)
  })

  it('marks a model that cannot load RIGHT NOW, before it is selected', () => {
    // 21 GB is resident and a second 21.36 GB model projects to 42.36 GB
    // against a 24.96 GB ceiling: the server answers 507, which the app used to
    // report as "the provider is unreachable" AFTER he had already chosen it.
    const rows = buildLocalModelReport({
      models: [SLOW, FAST, UNRUN],
      spans,
      verdicts,
      status: tight,
      selected: SLOW,
    }).rows
    const second = rows.find((r) => r.id === FAST)!
    expect(second.fit).toBe('wont-load')
    expect(second.suggestion).toContain("won't load right now")
    expect(second.suggestion).toContain('21 GB already resident')
    expect(second.suggestion).toContain('25 GB ceiling')
    // The model already up is not accused of failing to load.
    expect(rows.find((r) => r.id === SLOW)!.fit).toBe('resident')
  })

  it('marks a model too big for the ceiling even on an empty server', () => {
    const unrun = report().rows.find((r) => r.id === UNRUN)!
    expect(unrun.fit).toBe('wont-load')
    expect(unrun.suggestion).toContain('42 GB needed')
  })

  it('never recommends a model that cannot load right now', () => {
    const r = buildLocalModelReport({ models: [SLOW, FAST, UNRUN], spans, verdicts: [], status: tight })
    expect(r.recommendation).toContain(SLOW) // the resident one
    expect(r.recommendation).toContain('can load right now')
    expect(r.recommendation).not.toContain(FAST)
  })

  it('states the load cost as the server\'s estimate, from its own rate', () => {
    const fast = report().rows.find((r) => r.id === FAST)!
    expect(fast.loadEstimateSec).toBeCloseTo(15.2 * 1.6, 1)
    expect(report().note).toContain("server's own estimate")
  })

  it('recommends on a named basis, and never recommends what cannot load', () => {
    const r = report()
    expect(r.recommendation).toContain(SLOW)
    expect(r.recommendation).toContain('highest judged quality')
    expect(r.recommendation).toContain('0.81')
    expect(r.recommendation).not.toContain(UNRUN)
  })

  it('recommends NOTHING when nothing has been measured, and says so', () => {
    const r = buildLocalModelReport({
      models: [SLOW, FAST, UNRUN],
      spans: [],
      verdicts: [],
      status,
    })
    expect(r.recommendation).toBe('')
    expect(r.note).toContain('nothing to recommend')
    for (const row of r.rows) expect(row.ranked).toBe(false)
  })

  it('falls back to speed for the recommendation when nothing was judged', () => {
    const r = buildLocalModelReport({ models: [SLOW, FAST], spans, verdicts: [], status })
    expect(r.recommendation).toContain(FAST)
    expect(r.recommendation).toContain('fastest measured here')
  })

  it('says fit is unknown — never "fits" — when the server reported no status', () => {
    const r = buildLocalModelReport({ models: [FAST, UNRUN], spans, verdicts, status: null })
    for (const row of r.rows) expect(row.fit).toBe('unknown')
    expect(r.note).toContain('did not report its memory status')
  })
})
