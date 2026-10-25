import { describe, it, expect } from 'vitest'
import { nextSendMode, type Project } from './projects'

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    path: '~/SC Projects/test-project',
    goal: 'do the thing',
    verifyCommand: 'npm test',
    createdAt: Date.now(),
    status: 'new',
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    ...over,
  }
}

describe('nextSendMode', () => {
  it('routes to companion when there is no active project', () => {
    expect(nextSendMode(null)).toBe('companion')
  })

  it('routes to project-interview for a fresh project (no plan, status new)', () => {
    expect(nextSendMode(makeProject({ plan: [], status: 'new' }))).toBe('project-interview')
  })

  it('routes to project-interview mid-interview (no plan, status interviewing)', () => {
    expect(nextSendMode(makeProject({ plan: [], status: 'interviewing' }))).toBe(
      'project-interview',
    )
  })

  it('routes to companion once a project has a plan', () => {
    expect(nextSendMode(makeProject({ plan: ['step'], status: 'planned' }))).toBe('companion')
  })

  it('routes to companion for a done project even with an empty plan', () => {
    expect(nextSendMode(makeProject({ plan: [], status: 'done' }))).toBe('companion')
  })
})
