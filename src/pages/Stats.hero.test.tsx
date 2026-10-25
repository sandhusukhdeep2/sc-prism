import { describe, expect, it } from 'vitest'
import type { Dashboard, DashTier1, Verdict } from '../engine/types'
import { costDirection } from '../lib/costTrend'
import { heroSaves } from './Stats'

// Finding 4 (2026-08-09 honesty pass). The hero read the SESSION store, which
// only incremented on a Tier-1 pass — impossible while the verify command was
// unreachable (Finding 0) — so it was pinned at 0 while the engine held 51 real
// runs. It now derives from the engine's measured tier1 span history, and an
// honest zero always carries the reason it is zero.

const tier1 = (over: Partial<DashTier1>): DashTier1 => ({
  runs: 0,
  ran: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  not_found: 0,
  caught: { tests: 0, lint: 0, build: 0, other: 0 },
  judged_runs: 0,
  avg_judge_tokens: 0,
  ...over,
})

const dash = (t1?: DashTier1): Dashboard =>
  ({
    vault: '/v',
    runs: 51,
    run_series: [],
    total_tokens: 279173,
    total_cost: 0.4,
    cost_by_model: {},
    cost_by_operation: {},
    token_burn_by_time: {},
    hooks: {},
    eval_trend: [],
    cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
    drift: [],
    healthy: true,
    ...(t1 ? { tier1: t1 } : {}),
  }) as Dashboard

const verdict = (over: Partial<Verdict>): Verdict =>
  ({
    taskId: 't',
    task: 'x',
    passed: true,
    tier1: { tests: '1/1', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.9, passed: true, judge: 'j', trajectory: 'ok' },
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'p', validated: true, committed: true },
    route: { target: 'local', model: 'local', via: 'gateway', reason: 'r', routeLabel: 'local' },
    tokensIn: 100,
    tokensOut: 20,
    cost: 0.01,
    durationMs: 1000,
    ...over,
  }) as unknown as Verdict

