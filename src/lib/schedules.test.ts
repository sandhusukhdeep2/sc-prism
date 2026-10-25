import { describe, expect, it, vi } from 'vitest'
import {
  addSchedule,
  getSchedules,
  projectSchedules,
  scheduleKind,
  type Schedule,
} from './schedules'

describe('addSchedule', () => {
  it('defaults projectId to "" and kind to "task" when omitted', () => {
    addSchedule('Do the thing', 30, '')
    const s = getSchedules()[0]
    expect(s.projectId).toBe('')
    expect(s.kind).toBe('task')
  })

  it('stores an explicit projectId and kind', () => {
    addSchedule('Build it', 15, '', 'proj-1', 'build')
    const s = getSchedules()[0]
    expect(s.projectId).toBe('proj-1')
    expect(s.kind).toBe('build')
  })

  it('stores kind "test" for a test loop', () => {
    addSchedule('Verify it', 10, '', 'proj-2', 'test')
    const s = getSchedules()[0]
    expect(s.projectId).toBe('proj-2')
    expect(s.kind).toBe('test')
  })
})

describe('scheduleKind', () => {
  it('returns the explicit kind when set', () => {
    const s: Schedule = {
      id: 'a',
      task: 't',
      everyMinutes: 5,
      agents: '',
      enabled: true,
      lastRun: 0,
      runs: [],
      kind: 'build',
    }
    expect(scheduleKind(s)).toBe('build')
  })

  it('defaults to "task" when kind is missing (back-compat)', () => {
    const s: Schedule = {
      id: 'a',
      task: 't',
      everyMinutes: 5,
      agents: '',
      enabled: true,
      lastRun: 0,
      runs: [],
    }
    expect(scheduleKind(s)).toBe('task')
  })
})

describe('projectSchedules', () => {
  it('returns only schedules bound to the given projectId', () => {
    addSchedule('Free-standing task', 60, '')
    addSchedule('Build loop', 15, '', 'proj-a', 'build')
    addSchedule('Test loop', 10, '', 'proj-a', 'test')
    addSchedule('Other project build', 15, '', 'proj-b', 'build')

    const forA = projectSchedules('proj-a')
    expect(forA).toHaveLength(2)
    expect(forA.every((s) => s.projectId === 'proj-a')).toBe(true)
  })

  it('returns an empty array when no schedules match', () => {
    addSchedule('Unrelated', 60, '')
    expect(projectSchedules('no-such-project')).toEqual([])
  })
})

// --- Kept LAST: resets the module registry, so must not run before the tests
// above that rely on the live singleton's accumulated state within this file. ---
describe('sanitize back-compat on load', () => {
  it('loads a legacy schedule (no kind/projectId) as kind "task" / projectId ""', async () => {
    localStorage.setItem(
      'scprism.schedules',
      JSON.stringify([
        {
          id: 'legacy-1',
          task: 'Legacy task',
          everyMinutes: 30,
          agents: '',
          enabled: true,
          lastRun: 0,
          runs: [],
        },
      ]),
    )
    vi.resetModules()
    const fresh = await import('./schedules')
    const state = fresh.getSchedules()
    expect(state).toHaveLength(1)
    expect(state[0].kind).toBe('task')
    expect(state[0].projectId).toBe('')
  })

  it('normalizes an unknown/garbage kind to "task"', async () => {
    localStorage.setItem(
      'scprism.schedules',
      JSON.stringify([
        {
          id: 'weird-kind',
          task: 'Weird',
          everyMinutes: 30,
          agents: '',
          enabled: true,
          lastRun: 0,
          runs: [],
          kind: 'launch-the-rocket',
        },
      ]),
    )
    vi.resetModules()
    const fresh = await import('./schedules')
    const state = fresh.getSchedules()
    expect(state[0].kind).toBe('task')
  })

  it('keeps a valid persisted kind and projectId as-is', async () => {
    localStorage.setItem(
      'scprism.schedules',
      JSON.stringify([
        {
          id: 'valid',
          task: 'Valid',
          everyMinutes: 30,
          agents: '',
          enabled: true,
          lastRun: 0,
          runs: [],
          kind: 'test',
          projectId: 'proj-z',
        },
      ]),
    )
    vi.resetModules()
    const fresh = await import('./schedules')
    const state = fresh.getSchedules()
    expect(state[0].kind).toBe('test')
    expect(state[0].projectId).toBe('proj-z')
  })

  it('drops a non-string projectId to "" (back-compat, no crash)', async () => {
    localStorage.setItem(
      'scprism.schedules',
      JSON.stringify([
        {
          id: 'bad-projectid',
          task: 'Bad',
          everyMinutes: 30,
          agents: '',
          enabled: true,
          lastRun: 0,
          runs: [],
          projectId: 42,
        },
      ]),
    )
    vi.resetModules()
    const fresh = await import('./schedules')
    const state = fresh.getSchedules()
    expect(state[0].projectId).toBe('')
  })
})
