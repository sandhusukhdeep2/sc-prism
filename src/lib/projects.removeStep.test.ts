// A step that has not been started can be taken off the plan (the owner,
// 2026-11-14: "give me option to delete … other stuff also"). A step that ran
// or is running is the record of what happened and stays.
import { beforeEach, describe, expect, it } from 'vitest'
import { addProject, getProjects, removeProject, removeProjectStep, stepRemovable, updateProject } from './projects'

function project(patch: Parameters<typeof updateProject>[1]) {
  const p = addProject('Steps', 'ship it', '')
  updateProject(p.id, patch)
  return getProjects().projects.find((x) => x.id === p.id)!
}
const fresh = (id: string) => getProjects().projects.find((x) => x.id === id)!

beforeEach(() => {
  localStorage.clear()
  for (const p of getProjects().projects) removeProject(p.id)
})

describe('stepRemovable', () => {
  it('a plan that has not been started: every step can go', () => {
    const p = project({ plan: ['a', 'b', 'c'], status: 'planned', stepIndex: 0 })
    expect([0, 1, 2].map((i) => stepRemovable(p, i))).toEqual([true, true, true])
  })

  it('steps that ran stay; the ones still ahead can go', () => {
    const p = project({ plan: ['a', 'b', 'c'], status: 'planned', stepIndex: 1 })
    expect([0, 1, 2].map((i) => stepRemovable(p, i))).toEqual([false, true, true])
  })

  it('a step that was tried and sent back is not “not started”', () => {
    const p = project({ plan: ['a', 'b'], status: 'planned', stepIndex: 0, refinePass: 1 })
    expect(stepRemovable(p, 0)).toBe(false)
    expect(stepRemovable(p, 1)).toBe(true)
  })

  it('nothing is removed under a running build, one waiting on you, or one needing attention', () => {
    for (const status of ['running', 'awaiting', 'attention'] as const) {
      const p = project({ plan: ['a', 'b', 'c'], status, stepIndex: 0 })
      expect([0, 1, 2].map((i) => stepRemovable(p, i))).toEqual([false, false, false])
    }
  })

  it('a finished project has no step left to take off', () => {
    const p = project({ plan: ['a', 'b'], status: 'done', stepIndex: 2 })
    expect([0, 1].map((i) => stepRemovable(p, i))).toEqual([false, false])
  })
})

describe('removeProjectStep', () => {
  it('takes the step off and leaves the rest in order', () => {
    const p = project({ plan: ['a', 'b', 'c'], status: 'planned', stepIndex: 1 })
    expect(removeProjectStep(p.id, 2)).toBe(true)
    expect(fresh(p.id).plan).toEqual(['a', 'b'])
    expect(fresh(p.id).stepIndex).toBe(1)
    expect(fresh(p.id).status).toBe('planned')
  })

  it('refuses a step that already ran, and changes nothing', () => {
    const p = project({ plan: ['a', 'b', 'c'], status: 'planned', stepIndex: 1 })
    expect(removeProjectStep(p.id, 0)).toBe(false)
    expect(fresh(p.id).plan).toEqual(['a', 'b', 'c'])
  })

  it('removing the only step still ahead leaves the project finished', () => {
    // Two steps done, then a job typed in the room that was never started.
    const p = project({ plan: ['a', 'b', 'tidy up'], status: 'planned', stepIndex: 2, jobsFrom: 2 })
    expect(removeProjectStep(p.id, 2)).toBe(true)
    const after = fresh(p.id)
    expect(after.plan).toEqual(['a', 'b'])
    expect(after.status).toBe('done')
    expect(after.stepIndex).toBe(2)
    // No typed-in job is left, so the marker for them goes too.
    expect(after.jobsFrom).toBeUndefined()
  })

  it('removing every step returns the project to having no plan', () => {
    const p = project({ plan: ['only'], status: 'planned', stepIndex: 0 })
    expect(removeProjectStep(p.id, 0)).toBe(true)
    const after = fresh(p.id)
    expect(after.plan).toEqual([])
    expect(after.status).toBe('new')
    expect(after.stepIndex).toBe(0)
  })

  it('keeps the typed-in-job marker on the right step when an earlier planned step goes', () => {
    const p = project({ plan: ['a', 'b', 'c', 'job'], status: 'planned', stepIndex: 1, jobsFrom: 3 })
    expect(removeProjectStep(p.id, 2)).toBe(true)
    expect(fresh(p.id).plan).toEqual(['a', 'b', 'job'])
    expect(fresh(p.id).jobsFrom).toBe(2)
  })
})
