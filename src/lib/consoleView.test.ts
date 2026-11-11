import { describe, expect, it } from 'vitest'
import { bucketMeans, burnRows, countTone } from './consoleView'

// The Console drew three unlabelled blocks for token burn, a 383-point eval
// line as a solid band, and a zero in alarm red (2026-11-11 tour). These are
// the measurements behind the redrawn cards.
describe('burnRows — each provider as a readable row', () => {
  const providers = [
    { key: 'local', label: 'local', tokens: 7_000_000, cost: 0, isLocal: true },
    { key: 'claude', label: 'claude', tokens: 3_000_000, cost: 2.5, isLocal: false },
    { key: 'gemini', label: 'gemini', tokens: 20_000, cost: 0, isLocal: false },
  ]

  it('gives each bar a width relative to the largest, and its share of all tokens', () => {
    const rows = burnRows(providers)
    expect(rows.map((r) => r.widthPct)).toEqual([100, 43, 2])
    expect(rows.map((r) => r.sharePct)).toEqual([70, 30, 0])
  })

  it('never draws a provider that burned tokens as nothing, and says "<1%" rather than 0%', () => {
    const rows = burnRows(providers)
    expect(rows[2].widthPct).toBeGreaterThanOrEqual(2)
    expect(rows[2].shareLabel).toBe('<1%')
    expect(rows[0].shareLabel).toBe('70%')
  })

  it('writes the amount in a short form a person can read', () => {
    const rows = burnRows(providers)
    expect(rows.map((r) => r.tokensLabel)).toEqual(['7M', '3M', '20K'])
  })

  it('a provider with no tokens has no bar at all', () => {
    const rows = burnRows([{ key: 'x', label: 'x', tokens: 0, cost: 0, isLocal: false }])
    expect(rows[0].widthPct).toBe(0)
    expect(rows[0].shareLabel).toBe('0%')
  })
})

describe('bucketMeans — a long series drawn as a line, not a band', () => {
  it('leaves a short series as it is', () => {
    expect(bucketMeans([0.5, 0.7, 0.9], 48)).toEqual([0.5, 0.7, 0.9])
  })

  it('averages a long series into at most the asked number of points, in order', () => {
    const series = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0.2 : 0.8))
    const out = bucketMeans(series, 40)
    expect(out).toHaveLength(40)
    expect(out[0]).toBeCloseTo(0.2)
    expect(out[39]).toBeCloseTo(0.8)
  })

  it('keeps every value inside the range it was given', () => {
    const series = Array.from({ length: 383 }, (_, i) => (i % 2 ? 1 : 0))
    for (const v of bucketMeans(series, 48)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('is empty for an empty series', () => {
    expect(bucketMeans([], 48)).toEqual([])
  })
})

describe('countTone — a zero is not an alarm', () => {
  it('is calm at zero and when nothing was measured', () => {
    expect(countTone(0)).toBe('calm')
    expect(countTone(null)).toBe('calm')
  })
  it('is an alert only above zero', () => {
    expect(countTone(3)).toBe('alert')
  })
})
