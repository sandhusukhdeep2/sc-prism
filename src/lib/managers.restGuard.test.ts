import { describe, expect, it } from 'vitest'
import {
  REST_REANCHOR_MS,
  REST_UNCHANGED_LINE,
  beatDue,
  isRestBeat,
  recordBeat,
  recordRestBeat,
  wakeFingerprint,
  type Beat,
  type Heartbeat,
  type WakeStateInputs,
} from './managers'

const HOUR = 60 * 60_000
const T0 = Date.parse('2026-08-28T09:00:00')

const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  enabled: true,
  charter: 'do one thing',
  everyMinutes: 60,
  lastBeat: T0 - HOUR,
  beats: [],
  today: { day: '2026-08-28', beats: 0, tokens: 0 },
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

const inputs = (over: Partial<WakeStateInputs> = {}): WakeStateInputs => ({
  needsYou: 0,
  projects: [{ id: 'p1', name: 'node cli', status: 'new' }],
  vaultNotes: [
    { path: 'notes/a.md', mtime: 100, size: 10 },
    { path: 'business/context.md', mtime: 90, size: 40 },
  ],
  excludePrefixes: ['reports/sukh/'],
  businessNote: 'we build software',
  evidencePool: ['t-1'],
  agents: ['Planner', 'Implementer'],
  questionSetIds: [],
  charter: 'walk the ladder',
  everyMinutes: 60,
  ...over,
})

// THE DAY THIS FIXES, from the real beat log: eleven hourly wakes on
// 2026-08-28, 48,826 tokens, and seven of them said "Same 8 notes, the same
// 'new' node cli project". Every wake paid a full model call to re-read state
// that a free comparison could have proven unchanged.
describe('wakeFingerprint — the free "did anything change?" answer', () => {
  it('unchanged state prints the same, whatever the call order', () => {
    expect(wakeFingerprint(inputs())).toBe(wakeFingerprint(inputs()))
  })

  it('a touched note (same path, new mtime) changes the print', () => {
    const edited = inputs({
      vaultNotes: [
        { path: 'notes/a.md', mtime: 101, size: 10 },
        { path: 'business/context.md', mtime: 90, size: 40 },
      ],
    })
    expect(wakeFingerprint(edited)).not.toBe(wakeFingerprint(inputs()))
  })

  it("the companion's OWN report write does not dirty the next wake", () => {
    // A worked beat appends to reports/<slug>/heartbeat.md — if that write
    // counted as new state, every beat would arm the next one and the guard
    // could never fire. The excluded prefix keeps self-writes invisible.
    const afterOwnWrite = inputs({
      vaultNotes: [
        { path: 'notes/a.md', mtime: 100, size: 10 },
        { path: 'business/context.md', mtime: 90, size: 40 },
        { path: 'reports/sukh/heartbeat.md', mtime: 999, size: 777 },
      ],
    })
    expect(wakeFingerprint(afterOwnWrite)).toBe(wakeFingerprint(inputs()))
  })

  it('an edited charter forces a real beat', () => {
    expect(wakeFingerprint(inputs({ charter: 'watch the deploys instead' }))).not.toBe(
      wakeFingerprint(inputs()),
    )
  })

  it('a status flip on an existing project changes the print', () => {
    const flipped = inputs({ projects: [{ id: 'p1', name: 'node cli', status: 'awaiting' }] })
    expect(wakeFingerprint(flipped)).not.toBe(wakeFingerprint(inputs()))
  })
})

describe('recordRestBeat — an unchanged world rests for free', () => {
  it('records a zero-token rested beat that advances the cadence', () => {
    const after = recordRestBeat(hb(), T0)
    expect(after.lastBeat).toBe(T0)
    expect(after.beats).toHaveLength(1)
    expect(after.beats[0]).toMatchObject({ action: 'rested', ok: true, tokens: 0 })
    expect(after.beats[0].line).toContain(REST_UNCHANGED_LINE)
    expect(isRestBeat(after.beats[0])).toBe(true)
    // The cadence advanced — the next beat is a full interval away.
    expect(beatDue(T0 + HOUR - 60_000, after)).toBe(false)
    expect(beatDue(T0 + HOUR, after)).toBe(true)
  })

  it('consecutive rests collapse into ONE self-counting beat', () => {
    // Eleven quiet hours must cost the 40-beat log one entry, not eleven —
    // the same protection recordSkipBeat gives a night of maintenance wakes.
    let cur = recordRestBeat(hb(), T0)
    cur = recordRestBeat(cur, T0 + HOUR)
    cur = recordRestBeat(cur, T0 + 2 * HOUR)
    expect(cur.beats).toHaveLength(1)
    expect(cur.beats[0].line).toContain('3 times')
    // The day counter counts the RUN once, not each rest.
    expect(cur.today.beats).toBe(1)
    expect(cur.today.tokens).toBe(0)
  })

  it('a real beat ends the rest run', () => {
    const rested = recordRestBeat(recordRestBeat(hb(), T0), T0 + HOUR)
    const after = recordBeat(rested, worked(T0 + 2 * HOUR))
    expect(after.restRun).toBeUndefined()
    // The next rest starts a NEW run rather than continuing the old count.
    const again = recordRestBeat(after, T0 + 3 * HOUR)
    expect(again.beats[0].line).not.toContain('times')
  })

  it('re-anchor window is half a day — quiet must not mean silent forever', () => {
    expect(REST_REANCHOR_MS).toBe(12 * HOUR)
  })
})

// THE SECOND SELF-ARMING LOOP, from the real log of 2026-08-29: wakes at
// 13:23, 14:24, and 15:24 all FAILED with near-identical replies. Each wake's
// own verdict (`heartbeat-…`) landed in the evidence pool, changed the
// fingerprint, and armed the next wake — the guard could never fire, exactly
// the loop excludePrefixes already prevents for the report file. Same
// principle, other channel: the companion's own outputs are not world changes.
describe('wakeFingerprint ignores the companion’s own verdicts', () => {
  it('a new heartbeat verdict in the pool does not change the print', () => {
    const afterOwnBeat = inputs({ evidencePool: ['heartbeat-sukh-you-are-8844ad4e', 't-1'] })
    expect(wakeFingerprint(afterOwnBeat)).toBe(wakeFingerprint(inputs()))
  })

  it('a new REAL run in the pool still changes the print', () => {
    const afterRealRun = inputs({ evidencePool: ['project-goal-x-1a2b3c4d', 't-1'] })
    expect(wakeFingerprint(afterRealRun)).not.toBe(wakeFingerprint(inputs()))
  })
})
