import { describe, expect, it } from 'vitest'
import {
  buildLoopNotReady,
  engineBusy,
  loopRunSummary,
  pickDueLoop,
  testLoopSkipReason,
} from './AppStore'
import type { Schedule } from '../lib/schedules'
import type { Project, ProjectStatus } from '../lib/projects'

// Fixture matching the real Schedule shape (P2-1: projectId + kind).
const schedule = (over: Partial<Schedule>): Schedule => ({
  id: 'sch-1',
  task: 'a standing task',
  everyMinutes: 60,
  agents: '',
  enabled: true,
  lastRun: 0,
  runs: [],
  projectId: '',
  kind: 'task',
  ...over,
})

// A minimal Project — only `status` matters to engineBusy; the rest is
// filler to satisfy the type.
const project = (status: ProjectStatus): Project => ({
  id: `proj-${status}`,
  name: status,
  slug: status,
  path: '/tmp/x',
  goal: '',
  verifyCommand: '',
  createdAt: 0,
  status,
  brief: '',
  plan: [],
  stepIndex: 0,
  refinePass: 0,
  transcript: [],
  verdictIds: [],
  lastNote: '',
})

const NOW = 1_000_000

describe('pickDueLoop', () => {
  it('returns null when busy, even with a due schedule waiting', () => {
    const due = schedule({ lastRun: 0, everyMinutes: 5 })
    expect(pickDueLoop([due], NOW, true)).toBeNull()
  })

  it('returns null when nothing is due', () => {
    const notDue = schedule({ lastRun: NOW, everyMinutes: 60 })
    expect(pickDueLoop([notDue], NOW, false)).toBeNull()
  })

  it('returns null when the only due schedule is disabled', () => {
    const disabled = schedule({ enabled: false, lastRun: 0, everyMinutes: 5 })
    expect(pickDueLoop([disabled], NOW, false)).toBeNull()
  })

  it('returns a due, enabled schedule when not busy', () => {
    const due = schedule({ id: 'sch-due', lastRun: 0, everyMinutes: 5 })
    expect(pickDueLoop([due], NOW, false)).toEqual(due)
  })

  it('is due exactly at the interval boundary (>=, not >)', () => {
    const s = schedule({ id: 'sch-boundary', everyMinutes: 10, lastRun: NOW - 10 * 60_000 })
    expect(pickDueLoop([s], NOW, false)).toEqual(s)
  })

  it('picks the first due+enabled schedule, skipping a not-yet-due one ahead of it', () => {
    const notDueYet = schedule({ id: 'sch-not-due', lastRun: NOW - 1_000, everyMinutes: 60 })
    const isDue = schedule({ id: 'sch-is-due', lastRun: 0, everyMinutes: 5 })
    expect(pickDueLoop([notDueYet, isDue], NOW, false)).toEqual(isDue)
  })

  it('skips a disabled-but-due schedule and picks the next due+enabled one', () => {
    const disabledDue = schedule({ id: 'sch-off', enabled: false, lastRun: 0, everyMinutes: 5 })
    const enabledDue = schedule({ id: 'sch-on', lastRun: 0, everyMinutes: 5 })
    expect(pickDueLoop([disabledDue, enabledDue], NOW, false)).toEqual(enabledDue)
  })

  it('returns null for an empty schedule list', () => {
    expect(pickDueLoop([], NOW, false)).toBeNull()
  })
})

describe('loopRunSummary', () => {
  it('build: ok reads as finished', () => {
    expect(loopRunSummary('build', true)).toMatch(/finished/)
  })

  it('build: not-ok reads as failed/needs attention', () => {
    expect(loopRunSummary('build', false)).toMatch(/failed|attention/)
  })

  it('test: ok reads as verify passed', () => {
    expect(loopRunSummary('test', true)).toMatch(/pass/i)
  })

  it('test: not-ok reads as verify failed', () => {
    expect(loopRunSummary('test', false)).toMatch(/fail/i)
  })

  it('task: ok and not-ok route to distinct summaries', () => {
    expect(loopRunSummary('task', true)).not.toEqual(loopRunSummary('task', false))
  })

  it('task: not-ok names the likely cause (no real reply)', () => {
    expect(loopRunSummary('task', false)).toMatch(/no real reply/)
  })

  it('build and test kinds never share the same phrasing (kind routing)', () => {
    expect(loopRunSummary('build', true)).not.toEqual(loopRunSummary('test', true))
    expect(loopRunSummary('build', false)).not.toEqual(loopRunSummary('test', false))
  })
})

