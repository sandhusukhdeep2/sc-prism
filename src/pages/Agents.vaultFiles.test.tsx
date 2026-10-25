// Agent-standard slice A, the PAGE half: the Agents page is where agents are
// created and deleted, so it is where the store's write-through must actually
// fire — a definition file written on create, the agent's REAL file deleted on
// delete, and the vault synced on mount so hand-authored `agents/*.md` files
// (and the first-load migration of the seed library) reach the page at all.
// The lib tests prove the mechanics; this file proves the page calls them —
// the skill library's write-through had exactly this seam, wired in
// pages/Skills.tsx, and an unwired store is just localStorage with extra steps.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { list as listAgents, remove as removeAgent } from '../lib/agents'
import { COMPANION_MANAGER_ID, getManagers } from '../lib/managers'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

const native = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    isNative: vi.fn(() => true),
    resolveVaultDir: vi.fn(async () => '/vault'),
    listVaultTree: vi.fn(async () => [...files.keys()]),
    readVaultFile: vi.fn(async (_v: string, rel: string) => files.get(rel) ?? null),
    writeVaultNote: vi.fn(async (_v: string, rel: string, content: string) => {
      files.set(rel, content)
      return `/vault/${rel}`
    }),
    deleteVaultFile: vi.fn(async (_v: string, rel: string) => {
      files.delete(rel)
      return null
    }),
  }
})
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    ...native,
    // Keep the store's disk hydration pending forever (the team test's
    // pattern) so no late storeSet races the assertions below.
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => [],
  }
})

function renderAgents() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Agents />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  native.files.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  for (const a of listAgents()) if (!a.system) removeAgent(a.id)
  localStorage.clear()
})

describe('Agents page — the vault file rides every mutation', () => {
  it('mount syncs the vault: the library migrates to agents/*.md files', async () => {
    await act(async () => {
      renderAgents()
    })
    // The page asked the vault what exists…
    await waitFor(() => expect(native.listVaultTree).toHaveBeenCalled())
    // …and the first native load made the seed library portable.
    await waitFor(() =>
      expect(native.writeVaultNote).toHaveBeenCalledWith(
        '/vault',
        'agents/planner.md',
        expect.stringContaining('name: Planner'),
      ),
    )
  })

  it('creating an agent through the form writes its definition file', async () => {
    await act(async () => {
      renderAgents()
    })
    fireEvent.click(screen.getByRole('button', { name: /open form/i }))
    fireEvent.change(screen.getByPlaceholderText(/name \(e\.g\. pr-reviewer\)/i), {
      target: { value: 'Filing Clerk' },
    })
    fireEvent.change(screen.getByPlaceholderText(/role \(e\.g\./i), {
      target: { value: 'keeps the records straight' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create agent/i }))
    })
    await waitFor(() =>
      expect(native.writeVaultNote).toHaveBeenCalledWith(
        '/vault',
        'agents/filing-clerk.md',
        expect.stringContaining('description: keeps the records straight'),
      ),
    )
  })

  it('the two-step delete removes the agent\'s REAL file — sourcePath, not the slug guess', async () => {
    // A discovered agent whose file does NOT sit at its canonical path: the
    // delete must follow sourcePath, or the real file survives and the next
    // sync resurrects the agent (the trap the whole design exists to spring).
    native.files.set(
      'agents/odd-clerk.md',
      '---\nname: Doomed Clerk\ndescription: filed oddly\nmodel: local\n---\n',
    )
    await act(async () => {
      renderAgents()
    })
    // Discovery put the file's agent on the page…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /actions for Doomed Clerk/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /actions for Doomed Clerk/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete Doomed Clerk$/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm delete Doomed Clerk/i }))
    })
    // …and the confirm deleted the file it was discovered from, nothing else.
    await waitFor(() =>
      expect(native.deleteVaultFile).toHaveBeenCalledWith('/vault', 'agents/odd-clerk.md'),
    )
    expect(native.deleteVaultFile).not.toHaveBeenCalledWith('/vault', 'agents/doomed-clerk.md')
    expect(screen.queryByText('Doomed Clerk')).not.toBeInTheDocument()
  })
})

// Slice D, the PAGE half: the mount effect also syncs the Companion's own
// definition file — migration writes agents/companion.md on first native
// visit, and an edited file's body is adopted into the heartbeat charter.
describe('the Agents page syncs the companion file on mount', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('first visit writes agents/companion.md', async () => {
    renderAgents()
    await waitFor(() => {
      expect(native.files.has('agents/companion.md')).toBe(true)
    })
    expect(native.files.get('agents/companion.md')).toContain('name: companion')
  })

  it('an edited companion file updates the heartbeat charter', async () => {
    native.files.set(
      'agents/companion.md',
      '---\nname: companion\nmodel: claude\n---\n\nNew orders from my editor.\n',
    )
    renderAgents()
    await waitFor(() => {
      const m = getManagers().managers.find((x) => x.id === COMPANION_MANAGER_ID)
      expect(m?.heartbeat?.charter).toBe('New orders from my editor.')
    })
  })
})

// Cycle 4, the PAGE half: an in-app charter edit (textarea blur) rewrites the
// file — proven RED against the unwired page before the handler landed.
describe('editing the companion charter writes through to the file', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('blur after an edit rewrites agents/companion.md with the new words', async () => {
    renderAgents()
    await waitFor(() => {
      expect(native.files.has('agents/companion.md')).toBe(true)
    })
    // The heartbeat card lives behind the Managers tab now.
    fireEvent.click(screen.getByRole('tab', { name: /managers/i }))
    const box = (await screen.findAllByLabelText(/charter — what to watch/i))[0]
    fireEvent.change(box, { target: { value: 'Watch only the ledger.' } })
    fireEvent.blur(box)
    await waitFor(() => {
      expect(native.files.get('agents/companion.md')).toContain('Watch only the ledger.')
    })
  })
})

// Slice D last piece, the PAGE half: manager definition files refresh on the
// same mount sync. Proven RED against the unwired page via stash.
describe('the Agents page exports manager files on mount', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('writes agents/managers/<slug>.md for a seeded report manager', async () => {
    renderAgents()
    await waitFor(() => {
      const paths = [...native.files.keys()]
      expect(paths.some((p) => p.startsWith('agents/managers/'))).toBe(true)
    })
  })
})
