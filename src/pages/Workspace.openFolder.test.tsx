// 2026-11-11, the owner: "I need you to work on an already existing project.
// User needs to select the directory… delete project and other stuff."
// Attaching a folder existed behind the second tab of the New project form.
// Opening a folder is now ONE action in the room list, and deleting a project
// can also move its folder to the Trash — guarded, never the default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { DeleteProjectControl } from './Projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { getProjects, openFolderAsProject, removeProject } from '../lib/projects'

const h = vi.hoisted(() => ({
  pickFolder: vi.fn(async () => '/Users/me/dev/my-repo' as string | null),
  trashProjectFolder: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  openInTerminal: vi.fn(async () => true),
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/Users/me/sc-vault',
    expandUserPath: async (p: string) => p,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => [],
    listProjectFiles: async () => [],
    pickFolder: h.pickFolder,
    trashProjectFolder: h.trashProjectFolder,
    openInTerminal: h.openInTerminal,
  }
})

function shell(children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>{children}</AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('scprism.settings', JSON.stringify({ projectWrites: true }))
  for (const p of getProjects().projects) removeProject(p.id)
  h.pickFolder.mockClear()
  h.trashProjectFolder.mockClear()
  h.pickFolder.mockResolvedValue('/Users/me/dev/my-repo')
  h.trashProjectFolder.mockResolvedValue({ ok: true })
})
afterEach(() => {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
})

describe('Work — open an existing folder as a project', () => {
  it('one click picks the folder, makes the project and enters its room', async () => {
    shell(<Workspace />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open folder/i }))
    })
    await settle()
    expect(h.pickFolder).toHaveBeenCalledTimes(1)
    const projects = getProjects().projects
    expect(projects).toHaveLength(1)
    expect(projects[0].path).toBe('/Users/me/dev/my-repo')
    expect(projects[0].name).toBe('my-repo')
    // The room is entered: its name is the page heading.
    expect(screen.getByRole('heading', { name: 'my-repo' })).toBeInTheDocument()
  })

  it('cancelling the picker changes nothing', async () => {
    h.pickFolder.mockResolvedValue(null)
    shell(<Workspace />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open folder/i }))
    })
    await settle()
    expect(getProjects().projects).toHaveLength(0)
  })

  it('opening a folder that is already a project enters that room and adds nothing', async () => {
    openFolderAsProject('/Users/me/dev/my-repo')
    shell(<Workspace />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open folder/i }))
    })
    await settle()
    expect(getProjects().projects).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'my-repo' })).toBeInTheDocument()
  })
})

describe('Delete project — the folder is kept unless you say otherwise', () => {
  it('by default removes the project from the app and never touches the folder', async () => {
    const { project } = openFolderAsProject('/Users/me/dev/my-repo')
    shell(<DeleteProjectControl projectId={project.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(screen.getByRole('checkbox', { name: /also move the folder to the Trash/i })).not.toBeChecked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Really delete' }))
    })
    await settle()
    expect(h.trashProjectFolder).not.toHaveBeenCalled()
    expect(getProjects().projects).toHaveLength(0)
  })

  it('with the box ticked it moves the folder to the Trash, protecting the vault, then removes the project', async () => {
    const { project } = openFolderAsProject('/Users/me/dev/my-repo')
    shell(<DeleteProjectControl projectId={project.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /also move the folder to the Trash/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Really delete' }))
    })
    await settle()
    expect(h.trashProjectFolder).toHaveBeenCalledWith('/Users/me/dev/my-repo', ['/Users/me/sc-vault'])
    expect(getProjects().projects).toHaveLength(0)
  })

  it('when the folder may not be moved it says why and keeps the project', async () => {
    h.trashProjectFolder.mockResolvedValue({ ok: false, reason: 'this folder holds your vault — it stays where it is' })
    const { project } = openFolderAsProject('/Users/me/dev/my-repo')
    shell(<DeleteProjectControl projectId={project.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /also move the folder to the Trash/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Really delete' }))
    })
    await settle()
    expect(screen.getByText(/holds your vault/)).toBeInTheDocument()
    expect(getProjects().projects).toHaveLength(1)
  })
})
