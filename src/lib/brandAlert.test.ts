import { describe, expect, it } from 'vitest'
import { brandAlerts, type BrandSpend } from './brandAlert'

// Sukhdeep, 2026-09-03: "if it's hit the limit, it's supposed to let user know
// you hit the limit of this AI … so user can change the limit or refresh the
// limit … but user know this thing happening."
//
// The rule this follows: we just spent a day removing an invisible limit that
// silently broke runs. Adding a layer of invisible per-AI limits on top would
// be going backwards. So an alert that fires must SAY WHICH AI, say what we
// counted, and offer something to do — and must not nag once answered.

const spend = (over: Partial<BrandSpend> = {}): BrandSpend => ({
  brand: 'gemini',
  label: 'Gemini',
  spent: 1_200_000,
  budget: 1_000_000,
  estimated: false,
  ...over,
})

describe('brandAlerts', () => {
  it('says nothing while every AI is under its alert', () => {
    expect(brandAlerts([spend({ spent: 10_000 })])).toEqual([])
  })

  it('names the AI, not just "a limit"', () => {
    const [a] = brandAlerts([spend()])
    expect(a.title).toContain('Gemini')
  })

  it('says what we counted and what the alert was', () => {
    const [a] = brandAlerts([spend()])
    expect(a.body).toContain('1,200,000')
    expect(a.body).toContain('1,000,000')
  })

  it('makes clear nothing was blocked', () => {
    const [a] = brandAlerts([spend()])
    expect(a.body.toLowerCase()).toMatch(/nothing was blocked|not blocked|no run was stopped/)
  })

  it('offers a way to act, not just a notification', () => {
    const [a] = brandAlerts([spend()])
    const actions = a.actions.map((x) => x.id)
    expect(actions).toContain('raise')
    expect(actions).toContain('reset')
    expect(actions).toContain('dismiss')
  })

  it('says a subscription count is a floor, when it is one', () => {
    const [a] = brandAlerts([spend({ brand: 'claude', label: 'Claude', estimated: true })])
    expect(a.body.toLowerCase()).toContain('at least')
  })

  it('never claims to know the provider plan', () => {
    const [a] = brandAlerts([spend()])
    const blob = (a.title + a.body).toLowerCase()
    expect(blob).not.toContain('quota')
    expect(blob).not.toContain('remaining')
    expect(blob).not.toContain('your plan')
  })

  it('does not fire again once acknowledged at that level', () => {
    // A notice that returns every render is one the user learns to ignore.
    expect(brandAlerts([spend()], { acknowledged: { gemini: 1_000_000 } })).toEqual([])
  })

  it('fires again if the user raised the alert and passed it too', () => {
    expect(
      brandAlerts([spend({ spent: 3_000_000, budget: 2_000_000 })], {
        acknowledged: { gemini: 1_000_000 },
      }),
    ).toHaveLength(1)
  })

  it('reports each AI separately, most over first', () => {
    const out = brandAlerts([
      spend({ brand: 'gemini', label: 'Gemini', spent: 1_100_000, budget: 1_000_000 }),
      spend({ brand: 'claude', label: 'Claude', spent: 30_000_000, budget: 10_000_000 }),
    ])
    expect(out.map((a) => a.brand)).toEqual(['claude', 'gemini'])
  })

  it('ignores an AI with no alert set', () => {
    expect(brandAlerts([spend({ budget: 0, spent: 99_000_000 })])).toEqual([])
  })
})
