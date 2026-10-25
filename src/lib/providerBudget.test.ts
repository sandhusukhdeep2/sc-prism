import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRAND_BUDGETS,
  brandOf,
  brandBudgetStatus,
  clampBrandBudget,
  isEstimatedSpend,
} from './providerBudget'

// ---------------------------------------------------------------------------
// Per-provider token budgets (Sukhdeep, 2026-09-03: "a billion token for the
// cloud maximum, two million for the local, half million for the Gemini …
// if Gemini is hitting his limit quickly, move things to local a bit more …
// and let the user know you hit the limit of this AI").
//
// FOUR THINGS THIS DELIBERATELY IS NOT, each established from the code:
//
// 1. It is NOT a reading of anyone's plan. No provider exposes remaining
//    quota — no endpoint, no CLI flag, no header. Every number here is the
//    user's own alert level governing OUR OWN count.
// 2. It is an ALERT, not a cap. Nothing checks mid-run; one run emits many
//    model calls. Clamping the run budget to a brand's headroom would cap the
//    LOCAL half of a run because a cloud brand was near its alert.
// 3. Spend through a subscription CLI is a FLOOR, not an estimate. Those
//    bridges report no usage, so tokens are counted from the prompt we handed
//    over and the stdout we got back — while the CLI runs its own agent loop
//    whose every internal turn bills the plan invisibly to us. Real spend is
//    HIGHER by an unknown amount, so no progress bar is drawn: a bar renders
//    headroom, and we have no headroom claim.
// 4. Nothing moves between cloud providers. The gateway builds one primary and
//    has no fallback chain, so "shift from Gemini to Claude" is not a
//    capability. The only shed available is toward LOCAL.
// ---------------------------------------------------------------------------

describe('brandOf — engine provider keys fold to a brand the user recognises', () => {
  it('folds the CLI bridges onto their brand', () => {
    expect(brandOf('claude-cli')).toBe('claude')
    expect(brandOf('claude')).toBe('claude')
    expect(brandOf('gemini-cli')).toBe('gemini')
    expect(brandOf('gemini')).toBe('gemini')
  })

  it('keeps local separate from every cloud', () => {
    expect(brandOf('local')).toBe('local')
    expect(brandOf('local-model')).toBe('local')
  })

  it('folds codex onto openai, since that is whose plan it bills', () => {
    expect(brandOf('codex-cli')).toBe('openai')
    expect(brandOf('openai')).toBe('openai')
  })

  it('never invents a brand for something it does not know', () => {
    expect(brandOf('custom-1')).toBe('other')
    expect(brandOf('')).toBe('other')
  })
})

describe('isEstimatedSpend — say so when the number is a floor', () => {
  it('flags the subscription bridges', () => {
    expect(isEstimatedSpend('claude-cli')).toBe(true)
    expect(isEstimatedSpend('gemini-cli')).toBe(true)
    expect(isEstimatedSpend('codex-cli')).toBe(true)
  })

  it('does not flag providers that report real usage', () => {
    expect(isEstimatedSpend('claude')).toBe(false)
    expect(isEstimatedSpend('openai')).toBe(false)
    expect(isEstimatedSpend('local')).toBe(false)
  })
})

describe('clampBrandBudget', () => {
  it('0 means no alert for this brand', () => {
    expect(clampBrandBudget(0)).toBe(0)
    expect(clampBrandBudget(-1)).toBe(0)
    expect(clampBrandBudget(Number.NaN)).toBe(0)
  })

  it('keeps a real number and floors it', () => {
    expect(clampBrandBudget(1_000_000.9)).toBe(1_000_000)
  })

  it('refuses an alert so low it would fire on the first run', () => {
    expect(clampBrandBudget(100)).toBe(50_000)
  })
})

describe('brandBudgetStatus', () => {
  it('is quiet with no budget set', () => {
    const s = brandBudgetStatus({ brand: 'claude', spent: 9_000_000, budget: 0, estimated: false })
    expect(s.level).toBe('none')
    expect(s.pct).toBeNull()
    expect(s.label.toLowerCase()).toContain('no alert')
  })

  it('warns before the alert, not at it', () => {
    expect(brandBudgetStatus({ brand: 'gemini', spent: 800_000, budget: 1_000_000, estimated: false }).level).toBe('warn')
    expect(brandBudgetStatus({ brand: 'gemini', spent: 400_000, budget: 1_000_000, estimated: false }).level).toBe('ok')
  })

  it('reports reached at the alert level', () => {
    expect(brandBudgetStatus({ brand: 'gemini', spent: 1_000_000, budget: 1_000_000, estimated: false }).level).toBe('reached')
  })

  it('draws NO bar for a brand whose spend is only a floor', () => {
    // A bar renders headroom. Through a subscription CLI we have no headroom
    // claim to render — the CLI's own internal turns bill invisibly to us.
    const s = brandBudgetStatus({ brand: 'claude', spent: 400_000, budget: 1_000_000, estimated: true })
    expect(s.pct).toBeNull()
    expect(s.label.toLowerCase()).toContain('at least')
  })

  it('still alerts on an estimated brand once the floor passes the alert', () => {
    // We cannot draw headroom, but "we have already counted more than your
    // alert" is a fact we can stand behind.
    const s = brandBudgetStatus({ brand: 'claude', spent: 1_200_000, budget: 1_000_000, estimated: true })
    expect(s.level).toBe('reached')
  })

  it('never says a word about the provider plan', () => {
    for (const est of [true, false]) {
      const s = brandBudgetStatus({ brand: 'claude', spent: 500_000, budget: 1_000_000, estimated: est })
      const blob = (s.label + s.note).toLowerCase()
      expect(blob).not.toContain('remaining')
      expect(blob).not.toContain('quota')
      expect(blob).not.toContain('your plan')
    }
  })

  it('calls itself an alert, never a cap', () => {
    const s = brandBudgetStatus({ brand: 'gemini', spent: 1_000_000, budget: 1_000_000, estimated: false })
    const blob = (s.label + ' ' + s.note).toLowerCase()
    expect(blob).toMatch(/alert|let you know|tell you/)
    // It may MENTION blocking, but only to deny it — "nothing was blocked" is
    // clearer copy than tiptoeing around the word. What it must never do is
    // claim a run was capped, because none was.
    if (blob.includes('block')) expect(blob).toMatch(/nothing was blocked|not blocked/)
    if (blob.includes('stopped')) expect(blob).toMatch(/nothing was stopped|not stopped/)
  })
})

describe('the defaults are honest starting points, not measurements', () => {
  it('gives local no alert at all', () => {
    expect(DEFAULT_BRAND_BUDGETS.local).toBe(0)
  })

  it('gives each cloud brand a round, obviously-arbitrary number', () => {
    for (const b of ['claude', 'gemini', 'openai'] as const) {
      expect(DEFAULT_BRAND_BUDGETS[b]).toBeGreaterThan(0)
      // Round numbers read as "a starting point someone picked", which is what
      // they are. A precise-looking default would imply a measurement.
      expect(DEFAULT_BRAND_BUDGETS[b] % 100_000).toBe(0)
    }
  })
})
