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

  // 2026-11-14 ("Visible agents"): a quiet project room is its Team board and
  // its chat. What can open beside the chat is offered in the room's head.
  it('a quiet project room is its board and its chat; files and details are offered', async () => {
    await openRoom()
    expect(document.querySelector('.pane')).toBeNull()
    expect(document.querySelector('.ws__chatcol .board')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: /describe/i })).toBeInTheDocument()
    const offered = screen.getByRole('group', { name: 'Open beside the chat' })
    expect(offered).toHaveTextContent('Files')
    expect(offered).toHaveTextContent('Details')
  })

  it('Details opens beside the chat on request, and then its own tabs say what is open', async () => {
    await openRoom()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.pane .ws__details')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: /describe/i })).toBeInTheDocument()
    // The pane's tabs say what is open — the room's head does not repeat them.
    expect(screen.queryByRole('group', { name: 'Open beside the chat' })).toBeNull()
  })

  it('a project waiting on the user opens on its details — they hold the button', async () => {
    const p = addProject('waiting room', 'greet the crew', '', '~/vault/projects/waiting-room')
    updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 0, status: 'planned' })
    renderWorkspace()
    await act(async () => {
      captured.app!.setActiveProject(p.id)
      await Promise.resolve()
    })
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
  })

  it('the project’s files open beside the chat, and a file is read there', async () => {
    await openRoom()
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
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
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Steps' })).toBeNull()
  })

  it('the pane can be closed, and stays closed until asked for', async () => {
    await openRoom()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close the pane' }))
    expect(document.querySelector('.pane')).toBeNull()
    // Closed, the room's head offers what this room can open beside the chat.
    expect(screen.getByRole('group', { name: 'Open beside the chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(document.querySelector('.pane .ws__details')).not.toBeNull()
  })

  it('another room starts from its own rule, not from the tab the last room had open', async () => {
    const first = await openRoom('hello crew')
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    const other = addProject('other room', 'something else', '', '~/vault/projects/other-room')
    updateProject(other.id, { plan: ['a'], stepIndex: 1, status: 'done' })
    await act(async () => {
      captured.app!.setActiveProject(other.id)
      await Promise.resolve()
    })
    // The other room is quiet: its pane is shut, whatever the last room had open.
    expect(document.querySelector('.pane')).toBeNull()
    expect(first).not.toBe(other.id)
  })

  it('the Manager’s room keeps its pane shut, and offers the desk beside the chat', async () => {
    renderWorkspace()
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('.pane')).toBeNull()
    const offered = screen.getByRole('group', { name: 'Open beside the chat' })
    expect(offered).toHaveTextContent('Desk')
    fireEvent.click(screen.getByRole('button', { name: 'Desk' }))
    expect(screen.getByRole('tab', { name: 'Desk' })).toHaveAttribute('aria-selected', 'true')
  })
})
