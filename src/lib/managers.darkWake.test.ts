import { describe, expect, it } from 'vitest'
import {
  DARK_WAKE_RETRY_MS,
  DARK_WAKE_SKIP_LINE,
  beatDue,
  isSkipBeat,
  recordBeat,
  recordSkipBeat,
  type Beat,
  type Heartbeat,
} from './managers'

const HOUR = 60 * 60_000
const T0 = Date.parse('2026-08-27T02:37:00')

const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  enabled: true,
  charter: 'do one thing',
  everyMinutes: 60,
  lastBeat: T0 - HOUR,
  beats: [],
  today: { day: '2026-08-27', beats: 0, tokens: 0 },
  consent: 'on',
  autoOnAt: 0,
  ...over,
})

const worked = (at: number): Beat => ({
  at,
  action: 'worked',
  line: 'indexed two verdicts',
  ok: true,
  tokens: 1200,
})

// THE NIGHT THIS FIXES, from the real beat log:
//   02:37, 03:47, 05:14, 06:55, 08:15, 09:55 — six maintenance wakes, six
//   skips, and not one piece of work done in seven hours. Each skip recorded an
//   ordinary beat, and an ordinary beat advances the cadence, so every skip
//   silently spent an hour it never used.
describe('a skipped wake gives back the hour it did not use', () => {
  it('schedules the next attempt in minutes, not a full cadence', () => {
    const after = recordSkipBeat(hb(), T0, 'dark wake', T0 + DARK_WAKE_RETRY_MS)
    expect(after.retryAt).toBe(T0 + DARK_WAKE_RETRY_MS)
    // Not due one minute early…
    expect(beatDue(T0 + DARK_WAKE_RETRY_MS - 60_000, after)).toBe(false)
    // …and due on time, an hour before the cadence would have allowed it.
    expect(beatDue(T0 + DARK_WAKE_RETRY_MS, after)).toBe(true)
    expect(T0 + DARK_WAKE_RETRY_MS).toBeLessThan(after.lastBeat + HOUR)
  })

  it('a Mac woken at ten past the hour works at quarter past, not next hour', () => {
    const skipped = recordSkipBeat(hb(), T0, 'dark wake', T0 + DARK_WAKE_RETRY_MS)
    const properlyAwake = T0 + 10 * 60_000
    expect(beatDue(properlyAwake, skipped)).toBe(true)
  })

  it('still records the skip honestly — the gap in the log is explained', () => {
    const after = recordSkipBeat(hb(), T0, 'a maintenance (dark) wake', T0 + 1)
    expect(after.beats[0].line).toContain(DARK_WAKE_SKIP_LINE)
    expect(after.beats[0].line).toContain('a maintenance (dark) wake')
    expect(after.beats[0].ok).toBe(true)
    expect(after.beats[0].tokens).toBe(0)
    expect(isSkipBeat(after.beats[0])).toBe(true)
  })
})

describe('a run of skips cannot flush the real history out of the log', () => {
  const realHistory: Beat[] = [worked(T0 - HOUR), worked(T0 - 2 * HOUR)]

  it('collapses consecutive skips into ONE self-counting beat', () => {
    let h = hb({ beats: realHistory })
    for (let i = 0; i < 6; i++) {
      h = recordSkipBeat(h, T0 + i * DARK_WAKE_RETRY_MS, 'dark wake', T0 + (i + 1) * DARK_WAKE_RETRY_MS)
    }
    // Six skips, one line — and the two real beats are still there.
    expect(h.beats.filter(isSkipBeat)).toHaveLength(1)
    expect(h.beats).toHaveLength(3)
    expect(h.beats[0].line).toMatch(/6 times since/)
    expect(h.beats.slice(1)).toEqual(realHistory)
  })

  it('a whole sleeping night costs the log one entry, not ninety-six', () => {
    let h = hb({ beats: realHistory })
    const night = (8 * HOUR) / DARK_WAKE_RETRY_MS // 96 retries
    for (let i = 0; i < night; i++) {
      h = recordSkipBeat(h, T0 + i * DARK_WAKE_RETRY_MS, 'dark wake', T0 + (i + 1) * DARK_WAKE_RETRY_MS)
    }
    expect(h.beats.filter(isSkipBeat)).toHaveLength(1)
    expect(h.beats.slice(1)).toEqual(realHistory)
    expect(h.beats[0].line).toMatch(/96 times since/)
  })

  it('the day counter counts the RUN once, not every retry', () => {
    let h = hb({ today: { day: '2026-08-27', beats: 0, tokens: 0 } })
    for (let i = 0; i < 20; i++) {
      h = recordSkipBeat(h, T0 + i * DARK_WAKE_RETRY_MS, 'dark wake', T0 + (i + 1) * DARK_WAKE_RETRY_MS)
    }
    // Twenty retries of one sleeping stretch is one thing that happened.
    expect(h.today.beats).toBe(1)
    expect(h.today.tokens).toBe(0)
  })

  it('the newest skip carries the LATEST time, so the log is not stale', () => {
    let h = recordSkipBeat(hb(), T0, 'dark wake', T0 + DARK_WAKE_RETRY_MS)
    const later = T0 + 30 * 60_000
    h = recordSkipBeat(h, later, 'dark wake', later + DARK_WAKE_RETRY_MS)
    expect(h.beats[0].at).toBe(later)
    expect(h.lastBeat).toBe(later)
  })
})

describe('a beat that actually ran ends the run of skips', () => {
  it('clears the retry debt and returns to the plain cadence', () => {
    const skipped = recordSkipBeat(hb(), T0, 'dark wake', T0 + DARK_WAKE_RETRY_MS)
    const ran = recordBeat(skipped, worked(T0 + 6 * 60_000))
    expect(ran.retryAt).toBeFalsy()
    expect(ran.skipRun).toBeUndefined()
    // Back on the hour: not due again until a full cadence has passed.
    expect(beatDue(ran.lastBeat + 30 * 60_000, ran)).toBe(false)
    expect(beatDue(ran.lastBeat + HOUR, ran)).toBe(true)
  })

  it('the next skip after real work starts a FRESH run, not a continued tally', () => {
    let h = recordSkipBeat(hb(), T0, 'dark wake', T0 + DARK_WAKE_RETRY_MS)
    h = recordSkipBeat(h, T0 + DARK_WAKE_RETRY_MS, 'dark wake', T0 + 2 * DARK_WAKE_RETRY_MS)
    expect(h.beats[0].line).toMatch(/2 times since/)
    h = recordBeat(h, worked(T0 + 20 * 60_000))
    h = recordSkipBeat(h, T0 + 2 * HOUR, 'dark wake', T0 + 2 * HOUR + DARK_WAKE_RETRY_MS)
    // A single skip says so plainly, with no inherited count.
    expect(h.beats[0].line).not.toMatch(/times since/)
    expect(h.skipRun).toEqual({ since: T0 + 2 * HOUR, count: 1 })
    // …and the real beat it followed is still in the log.
    expect(h.beats.some((b) => b.action === 'worked')).toBe(true)
  })
})

describe('the retry never overrules the user', () => {
  it('a heartbeat switched OFF is never due, retry pending or not', () => {
    const off = recordSkipBeat(hb({ enabled: false }), T0, 'dark wake', T0 + 1)
    expect(beatDue(T0 + HOUR * 10, off)).toBe(false)
  })

  it('no retry pending behaves exactly as the cadence always did', () => {
    const plain = hb({ lastBeat: T0 })
    expect(beatDue(T0 + 59 * 60_000, plain)).toBe(false)
    expect(beatDue(T0 + HOUR, plain)).toBe(true)
  })
})