describe('Stats hero — derived from measured engine data', () => {
  it('reads the engine’s blocked runs, not the session store', () => {
    const h = heroSaves(
      dash(tier1({ runs: 51, ran: 51, passed: 0, failed: 51, caught: { tests: 51, lint: 0, build: 0, other: 0 } })),
      [],
    )
    expect(h.saves).toBe(51)
    expect(h.engineScoped).toBe(true)
    expect(h.caught.tests).toBe(51)
    expect(h.note).toContain('51 blocked across 51 checked runs')
  })

  it('a real zero says WHY it is zero (all runs passed the gate)', () => {
    const h = heroSaves(dash(tier1({ runs: 12, ran: 12, passed: 12, failed: 0 })), [])
    expect(h.saves).toBe(0)
    expect(h.note).toBe('nothing to block: all 12 checked runs passed Tier-1')
  })

  it('a zero with no runs at all says so instead of implying a measurement', () => {
    const h = heroSaves(dash(tier1({})), [])
    expect(h.saves).toBe(0)
    expect(h.note).toBe('no run has reached the Tier-1 gate yet')
  })

  it('a skipped gate is not reported as a save', () => {
    const h = heroSaves(dash(tier1({ runs: 9, ran: 0, passed: 9, skipped: 9, failed: 0 })), [])
    expect(h.saves).toBe(0)
    expect(h.note).toContain('no verify command configured')
  })

  // Tier-1 is a PROJECT gate. Chat messages, manager reports and heartbeat
  // wakes have no codebase, so the gate skips them — and telling a user who set
  // `npm test` that they configured no verify command is a flat lie.
  it('says WHY the gate skipped: no project bound, not "you configured nothing"', () => {
    const h = heroSaves(
      dash(
        tier1({
          runs: 40, ran: 0, passed: 40, skipped: 40, failed: 0,
          skipped_nothing_to_verify: 40, skipped_no_commands: 0,
        }),
      ),
      [],
    )
    expect(h.saves).toBe(0)
    expect(h.unrunnable).toBe(0)
    expect(h.unknown).toBe(0)
    expect(h.note).toContain('no project was bound')
    expect(h.note).toContain('nothing to verify')
    expect(h.note).not.toContain('no verify command configured')
  })

  it('reports both skip reasons when the history holds both', () => {
    const h = heroSaves(
      dash(
        tier1({
          runs: 12, ran: 0, passed: 12, skipped: 12, failed: 0,
          skipped_nothing_to_verify: 9, skipped_no_commands: 3,
        }),
      ),
      [],
    )
    expect(h.note).toContain('9 had no project bound')
    expect(h.note).toContain('3 had no verify command')
  })

  it('a skip never becomes a save, a caught failure, or an unverified run', () => {
    const h = heroSaves(
      dash(
        tier1({
          runs: 41, ran: 1, passed: 40, skipped: 40, failed: 1, blocked: 1,
          skipped_nothing_to_verify: 40,
          caught: { tests: 1, lint: 0, build: 0, other: 0 },
        }),
      ),
      [],
    )
    expect(h.saves).toBe(1)
    expect(h.ran).toBe(1)
    expect(h.caught.tests).toBe(1)
    expect(h.unrunnable).toBe(0)
    expect(h.unverifiedNote).toBe('')
  })

  it('surfaces runs where the verify command could not be found at all', () => {
    const h = heroSaves(dash(tier1({ runs: 51, ran: 51, failed: 51, not_found: 36, blocked: 15 })), [])
    expect(h.saves).toBe(15) // the 36 unrunnable runs are NOT saves
    expect(h.unrunnable).toBe(36)
    expect(h.unverifiedNote).toContain('36 runs could not run the verify command')
    expect(h.unverifiedNote).toContain('nothing was verified')
  })

  // Finding 3a, the cardinal sin. On the user's install ALL 53 Tier-1 failures
  // were the gate failing to RUN (`npm` could not find a project there), and
  // counting them produced a gold "53 saves · tests caught 53 · ~61k eval tokens
  // avoided" over 53 runs that verified nothing and avoided nothing.
  it('a gate that could never run produces ZERO saves, not a hero number', () => {
    const h = heroSaves(
      dash(
        tier1({
          runs: 53,
          ran: 53,
          failed: 53,
          not_found: 53,
          blocked: 0,
          judged_runs: 12,
          avg_judge_tokens: 1150,
        }),
      ),
      [],
    )
    expect(h.saves).toBe(0)
    expect(h.caught.tests).toBe(0)
    expect(h.note).toContain('nothing has been verified yet')
    expect(h.unverifiedNote).toContain('53 runs could not run the verify command')
    // And it must NOT price avoided tokens over runs that never reached a judge.
    expect(h.avoidedTokens).toBeNull()
    expect(h.avoidedBasis).toBe('nothing was blocked, so nothing was avoided')
  })

  // Historic spans predate the `not_found` attr entirely, so whether the gate
  // ran is genuinely unknown for them. Unknown is not "yes".
  it('failed runs recorded before the app knew why are claimed as neither', () => {
    const h = heroSaves(dash(tier1({ runs: 53, ran: 53, failed: 53, unknown: 53, blocked: 0 })), [])
    expect(h.saves).toBe(0)
    expect(h.unknown).toBe(53)
    expect(h.unverifiedNote).toContain('before the app recorded why')
  })

  it('a real save still reads as one', () => {
    const h = heroSaves(
      dash(
        tier1({
          runs: 20,
          ran: 20,
          failed: 5,
          blocked: 5,
          caught: { tests: 4, lint: 1, build: 0, other: 0 },
          judged_runs: 10,
          avg_judge_tokens: 900,
        }),
      ),
      [],
    )
    expect(h.saves).toBe(5)
    expect(h.note).toBe('5 blocked across 20 checked runs')
    expect(h.unverifiedNote).toBe('')
    expect(h.avoidedTokens).toBe(4500)
  })

  // Older dashboards carry neither `blocked` nor `unknown`; the split is still
  // derivable from the fields they DO carry, and must be.
  it('derives the real saves from an older dashboard shape', () => {
    const h = heroSaves(dash(tier1({ runs: 10, ran: 10, failed: 10, not_found: 10 })), [])
    expect(h.saves).toBe(0)
    expect(h.unrunnable).toBe(10)
  })

  it('prices avoided eval tokens ONLY from measured judge spend', () => {
    const unpriced = heroSaves(dash(tier1({ runs: 51, ran: 51, failed: 51 })), [])
    expect(unpriced.avoidedTokens).toBeNull()
    expect(unpriced.avoidedBasis).toBe('no judged run yet to price a save')

    const priced = heroSaves(
      dash(tier1({ runs: 10, ran: 10, failed: 4, judged_runs: 6, avg_judge_tokens: 250 })),
      [],
    )
    expect(priced.avoidedTokens).toBe(1000)
    expect(priced.avoidedBasis).toContain('over 6 judged runs')
  })

  it('falls back to the session and SAYS it is session-scoped', () => {
    const h = heroSaves(null, [
      verdict({ tier1: { tests: '?/1', lint: true, build: true, pass: false } } as Partial<Verdict>),
      verdict({}),
    ])
    expect(h.engineScoped).toBe(false)
    expect(h.saves).toBe(1)
    expect(h.note).toContain('THIS session')
  })

  it('an empty browser session is an honest empty state, not a measurement', () => {
    const h = heroSaves(null, [])
    expect(h.saves).toBe(0)
    expect(h.note).toContain('no runs in this session yet')
    expect(h.avoidedTokens).toBeNull()
  })
})

describe('Stats cost trend — a $0 sample cannot produce a victory line', () => {
  it('a terminal $0.00 run yields NO direction (it used to read "↓ 100% falling")', () => {
    expect(costDirection([0.02, 0])).toBe('none')
    expect(costDirection([0.02, 0.01, 0])).toBe('none')
  })

  it('a $0 baseline also yields no claim (nothing to compare against)', () => {
    expect(costDirection([0, 0.02])).toBe('none')
  })

  it('a genuine fall between two priced runs is still reported', () => {
    expect(costDirection([0.1, 0.05])).toBe('down')
  })

  it('a rise is still reported as a rise', () => {
    expect(costDirection([0.05, 0.1])).toBe('up')
  })
})
