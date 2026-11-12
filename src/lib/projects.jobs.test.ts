import { describe, expect, it } from 'vitest'
import {
  addProject,
  addProjectStep,
  attachProject,
  folderJobBlock,
  getProjects,
  updateProject,
} from './projects'

// A job typed in a project's room is done in that project's folder: it becomes
// the project's next step, and the same governed build that ran the plan runs
// it. These pin what the store records — the driver reads nothing else.
describe('a job for the folder', () => {
  function built() {
    const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
    updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 1, status: 'done', lastNote: 'wrote hello.md' })
    return p.id
  }
  const find = (id: string) => getProjects().projects.find((p) => p.id === id)!

  it('a finished project takes the job as its next step and is ready to run', () => {
    const id = built()
    const r = addProjectStep(id, '  Rewrite hello.md as a warmer greeting  ')
    expect(r).toEqual({ ok: true, index: 1, total: 2, starts: 'now' })
    const p = find(id)
    expect(p.plan).toEqual(['Write hello.md', 'Rewrite hello.md as a warmer greeting'])
    expect(p.stepIndex).toBe(1)
    expect(p.refinePass).toBe(0)
    expect(p.status).toBe('planned')
    // The last result stays on screen until the new one lands.
    expect(p.lastNote).toBe('wrote hello.md')
  })

  it('remembers where the typed jobs begin', () => {
    const id = built()
    addProjectStep(id, 'first job')
    addProjectStep(id, 'second job')
    expect(find(id).jobsFrom).toBe(1)
  })

  it('an opened folder with no plan takes a job straight away', () => {
    const p = attachProject('site', '/Users/someone/site', '', '')
    expect(folderJobBlock(find(p.id))).toBe('')
    const r = addProjectStep(p.id, 'Fix the footer link')
    expect(r).toEqual({ ok: true, index: 0, total: 1, starts: 'now' })
    expect(find(p.id).plan).toEqual(['Fix the footer link'])
    expect(find(p.id).status).toBe('planned')
    expect(find(p.id).jobsFrom).toBe(0)
  })

  it('a plan that has not been started keeps its order — the job waits with it', () => {
    const id = built()
    updateProject(id, { plan: ['a', 'b'], stepIndex: 0, status: 'planned' })
    const r = addProjectStep(id, 'c')
    expect(r).toEqual({ ok: true, index: 2, total: 3, starts: 'with-plan' })
    expect(find(id).stepIndex).toBe(0)
  })

  it('an attached folder with a goal is planned from that goal first', () => {
    const p = attachProject('site', '/Users/someone/site-2', 'port it to v2', '')
    expect(folderJobBlock(find(p.id))).toMatch(/no plan yet/)
  })

  it('a new project that has not been planned is not ready for a job', () => {
    const p = addProject('fresh', '', '', '~/vault/projects/fresh')
    expect(folderJobBlock(find(p.id))).toMatch(/no plan yet/)
    expect(addProjectStep(p.id, 'do a thing').ok).toBe(false)
    expect(find(p.id).plan).toEqual([])
  })

  it('a running build is not interrupted', () => {
    const id = built()
    updateProject(id, { status: 'running' })
    expect(folderJobBlock(find(id))).toMatch(/running/)
    expect(addProjectStep(id, 'do a thing').ok).toBe(false)
    expect(find(id).plan).toEqual(['Write hello.md'])
  })

  it('a step that needs attention is dealt with first', () => {
    const id = built()
    updateProject(id, { status: 'attention', stepIndex: 0 })
    expect(folderJobBlock(find(id))).toMatch(/needs attention/)
    expect(addProjectStep(id, 'do a thing').ok).toBe(false)
  })

  it('an empty job changes nothing', () => {
    const id = built()
    expect(addProjectStep(id, '   ').ok).toBe(false)
    expect(find(id).plan).toEqual(['Write hello.md'])
  })

  it('a project that is gone is refused, not invented', () => {
    expect(addProjectStep('nope', 'do a thing').ok).toBe(false)
    expect(folderJobBlock(null)).toMatch(/no project/)
  })
})
