import { describe, expect, it } from 'vitest'
import {
  DRIVER_TICK_MS,
  driverStalled,
  driverStalledLine,
  type ManagersState,
} from './managers'

const NOW = Date.parse('2026-08-27T12:00:00Z')
const WEEK = 7 * 24 * 60 * 60_000
// Session start, well behind everything below, so each test says out loud when
// the floor is the thing under test rather than leaning on a default.
const OPENED = NOW - WEEK * 2

const st = (lastTick?: number): ManagersState =>
  ({ managers: [], jobs: [], seeded: true, lastTick }) as ManagersState

describe('the app notices when its own manager stops', () => {
  it('a beating driver reports no stall', () => {
    expect(driverStalled(NOW, st(NOW - 5_000), OPENED)).toBeNull()
    expect(driverStalled(NOW, st(NOW - DRIVER_TICK_MS), OPENED)).toBeNull()
  })

  it('one or two missed ticks are tolerated — a busy engine is not a dead loop', () => {
    expect(driverStalled(NOW, st(NOW - DRIVER_TICK_MS * 2), OPENED)).toBeNull()
  })

  it('three missed ticks IS a dead loop, and it says how long', () => {
    const silent = DRIVER_TICK_MS * 4
    expect(driverStalled(NOW, st(NOW - silent), OPENED)).toBe(silent)
  })

  it('the real silence — seven days — is caught, and stated in days', () => {
    expect(driverStalled(NOW, st(NOW - WEEK), OPENED)).toBe(WEEK)
    expect(driverStalledLine(WEEK)).toMatch(/has not run for 7 days/)
  })

  it('the line names a duration a person can act on, at every scale', () => {
    expect(driverStalledLine(4 * 60_000)).toMatch(/4 minutes/)
    expect(driverStalledLine(3 * 60 * 60_000)).toMatch(/3 hours/)
    expect(driverStalledLine(WEEK)).toMatch(/open Automations/i)
  })
})

describe('the session floor — what it refuses to blame the user for', () => {
  it('a just-opened app accuses itself of nothing: the first tick is 30s away', () => {
    expect(driverStalled(NOW, st(undefined), NOW)).toBeNull()
    expect(driverStalled(NOW, st(undefined), NOW - DRIVER_TICK_MS)).toBeNull()
  })

  it('a Mac shut for a week is not scolded for the week it was shut', () => {
    // The store remembers nothing across sessions by design, but even a stale
    // in-memory value must not outrank a session that just began.
    expect(driverStalled(NOW, st(NOW - WEEK), NOW - 5_000)).toBeNull()
  })

  it('AN INTERVAL THAT NEVER MOUNTED IS REPORTED — the case with no lastTick at all', () => {
    // Without the floor this is the dangerous silent one: no tick ever written,
    // so silence measured from zero is either infinite or (guarded away) null
    // forever. Two minutes open with nothing firing is a broken loop, and says so.
    const open = DRIVER_TICK_MS * 4
    expect(driverStalled(NOW, st(undefined), NOW - open)).toBe(open)
  })

  it('once a real tick lands it outranks the floor, in both directions', () => {
    // A live tick clears an old floor…
    expect(driverStalled(NOW, st(NOW - 1_000), NOW - WEEK)).toBeNull()
    // …and cannot be used to hide a loop that has since died.
    expect(driverStalled(NOW, st(NOW - WEEK), OPENED)).toBe(WEEK)
  })
})
