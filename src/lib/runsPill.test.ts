import { describe, expect, it } from 'vitest'
import { runsPill } from './runsPill'

// 2026-11-08: the Work pill said "38% ran on your Mac" beside the rail's "66%
// local". Both true — one counts RUNS, the other TOKENS — so each was made to
// say what it counts. 2026-11-14: the owner still read them as one fact with
// two values ("information is not totally connected"), and so did anyone at a
// glance. The rail's meter is on every page; the pill no longer states a
// second share. It says how many runs are on record and leads to Stats, where
// both shares sit side by side, each named.
describe('runsPill — the Work header pill', () => {
  it('says how many runs are on record, and no share of its own', () => {
    expect(runsPill(107)).toBe('107 runs recorded all time')
    expect(runsPill(107)).not.toMatch(/%/)
  })
  it('reads naturally for one run', () => {
    expect(runsPill(1)).toBe('1 run recorded all time')
  })
  it('says there are no runs yet', () => {
    expect(runsPill(0)).toBe('no runs yet — stats appear as you work')
  })
})
