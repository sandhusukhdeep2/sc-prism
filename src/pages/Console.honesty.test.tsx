import { describe, expect, it } from 'vitest'
import type { DashHook, DashModelCost } from '../engine/types'
import { bucketProviders, hookBadge, hookHealth } from './Console'

// Finding 3 (2026-08-09 honesty pass). Ground truth from the user's live vault:
// `cost_by_model` providers are `claude-cli` / `gemini-cli` / `local`; the stop
// hook has 36 errors; the dispatch hook's avg_ms is 687,098 because it wraps
// the whole model call.

const model = (provider: string, tokens: number, cost = 0): DashModelCost => ({
  calls: 1,
  tokens_in: tokens,
  tokens_out: 0,
  tokens,
  cost,
  provider,
})

const hook = (over: Partial<DashHook>): DashHook => ({
  fires: 0,
  total_ms: 0,
  avg_ms: 0,
  blocks: 0,
  errors: 0,
  ...over,
})

describe('Console — token burn buckets by the providers the engine really emits', () => {
  it('attributes claude-cli / gemini-cli tokens instead of leaving both bars at zero', () => {
    const providers = bucketProviders({
      'claude-sonnet-4': model('claude-cli', 69833),
      'gemini-2.5-pro': model('gemini-cli', 12000),
      'qwen-local': model('local', 209340),
    })
    const byLabel = Object.fromEntries(providers.map((p) => [p.label, p.tokens]))
    // The bug: `provider === 'claude'` never matched, so this was 0.
    expect(byLabel.claude).toBe(69833)
    expect(byLabel.gemini).toBe(12000)
    expect(byLabel.local).toBe(209340)
    // Every bar carries real height — none of them is the 6% floor stub.
    expect(providers.every((p) => p.tokens > 0)).toBe(true)
  })

  it('sums several models onto their shared provider and sorts by burn', () => {
    const providers = bucketProviders({
      a: model('claude-cli', 100),
      b: model('claude-cli', 50),
      c: model('local', 400),
    })
    expect(providers.map((p) => [p.label, p.tokens])).toEqual([
      ['local', 400],
      ['claude', 150],
    ])
  })

  it('marks only the local provider as local (a cloud CLI is still cloud)', () => {
    const providers = bucketProviders({ a: model('claude-cli', 1), b: model('local', 1) })
    expect(providers.find((p) => p.key === 'claude-cli')!.isLocal).toBe(false)
    expect(providers.find((p) => p.key === 'local')!.isLocal).toBe(true)
  })

  it('an unknown/new provider key is still bucketed, never dropped on the floor', () => {
    const providers = bucketProviders({ a: model('codex-cli', 77, 0.5) })
    expect(providers).toEqual([
      { key: 'codex-cli', label: 'codex', tokens: 77, cost: 0.5, isLocal: false },
    ])
  })

  it('no model calls -> no bars (an empty state, not zeros pretending to be data)', () => {
    expect(bucketProviders({})).toEqual([])
  })
})

describe('Console — hook latency excludes the dispatch wrapper and labels it', () => {
  it('averages the gate hooks only, so a 687s model call cannot become "latency"', () => {
    const h = hookHealth({
      dispatch: hook({ fires: 51, total_ms: 35_042_000, avg_ms: 687_098, blocks: 0 }),
      stop: hook({ fires: 51, total_ms: 510, avg_ms: 10 }),
      plan: hook({ fires: 51, total_ms: 1020, avg_ms: 20 }),
    })
    // (510 + 1020) / 102 = 15ms — not the old 170,039.5ms.
    expect(h.avgMs).toBeCloseTo(15, 5)
    expect(h.dispatchAvgMs).toBe(687_098)
    // The sparkline series must not carry the dispatch outlier either.
    expect(h.latencies).toEqual([10, 20])
    // Fire/block counts still cover every hook.
    expect(h.fires).toBe(153)
  })

  it('reports no average at all when only dispatch ran', () => {
    const h = hookHealth({ dispatch: hook({ fires: 3, total_ms: 300, avg_ms: 100 }) })
    expect(h.avgMs).toBeNull()
  })
})

describe('Console — hook errors can never read "healthy"', () => {
  it('surfaces the real error count instead of a green badge', () => {
    const h = hookHealth({
      stop: hook({ fires: 51, total_ms: 510, avg_ms: 10, errors: 36 }),
      plan: hook({ fires: 51, total_ms: 510, avg_ms: 10 }),
    })
    expect(h.errors).toBe(36)
    const badge = hookBadge(h)
    expect(badge.label).toBe('36 errors')
    expect(badge.cls).not.toBe('console__badge--ok')
    expect(badge.label).not.toBe('healthy')
  })

  it('errors outrank blocks (a blocking, erroring layer is not merely "enforcing")', () => {
    const h = hookHealth({ stop: hook({ fires: 5, total_ms: 50, avg_ms: 10, blocks: 2, errors: 1 }) })
    expect(hookBadge(h).label).toBe('1 errors')
  })

  it('blocks with no errors still read "enforcing"', () => {
    const h = hookHealth({ stop: hook({ fires: 5, total_ms: 50, avg_ms: 10, blocks: 2 }) })
    expect(hookBadge(h).label).toBe('enforcing')
  })

  it('a clean, fired hook layer may read healthy', () => {
    const h = hookHealth({ stop: hook({ fires: 5, total_ms: 50, avg_ms: 10 }) })
    expect(hookBadge(h)).toEqual({ label: 'healthy', cls: 'console__badge--ok' })
  })

  it('no hook data reads neutral, never healthy', () => {
    expect(hookBadge(null).label).toBe('no data yet')
    expect(hookBadge(hookHealth({})).cls).toBe('console__badge--muted')
  })

  // Finding 3b. The badge read a red "53 errors" over an enforcement layer that
  // was working perfectly: a `stop` span's status=error records "compliance
  // ratchet: FAIL — task not done", i.e. the hook RAN and correctly refused to
  // call an unfinished task done. Those are the same 53 events the Stats hero
  // was miscounting as saves, and they are not hook errors.
  it('a hook that recorded a FAILING run is enforcing, not erroring', () => {
    const h = hookHealth({
      stop: hook({ fires: 53, total_ms: 530, avg_ms: 10, errors: 0, failed_outcomes: 53 }),
    })
    expect(h.errors).toBe(0)
    expect(h.failedOutcomes).toBe(53)
    const badge = hookBadge(h)
    expect(badge.label).toBe('enforcing')
    expect(badge.label).not.toContain('error')
  })

  it('a hook that genuinely threw still outranks enforcement', () => {
    const h = hookHealth({
      stop: hook({ fires: 53, total_ms: 530, avg_ms: 10, errors: 2, failed_outcomes: 51 }),
    })
    expect(hookBadge(h).label).toBe('2 errors')
  })
})
