import { describe, expect, it } from 'vitest'
import { costDirection, costFloorSeries } from './costTrend'

// The shared deadband both Memory and Stats route through — pins the two bugs
// it fixes: a fabricated direction on no data, and "holding" while cost rises.
describe('costDirection (shared honest cost-trend deadband)', () => {
  it('no data (<2 points) -> flat, never a fabricated direction', () => {
    expect(costDirection([])).toBe('flat')
    expect(costDirection([5])).toBe('flat')
  })

  it('a real fall beyond the 2% deadband -> down', () => {
    expect(costDirection([10, 5])).toBe('down')
  })

  it('a real rise beyond the 2% deadband -> up (never "holding"/"falling")', () => {
    expect(costDirection([5, 10])).toBe('up')
  })

  it('within the 2% deadband -> flat (no directional claim on noise)', () => {
    expect(costDirection([100, 101])).toBe('flat')
  })
})

// Stats read the engine's run series while Memory read the client's verdict
// costs (which carry no heartbeat/manager runs) — and the same screen pair
// said '↑306% · cost floor rising' and 'trending down' at once. One series,
// chosen by one function, is the only shape in which they cannot disagree.
describe('costFloorSeries — Stats and Memory read the SAME series', () => {
  it('prefers the engine run series when the dashboard read succeeded', () => {
    const dash = { run_series: [{ cost: 0.1 }, { cost: 0.2 }] }
    expect(costFloorSeries(dash, [9, 9, 9])).toEqual([0.1, 0.2])
  })
  it('falls back to the client verdict costs when there is no dashboard', () => {
    expect(costFloorSeries(null, [0.3, 0.4])).toEqual([0.3, 0.4])
    expect(costFloorSeries(undefined, [])).toEqual([])
  })
})
