import { describe, expect, it } from 'vitest'
import { runsPill } from './runsPill'

// Seen in the app 2026-11-08: the Work pill said "38% ran on your Mac" beside
// the rail's "66% local". Both true — one counts RUNS, the other TOKENS — and
// side by side they read as a contradiction. Each now says what it counts.
describe('runsPill — the Work header pill says what it counts', () => {
  it('names the share as a share of runs', () => {
    expect(runsPill(107, 38)).toBe('107 runs recorded all time · 38% of runs on your Mac')
  })
  it('reads naturally for one run', () => {
    expect(runsPill(1, 100)).toBe('1 run recorded all time · 100% of runs on your Mac')
  })
  it('says there are no runs yet instead of a 0%', () => {
    expect(runsPill(0, 0)).toBe('no runs yet — stats appear as you work')
  })
})
