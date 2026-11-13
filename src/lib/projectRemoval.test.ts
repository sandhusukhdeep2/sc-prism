// Deleting a project takes what belonged to it (the owner, 2026-11-14: "give
// me option to delete project loop other stuff also"). Before this, a deleted
// project left its standing loops behind — they kept firing at a project that
// no longer existed — and its agents stayed assigned to nothing.
import { beforeEach, describe, expect, it } from 'vitest'
import { addProject, getProjects } from './projects'
import { addSchedule, getSchedules, projectSchedules, removeSchedule } from './schedules'
import { create as createAgent, list as listAgents } from './agents'
import { removalNote, removalScope, removeProjectWithItsThings } from './projectRemoval'

beforeEach(() => {
  localStorage.clear()
  for (const p of getProjects().projects) removeProjectWithItsThings(p.id)
  for (const s of getSchedules()) removeSchedule(s.id)
})

describe('removalScope — what goes with a project', () => {
  it('counts the loops and the agents that belong to it, and nobody else’s', () => {
    const mine = addProject('Mine', 'ship', '')
    const other = addProject('Other', 'ship', '')
    addSchedule('build mine', 30, '', mine.id, 'build')
    addSchedule('test mine', 30, '', mine.id, 'test')
    addSchedule('build other', 30, '', other.id, 'build')
    addSchedule('a standing job', 60, '')
    createAgent({ name: 'Mine Dev', role: 'developer', model: 'local', assignedTo: mine.id })
    createAgent({ name: 'Other Dev', role: 'developer', model: 'local', assignedTo: other.id })
    expect(removalScope(mine.id, getSchedules(), listAgents())).toEqual({
      loops: 2,
      agents: 1,
      conversation: false,
    })
    // A room that was talked in has a conversation to file.
    expect(removalScope(mine.id, getSchedules(), listAgents(), 4).conversation).toBe(true)
  })
})

describe('removalNote — one sentence that says all of it', () => {
  it('a project with nothing attached reads as before', () => {
    expect(removalNote({ loops: 0, agents: 0, conversation: false }, false)).toBe(
      'removes it from SC Prism — the folder on disk is untouched',
    )
  })

  it('names the loops that stop and the agents that go back', () => {
    expect(removalNote({ loops: 2, agents: 1, conversation: false }, false)).toBe(
      'removes it from SC Prism with its 2 loops; its 1 agent goes back to the library — the folder on disk is untouched',
    )
    expect(removalNote({ loops: 1, agents: 0, conversation: false }, false)).toBe(
      'removes it from SC Prism with its 1 loop — the folder on disk is untouched',
    )
    expect(removalNote({ loops: 0, agents: 3, conversation: false }, false)).toBe(
      'removes it from SC Prism; its 3 agents go back to the library — the folder on disk is untouched',
    )
  })

  it('says the conversation is filed, joined to whatever else goes', () => {
    expect(removalNote({ loops: 0, agents: 0, conversation: true }, false)).toBe(
      'removes it from SC Prism; its conversation is filed in your vault — the folder on disk is untouched',
    )
    expect(removalNote({ loops: 2, agents: 1, conversation: true }, false)).toBe(
      'removes it from SC Prism with its 2 loops; its 1 agent goes back to the library and its conversation is filed in your vault — the folder on disk is untouched',
    )
  })

  it('says where the folder goes when it is trashed too', () => {
    expect(removalNote({ loops: 1, agents: 0, conversation: false }, true)).toBe(
      'removes it from SC Prism with its 1 loop, and moves its folder to the Trash — you can put it back from the Finder',
    )
  })
})

describe('removeProjectWithItsThings', () => {
  it('removes the project and its loops, and hands its agents back to the library', () => {
    const mine = addProject('Mine', 'ship', '')
    const other = addProject('Other', 'ship', '')
    addSchedule('build mine', 30, '', mine.id, 'build')
    addSchedule('build other', 30, '', other.id, 'build')
    addSchedule('a standing job', 60, '')
    const dev = createAgent({ name: 'Mine Dev', role: 'developer', model: 'local', assignedTo: mine.id })
    const theirs = createAgent({ name: 'Other Dev', role: 'developer', model: 'local', assignedTo: other.id })

    removeProjectWithItsThings(mine.id)

    expect(getProjects().projects.map((p) => p.id)).toEqual([other.id])
    expect(projectSchedules(mine.id)).toEqual([])
    expect(getSchedules().map((s) => s.task).sort()).toEqual(['a standing job', 'build other'])
    // The agent is kept — it is the user's work — only its assignment goes.
    expect(listAgents().find((a) => a.id === dev.id)?.assignedTo).toBe('')
    expect(listAgents().find((a) => a.id === theirs.id)?.assignedTo).toBe(other.id)
  })
})
