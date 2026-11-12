// THE SPLIT ROOM (2026-11-12): the chat on the left, and beside it a pane for
// what the work produces. The stage test holds the run drawn to be watched and
// the drawer test holds Details; these hold the rest of the pane's behaviour
// in a project's room.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'

const h = vi.hoisted(() => ({
  runNativeTeam: vi.fn(),
  runNativeTask: vi.fn(),
  runNativeProject: vi.fn(),
  spans: [] as unknown[],
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => h.spans as never[],
    listProjectFiles: async () => [
      { path: 'hello.md', dir: false, mtime: 1, size: 13 },
      { path: 'notes/plan.md', dir: false, mtime: 1, size: 40 },
    ],
    readTextFile: async () => 'Hello, crew.',
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    runNativeTeam: h.runNativeTeam,
    runNativeTask: h.runNativeTask,
    runNativeProject: h.runNativeProject,
    cancelEngineRun: async () => {},
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function clean() {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
}

async function openRoom(name = 'hello crew'): Promise<string> {
  const p = addProject(name, 'greet the crew', '', `~/vault/projects/${name.replace(/ /g, '-')}`)
  updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 1, status: 'done' })
  renderWorkspace()
  await act(async () => {
    captured.app!.setActiveProject(p.id)
    await Promise.resolve()
  })
  return p.id
}

describe('Work — the pane beside the chat, in a project’s room', () => {
  beforeEach(clean)
  afterEach(clean)

  it('a quiet project room opens on its details, with the chat still on screen', async () => {
    await openRoom()
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.pane .ws__details')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: /describe/i })).toBeInTheDocument()
    // The pane's tabs say what is open — the chat's header does not repeat them.
    expect(screen.queryByRole('group', { name: 'Open beside the chat' })).toBeNull()
  })

  it('the project’s files open beside the chat, and a file is read there', async () => {
    await openRoom()
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(await screen.findByRole('button', { name: 'hello.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'notes/plan.md' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'hello.md' }))
    expect(await screen.findByText('Hello, crew.')).toBeInTheDocument()
    // The conversation did not go anywhere.
    expect(screen.getByRole('textbox', { name: /describe/i })).toBeInTheDocument()
  })

  it('a room with no crew to draw does not offer a stage', async () => {
    await openRoom()
    expect(screen.queryByRole('tab', { name: 'Stage' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Steps' })).toBeNull()
  })

  it('the pane can be closed, and stays closed until asked for', async () => {
    await openRoom()
    fireEvent.click(screen.getByRole('button', { name: 'Close the pane' }))
    expect(document.querySelector('.pane')).toBeNull()
    // Closed, the chat's header offers what this room can open beside it.
    expect(screen.getByRole('group', { name: 'Open beside the chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(document.querySelector('.pane .ws__details')).not.toBeNull()
  })

  it('another room starts from its own rule, not from the tab the last room had open', async () => {
    const first = await openRoom('hello crew')
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    const other = addProject('other room', 'something else', '', '~/vault/projects/other-room')
    updateProject(other.id, { plan: ['a'], stepIndex: 1, status: 'done' })
    await act(async () => {
      captured.app!.setActiveProject(other.id)
      await Promise.resolve()
    })
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    expect(first).not.toBe(other.id)
  })

  it('the Manager room, with no project and no crew, has no pane at all', async () => {
    renderWorkspace()
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('.pane')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Open beside the chat' })).toBeNull()
  })
})
