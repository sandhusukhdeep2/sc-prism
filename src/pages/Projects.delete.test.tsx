// "give me option to delete project loop other stuff also" (the owner,
// 2026-11-14). Three things in a project's room that could not be deleted
// from it, or were deleted only half-way:
//   • a standing loop — it could be switched off, never removed;
//   • a plan step that has not been started;
//   • the project itself, which left its loops firing and its agents assigned
//     to nothing.
// Harness follows Projects.manage.test.tsx (real stores, Workspace rendered
// with the project active).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  appendVaultNote: vi.fn(async () => 'conversations/x.md'),
}))

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    revealPath: async () => {},
    listProjectFiles: async () => [],
    expandUserPath: async (p: string) => p,
    resolveVaultDir: async () => '/vault',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    listVaultTree: async () => [],
    readVaultFile: async () => null,
    writeVaultNote: async () => null,
    appendVaultNote: native.appendVaultNote,
  }
})
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject, getProjects, removeProject, updateProject, type Project } from '../lib/projects'
import { addSchedule, getSchedules, projectSchedules, removeSchedule } from '../lib/schedules'
import { create as createAgent, list as listAgents, remove as removeAgent } from '../lib/agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

function seed(patch: Partial<Project>, thread: unknown[] = []) {
  const project = addProject('Delete Target', 'ship it', '', '/tmp/delete-target')
  updateProject(project.id, { status: 'planned', plan: ['step one'], ...patch })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [project.id]: thread },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      activeProjectId: project.id,
    }),
  )
  return project
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function wipe() {
  localStorage.clear()
  for (const p of getProjects().projects) removeProject(p.id)
  for (const s of getSchedules()) removeSchedule(s.id)
  for (const a of listAgents()) if (!a.system && a.name.startsWith('Delete ')) removeAgent(a.id)
  native.appendVaultNote.mockClear()
}

describe('deleting a loop from the project’s own room', () => {
  beforeEach(wipe)
  afterEach(wipe)

  it('each loop has a Delete, and it removes that loop only', async () => {
    const p = seed({})
    addSchedule('build it', 30, '', p.id, 'build')
    addSchedule('test it', 30, '', p.id, 'test')
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /^Loops/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete build loop' }))
    expect(projectSchedules(p.id).map((s) => s.task)).toEqual(['test it'])
    expect(screen.queryByRole('button', { name: 'Delete build loop' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete test loop' })).toBeInTheDocument()
  })
})

describe('taking a step off the plan', () => {
  beforeEach(wipe)
  afterEach(wipe)

  it('a step that has not been started can be removed; one that ran cannot', async () => {
    const p = seed({ plan: ['lay the base', 'add the page', 'polish'], stepIndex: 1 })
    renderWorkspace()
    const plan = (await screen.findByText('add the page')).closest('ol') as HTMLElement
    // Step 1 ran: it is the record, no remove on it.
    expect(within(plan).queryByRole('button', { name: 'Remove step 1' })).not.toBeInTheDocument()
    expect(within(plan).getByRole('button', { name: 'Remove step 2' })).toBeInTheDocument()
    fireEvent.click(within(plan).getByRole('button', { name: 'Remove step 3' }))
    expect(getProjects().projects.find((x) => x.id === p.id)?.plan).toEqual(['lay the base', 'add the page'])
    expect(screen.queryByText('polish')).not.toBeInTheDocument()
  })
})

describe('deleting a project takes what belonged to it', () => {
  beforeEach(wipe)
  afterEach(wipe)

  it('says what goes with it, then removes its loops and frees its agents', async () => {
    const p = seed({})
    addSchedule('build it', 30, '', p.id, 'build')
    addSchedule('test it', 30, '', p.id, 'test')
    addSchedule('somebody else’s job', 60, '')
    const dev = createAgent({ name: 'Delete Dev', role: 'developer', model: 'local', assignedTo: p.id })
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /delete project/i }))
    expect(
      screen.getByText(
        'removes it from SC Prism with its 2 loops; its 1 agent goes back to the library — the folder on disk is untouched',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /really delete/i }))
    expect(getProjects().projects.some((x) => x.id === p.id)).toBe(false)
    expect(getSchedules().map((s) => s.task)).toEqual(['somebody else’s job'])
    expect(listAgents().find((a) => a.id === dev.id)?.assignedTo).toBe('')
  })

  it('files the room’s conversation in the vault before it goes, and says so', async () => {
    const p = seed({}, [
      { id: 'm1', kind: 'user', text: 'make the page warmer' },
      { id: 'm2', kind: 'assistant', text: 'done — see index.html' },
    ])
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /delete project/i }))
    expect(
      screen.getByText(
        'removes it from SC Prism; its conversation is filed in your vault — the folder on disk is untouched',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /really delete/i }))
    await waitFor(() => expect(getProjects().projects.some((x) => x.id === p.id)).toBe(false))
    expect(native.appendVaultNote).toHaveBeenCalledWith(
      '/vault',
      `conversations/${p.id}.md`,
      expect.stringContaining('make the page warmer'),
    )
  })
})
