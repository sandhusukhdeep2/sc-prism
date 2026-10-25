// Project management controls (Sukhdeep, 2026-08-29 evening: "I can open
// file folder of that project, delete, and I can also start chat on
// pre-existing folder"). Two of the three land here:
//   • Reveal folder is ALWAYS offered (path validation stays at click time) —
//     not only once a project reaches done.
//   • Delete project exists, two-step inline confirm, and is honest about
//     scope: it removes the project from SC Prism — the folder on disk is
//     untouched.
// Harness follows Projects.approval.test.tsx (real providers seeded, real
// stores, Workspace rendered with the project active).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The ＋ New project affordance is native-gated; everything else in these
// tests is shape-independent. Same one-call short-circuit the Agents page
// tests use for the vault resolver, plus a forever-pending storeGet so disk
// hydration never races the seeded localStorage session.
const native = vi.hoisted(() => ({
  revealPath: vi.fn(async () => {}),
  pickFolder: vi.fn(async () => '/Users/x/my-site'),
  listProjectFiles: vi.fn(async () => [
    { path: 'docs', dir: true, mtime: 1, size: 0 },
    { path: 'docs/PITCH.md', dir: false, mtime: 2, size: 1229 },
  ]),
}))

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    revealPath: native.revealPath,
    pickFolder: native.pickFolder,
    listProjectFiles: native.listProjectFiles,
    expandUserPath: async (p: string) => p,
    resolveVaultDir: async () => '',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    listVaultTree: async () => [],
    readVaultFile: async () => null,
    writeVaultNote: async () => null,
  }
})
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject, getProjects, updateProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

function seedProject(status: 'planned' | 'done') {
  const project = addProject('Manage Target', 'ship it', '', '/tmp/manage-target')
  updateProject(project.id, { status, plan: ['step one'] })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [project.id]: [] },
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

describe('project management controls', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('offers Reveal folder before the project is done', async () => {
    seedProject('planned')
    renderWorkspace()
    expect(await screen.findByRole('button', { name: /reveal folder/i })).toBeInTheDocument()
  })

  it('deletes a project after an inline confirm, folder untouched', async () => {
    const p = seedProject('planned')
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /delete project/i }))
    // The confirm names the honest scope before anything happens.
    const confirm = await screen.findByRole('button', { name: /really delete/i })
    expect(screen.getByText(/folder on disk is untouched/i)).toBeInTheDocument()
    expect(getProjects().projects.some((x) => x.id === p.id)).toBe(true)
    fireEvent.click(confirm)
    expect(getProjects().projects.some((x) => x.id === p.id)).toBe(false)
  })
})

// Dogfooding report (Sukhdeep, 2026-08-29 evening): "I just created a new
// project but I got the old universal chat with the old messages." The
// intended contract, pinned: creating a project SELECTS it, and its thread
// starts EMPTY — no other thread's history bleeds in.
describe('a new project opens its own fresh chat', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('after create, the universal thread history is not shown', async () => {
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: {
          universal: [
            { id: 'm1', kind: 'user', text: 'OLD UNIVERSAL MESSAGE' },
            { id: 'm2', kind: 'assistant', text: 'old reply' },
          ],
        },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      }),
    )
    renderWorkspace()
    // The old history is visible in the universal chat before creating.
    expect(await screen.findByText(/OLD UNIVERSAL MESSAGE/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /new project/i }))
    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'fresh one' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    // The new project is selected and its thread is EMPTY.
    expect(screen.queryByText(/OLD UNIVERSAL MESSAGE/)).not.toBeInTheDocument()
  })
})

// Project-room spec §5: "every file the room mentions must be reachable from
// the room." The Files panel lists the folder's REAL contents (mocked bridge
// here — the walk itself is Rust-side), and clicking a row reveals that file.
describe('the room Files panel', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('lists real files with sizes and reveals one on click', async () => {
    seedProject('planned')
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /Files · 1 ▸/ }))
    const row = await screen.findByTitle('open in the Editor')
    expect(row.textContent).toMatch(/1\.2 KB|1229 B/i)
    // 2026-08-31: the row routes into the project-aware EDITOR; ↗ reveals.
    expect(row).toHaveAttribute('title', 'open in the Editor')
    fireEvent.click(screen.getByRole('button', { name: /Reveal docs\/PITCH\.md in Finder/ }))
    await waitFor(() => {
      expect(native.revealPath).toHaveBeenCalledWith('/tmp/manage-target/docs/PITCH.md')
    })
  })
})

// Project-room spec: "start chat on a pre-existing folder I SELECT" — the
// attach form gets the native picker; picking fills the path, and an empty
// name adopts the folder's own name.
describe('Attach existing uses the folder picker', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('choosing a folder fills path and defaults the name', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /new project/i }))
    fireEvent.click(screen.getByRole('tab', { name: /attach existing/i }))
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }))
    await waitFor(() => {
      expect(screen.getByLabelText(/repository path/i)).toHaveValue('/Users/x/my-site')
    })
    expect(screen.getByLabelText(/project name/i)).toHaveValue('my-site')
  })
})

// Sprint A (2026-08-30, his screenshot: THREE identical anonymous step
// notices in a row): consecutive app-voice notices with the SAME text render
// as ONE bubble carrying an honest ×N count — the record keeps every entry,
// only the rendering collapses.
describe('repeated identical notices collapse in the feed', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('three same-text notices render once with ×3', async () => {
    const p = seedProject('planned')
    const line = 'Ran your team on this step — it did not pass verification.'
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: {
          universal: [],
          [p.id]: [
            { id: 'n1', kind: 'notice', text: line },
            { id: 'n2', kind: 'notice', text: line },
            { id: 'n3', kind: 'notice', text: line },
            { id: 'n4', kind: 'notice', text: 'a different notice' },
          ],
        },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: p.id,
      }),
    )
    renderWorkspace()
    const repeats = await screen.findAllByText(new RegExp(line.slice(0, 30)))
    expect(repeats).toHaveLength(1)
    expect(screen.getByText(/×3/)).toBeInTheDocument()
    expect(screen.getByText('a different notice')).toBeInTheDocument()
  })
})

// Sprint B (2026-08-30): the composer defaults to the TEAM lane (his order),
// the manager is the alternative, and the three specialist lanes hide behind
// 'more ▾' — two visible choices, never five.
describe('the simplified target picker', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('team is preselected; specialist lanes are folded', async () => {
    renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: /change who takes this/i }))
    const team = await screen.findByRole('radio', { name: 'team' })
    expect(team).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radio', { name: 'agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /more ▾/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /more ▾/ }))
    expect(screen.getByRole('radio', { name: 'agent' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'staff project' })).toBeInTheDocument()
  })
})