describe('engineBusy', () => {
  it('is busy when the loop driver is mid-run (loopBusy), regardless of projects', () => {
    expect(engineBusy(true, false, [])).toBe(true)
  })

  it('is busy when the manager driver is mid-run (managerBusy)', () => {
    expect(engineBusy(false, true, [])).toBe(true)
  })

  it('is busy when ANY project is running', () => {
    expect(engineBusy(false, false, [project('running')])).toBe(true)
  })

  it('is busy when ANY project is parked awaiting the human (never auto-resume)', () => {
    expect(engineBusy(false, false, [project('awaiting')])).toBe(true)
  })

  it('is busy if even one of several projects is running/awaiting', () => {
    expect(
      engineBusy(false, false, [project('done'), project('attention'), project('awaiting')]),
    ).toBe(true)
  })

  it('is NOT busy when idle: no refs held and all projects are settled', () => {
    expect(engineBusy(false, false, [])).toBe(false)
    expect(engineBusy(false, false, [project('done'), project('new')])).toBe(false)
    expect(engineBusy(false, false, [project('planned'), project('attention')])).toBe(false)
  })

  // Symmetric serialization: each driver passes false for its OWN ref (about
  // to run, must not self-block) and the peer's ref for the other driver.
  it('a caller passing false for its own ref still yields to the peer driver', () => {
    // manager driver about to run (self=false) but the loop driver is busy
    expect(engineBusy(true, false, [])).toBe(true)
    // loop driver about to run (self=false) but the manager driver is busy
    expect(engineBusy(false, true, [])).toBe(true)
  })
})

describe('testLoopSkipReason', () => {
  it('skips (with an honest reason) when the verify command is empty', () => {
    expect(testLoopSkipReason('')).toBe('no verify command — skipped')
    expect(testLoopSkipReason('   ')).toBe('no verify command — skipped')
  })

  it('returns null (run it) when a verify command is set', () => {
    expect(testLoopSkipReason('npm test')).toBeNull()
    expect(testLoopSkipReason('  pytest -q  ')).toBeNull()
  })
})

describe('buildLoopNotReady', () => {
  it('not ready when the plan is empty', () => {
    expect(buildLoopNotReady([], '/abs/dir')).toBe('build loop: project not ready')
  })

  it('not ready when the dir is not an absolute (usable) path', () => {
    expect(buildLoopNotReady(['step 1'], 'relative/dir')).toBe('build loop: project not ready')
    expect(buildLoopNotReady(['step 1'], '')).toBe('build loop: project not ready')
  })

  it('ready (null) when the plan is non-empty AND the dir is usable', () => {
    expect(buildLoopNotReady(['step 1', 'step 2'], '/Users/me/proj')).toBeNull()
  })
})

// A FINISHED project's loop rests (2026-08-29, caught live): the hello-crew
// demo reached 'done' at 11:2x and its 30-minute build loop happily REBUILT
// it at 12:1x — real tokens spent re-doing finished work. A build loop's job
// ends when the build does; only an explicit re-plan (status leaving 'done')
// wakes it again.
describe('buildLoopNotReady — a done project is not a build target', () => {
  it("says so for status 'done'", () => {
    expect(buildLoopNotReady(['step 1'], '/tmp/ok', 'done')).toMatch(/finished/i)
  })
  it('a running or planned project is unchanged', () => {
    expect(buildLoopNotReady(['step 1'], '/tmp/ok', 'planned')).toBeNull()
    expect(buildLoopNotReady(['step 1'], '/tmp/ok', 'running')).toBeNull()
  })
})
