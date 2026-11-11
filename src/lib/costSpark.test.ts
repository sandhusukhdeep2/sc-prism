import { describe, expect, it } from 'vitest'
import { costSpark } from './costSpark'

// The Memory page's cost card drew this session's verdict costs while its
// trend sentence read the engine's run series — two series on one card
// (2026-11-11). The line is now drawn from the series the sentence reads.
describe('costSpark — the cost line, from the one shared series', () => {
  it('is a flat baseline with no area when nothing was measured', () => {
    expect(costSpark([])).toEqual({ line: 'M0 20 L220 20', area: '', points: 0 })
  })

  it('draws one measurement as a level line', () => {
    const s = costSpark([0.4])
    expect(s.points).toBe(1)
    expect(s.line).toMatch(/^M0 [\d.]+ L220 [\d.]+$/)
  })

  it('puts the lowest cost at the bottom and the highest at the top', () => {
    const s = costSpark([0, 1])
    expect(s.line).toBe('M0.0 34.0 L220.0 6.0')
    expect(s.area).toBe('M0.0 34.0 L220.0 6.0 L220 40 L0 40 Z')
  })

  it('averages a long history into at most 48 points', () => {
    const s = costSpark(Array.from({ length: 600 }, (_, i) => (i % 3) * 0.1))
    expect(s.points).toBe(48)
    expect((s.line.match(/[ML]/g) ?? []).length).toBe(48)
  })
})
