import { describe, expect, it } from 'vitest'
import { DEFAULT_TOKEN_BUDGET, budgetStatus, clampBudget, dailyUsage } from './budget'

// ---------------------------------------------------------------------------
// The token budget controller (Sukhdeep, 2026-09-03: "I also need a controller
// that show me dependency on a local more or online more … How many token I
// use? What is the budget?").
//
// This exists because of a real failure. A live three-agent board spent 110,873
// tokens against the 100,000 default, the third agent never got a turn, and the
// manager returned an empty answer. The budget was doing its job — but it was
// INVISIBLE, so there was no way to see it coming or to raise it.
// ---------------------------------------------------------------------------

describe('clampBudget', () => {
  it('treats 0 and nonsense as "use the engine default"', () => {
    // 0 is the documented "engine decides" value on the CLI, so the setting
    // must round-trip it rather than coercing it to a real number.
    expect(clampBudget(0)).toBe(0)
    expect(clampBudget(Number.NaN)).toBe(0)
    expect(clampBudget(-5)).toBe(0)
    expect(clampBudget(undefined as unknown as number)).toBe(0)
  })

  it('keeps a sensible budget as given', () => {
    expect(clampBudget(250_000)).toBe(250_000)
  })

  it('refuses a budget too small to complete any real turn', () => {
    // A 500-token budget breaches before the first agent answers, producing a
    // run that always fails for a reason the user did not intend.
    expect(clampBudget(500)).toBe(10_000)
  })

  it('caps a runaway budget rather than letting one run empty a plan', () => {
    expect(clampBudget(99_000_000)).toBe(2_000_000)
  })

  it('rounds to whole tokens', () => {
    expect(clampBudget(150_000.7)).toBe(150_000)
  })
})

describe('budgetStatus', () => {
  const B = 100_000

  it('is calm well under the budget', () => {
    const s = budgetStatus(10_000, B)
    expect(s.level).toBe('ok')
    expect(s.pct).toBe(10)
  })

  it('warns before the run dies, not after', () => {
    // The whole point: the failure mode is silent until it is fatal.
    expect(budgetStatus(80_000, B).level).toBe('warn')
    expect(budgetStatus(99_999, B).level).toBe('warn')
  })

  it('reports over the moment the budget is reached', () => {
    // The engine breaches on >=, so 100% is already over — not "just at".
    expect(budgetStatus(100_000, B).level).toBe('over')
    expect(budgetStatus(110_873, B).level).toBe('over')
  })

  it('caps the bar at 100% but keeps the true number in the label', () => {
    const s = budgetStatus(110_873, B)
    expect(s.pct).toBe(100)
    expect(s.label).toContain('110,873')
    expect(s.label).toContain('100,000')
  })

  it('says what happens at the limit, not just that there is one', () => {
    expect(budgetStatus(110_873, B).note.toLowerCase()).toContain('stop')
  })

  it('falls back to the engine default when the budget is 0', () => {
    const s = budgetStatus(50_000, 0)
    expect(s.label).toContain(DEFAULT_TOKEN_BUDGET.toLocaleString())
    expect(s.pct).toBe(50)
  })

  it('never divides by zero or returns NaN', () => {
    for (const [used, budget] of [[0, 0], [5, 0], [0, 100], [-1, -1]]) {
      const s = budgetStatus(used, budget)
      expect(Number.isFinite(s.pct)).toBe(true)
      expect(s.pct).toBeGreaterThanOrEqual(0)
      expect(s.pct).toBeLessThanOrEqual(100)
    }
  })
})

// ---------------------------------------------------------------------------
// Found by Sukhdeep on the real screen, 2026-09-03: the card read
// "3,570,818 of 100,000 tokens today · This run stopped at the budget."
//
// 100,000 is a PER-RUN limit; 3,570,818 is the cumulative total for the day.
// Comparing them pinned the bar red forever and asserted a run had stopped
// when none had. Two different quantities must never share one bar.
// ---------------------------------------------------------------------------
describe('the daily total is not measured against a per-run budget', () => {
  it('reports a daily total as its own fact, with no percentage', () => {
    const d = dailyUsage(3_570_818, 42)
    expect(d.label).toContain('3,570,818')
    expect(d.label).toContain('42')
    // No "of 100,000" — there is no daily budget to be "of".
    expect(d.label).not.toContain('of 100,000')
  })

  it('never claims a run stopped', () => {
    expect(dailyUsage(3_570_818, 42).label.toLowerCase()).not.toContain('stopped')
  })

  it('reads naturally with no runs yet', () => {
    const d = dailyUsage(0, 0)
    expect(d.label.toLowerCase()).toContain('no runs')
  })

  it('handles a single run without saying "1 runs"', () => {
    expect(dailyUsage(5000, 1).label).toContain('1 run ')
  })
})
