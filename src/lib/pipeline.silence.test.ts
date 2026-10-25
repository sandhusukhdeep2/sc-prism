import { describe, expect, it } from 'vitest'
import { silenceIsLong, silenceLine, silenceSeconds } from './pipeline'
import type { EngineSpan } from './nativeEngine'

// THE FINDING THIS ANSWERS, produced by SC Prism's own three-agent team when it
// was asked to review this screen:
//
//   "Is it stuck? Unanswerable. Idle is one undifferentiated state covering
//    thinking, silent retry, rate-limiting, and hung. Fix: show last-event type
//    and time since it, so waiting and killing are distinguishable."
//
// A pulsing monogram says "something is happening" identically at four seconds
// and four minutes, so the one decision the user has — keep waiting, or stop —
// has nothing to go on. These pin the number that replaces the shrug.

const NOW = 1_000_000 // engine-clock seconds

const open = (startSec: number): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'running',
  start: startSec,
})

const closed = (startSec: number, durMs: number): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'ok',
  start: startSec,
  duration_ms: durMs,
})

describe('how long since anything actually happened', () => {
  it('an open span is measured from when it STARTED — that is our last news of it', () => {
    expect(silenceSeconds([open(NOW - 45)], true, NOW)).toBe(45)
  })

  it('a closed span is measured from when it ENDED', () => {
    // Started 100s ago, ran for 40s → nothing has happened for 60s.
    expect(silenceSeconds([closed(NOW - 100, 40_000)], true, NOW)).toBe(60)
  })

  it('the NEWEST edge wins, whichever span it belongs to', () => {
    const spans = [closed(NOW - 300, 10_000), open(NOW - 12), closed(NOW - 200, 5_000)]
    expect(silenceSeconds(spans, true, NOW)).toBe(12)
  })

  it('an idle board says nothing about waiting', () => {
    expect(silenceSeconds([open(NOW - 500)], false, NOW)).toBeNull()
  })

  it('spans with no clock are not described with a guess', () => {
    expect(silenceSeconds([{ name: 'model_call', type: 'model_call' }], true, NOW)).toBeNull()
    expect(silenceSeconds([], true, NOW)).toBeNull()
  })

  it('never reports negative time when a clock runs slightly ahead', () => {
    expect(silenceSeconds([open(NOW + 3)], true, NOW)).toBe(0)
  })
})

describe('what it says, and what it refuses to say', () => {
  it('a fresh step is simply “working now” — no number to nag with', () => {
    expect(silenceLine(4)).toBe('working now')
    expect(silenceLine(19)).toBe('working now')
  })

  it('past twenty seconds it starts stating the gap in seconds', () => {
    expect(silenceLine(45)).toBe('working — 45s since the last step')
  })

  it('past ninety it switches to minutes, which is how a person waits', () => {
    expect(silenceLine(240)).toBe('working — nothing new for 4 min')
  })

  it('it NEVER says stuck, hung or failed — those would be guesses', () => {
    for (const s of [30, 120, 400, 900, 5_000]) {
      const line = silenceLine(s)
      expect(line).not.toMatch(/stuck|hung|fail|dead|frozen/i)
    }
  })

  it('an idle board renders no line at all', () => {
    expect(silenceLine(null)).toBe('')
  })
})

describe('when the wait earns a glance', () => {
  it('stays quiet through a legitimately slow local call', () => {
    // A single on-device call on this Mac was measured at 413s. A threshold
    // below that would cry wolf on work that is going fine.
    expect(silenceIsLong(120)).toBe(false)
    expect(silenceIsLong(413)).toBe(false)
  })

  it('raises contrast past the slowest call really measured here', () => {
    expect(silenceIsLong(420)).toBe(true)
    expect(silenceIsLong(900)).toBe(true)
  })

  it('an idle board is never long', () => {
    expect(silenceIsLong(null)).toBe(false)
  })
})
