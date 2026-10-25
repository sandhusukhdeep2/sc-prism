import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Only the native seam is mocked (the desk polls the vault, and the roster
// ledger is written vault-side). The roster store, the desk projection and the
// agent library are all REAL — the assertions below are about what actually
// lands in the library, and when.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  readVaultFile: vi.fn(async () => null as string | null),
  writeVaultNote: vi.fn(async (_v: string, rel: string) => `/vault/${rel}`),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})
// The roster gate (f2766c6) refuses a seat whose provider cannot answer, and in
// jsdom nothing can. These tests are about the ROSTER, so the local provider is
// made genuinely reachable; the sit-out behaviour has its own test at the end.
vi.mock('../lib/settings', async (importActual) => {
  const actual = await importActual<typeof import('../lib/settings')>()
  return { ...actual, pingProvider: vi.fn(async () => 'ok' as const) }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import Desk from './Desk'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { list as listAgents, remove as removeAgent } from '../lib/agents'
import {
  dismiss,
  list as listRosters,
  propose,
  type NewRosterInput,
  type RosterRole,
} from '../lib/projectRoster'

const NEEDS = [
  'a market scan of three competitors before we price',
  'a landing page that explains the offer',
]

let seq = 0

function rosterInput(over: Partial<NewRosterInput> = {}): NewRosterInput {
  const roles: RosterRole[] = [
    {
      name: `Market scout ${++seq}`,
      purpose: 'scan the three competitors and write what they charge',
      model: 'local',
      modelWhy: 'bulk reading, and it never leaves the Mac',
      capabilities: ['vault', 'web'],
      need: NEEDS[0],
    },
    {
      name: `Page writer ${seq}`,
      purpose: 'draft the landing page copy',
      model: 'local',
      modelWhy: 'good enough for a first draft, and free',
      capabilities: ['writes'],
      need: NEEDS[1],
    },
  ]
  return {
    roles,
    evidence: { projectId: `proj-${seq}`, projectName: 'Pricing relaunch', needs: NEEDS },
    ...over,
  }
}

function renderDesk() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Desk show="needs" />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function clearRosters(): void {
  for (const r of listRosters()) if (r.status === 'open') dismiss(r.id, Date.now())
}

// Sprint D made web-research ON by default, which grants the user (and thus
// proposals) the web capability. These tests exercise the LACKING case — a
// user who switched web off — so they seed that state explicitly.
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('scprism.settings', JSON.stringify({ webResearch: false }))
  native.isNative.mockReturnValue(true)
  native.writeVaultNote.mockClear()
  native.readVaultFile.mockReset().mockResolvedValue(null)
})
afterEach(() => {
  clearRosters()
  for (const a of listAgents()) if (!a.system) removeAgent(a.id)
  localStorage.clear()
  vi.clearAllMocks()
})

describe('the desk row for a proposed PROJECT ROSTER', () => {
  it('lists every role with its AI, its capabilities and the need it serves', async () => {
    const input = rosterInput()
    propose(input, Date.now())
    renderDesk()

    expect(
      await screen.findByText(/Team proposed for Pricing relaunch — 2 roles/),
    ).toBeInTheDocument()
    // role names
    expect(screen.getByText(input.roles[0].name)).toBeInTheDocument()
    expect(screen.getByText(input.roles[1].name)).toBeInTheDocument()
    // which AI, and why
    expect(
      screen.getByText(/would run on local — bulk reading, and it never leaves the Mac/),
    ).toBeInTheDocument()
    // what it may touch — the CLAMPED grant. Default settings grant the vault
    // and project writes but NOT web, so web is refused and SAID to be refused.
    expect(screen.getByText('may: read your vault')).toBeInTheDocument()
    expect(screen.getByText('may: write project files')).toBeInTheDocument()
    expect(screen.getByText(/not granted: web/)).toBeInTheDocument()
    // the project's own need, quoted
    expect(screen.getByText(`for: “${NEEDS[0]}”`)).toBeInTheDocument()
    // and the standing promise
    expect(screen.getByText(/Not created yet/)).toBeInTheDocument()
  })

  it('creates nothing until the ONE Create is tapped, then creates them all', async () => {
    const input = rosterInput()
    propose(input, Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)

    // Nothing in the library yet — a proposal is not a team.
    expect(listAgents().filter((a) => !a.system)).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Create all 2/ }))

    await waitFor(() => {
      expect(listAgents().filter((a) => !a.system)).toHaveLength(2)
    })
    const made = listAgents().filter((a) => !a.system)
    expect(made.map((a) => a.name).sort()).toEqual(
      [input.roles[0].name, input.roles[1].name].sort(),
    )
    // Both belong to the project and carry NO borrowed history.
    for (const a of made) {
      expect(a.assignedTo).toBe(input.evidence.projectId)
      expect(a.usage).toBe(0)
      expect(a.evalScore).toBe(0)
    }
    // The row is gone (the record is 'created'), and the ledger was written.
    await waitFor(() => {
      expect(screen.queryByText(/Team proposed for Pricing relaunch/)).not.toBeInTheDocument()
    })
    expect(native.writeVaultNote).toHaveBeenCalled()
  })

  it('NEVER creates an agent holding a capability the user does not have', async () => {
    // The proposal asks for vault+web. Default settings do NOT grant web, so it
    // can never be given — asserted on what actually reached the LIBRARY, not
    // on a label. (The engine clamps again at AgentGrants.__init__, which is
    // where the security boundary is tested — see engine/tests/test_capabilities.)
    const input = rosterInput()
    propose(input, Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)
    fireEvent.click(screen.getByRole('button', { name: /Create all 2/ }))

    await waitFor(() => expect(listAgents().filter((a) => !a.system)).toHaveLength(2))
    const scout = listAgents().find((a) => a.name === input.roles[0].name)
    const writer = listAgents().find((a) => a.name === input.roles[1].name)
    // Asked for vault+web; the user has no web, so web never lands.
    expect(scout?.skills).toEqual(['vault'])
    // Asked for writes, which the user DOES hold — so it lands, unchanged.
    expect(writer?.skills).toEqual(['writes'])
  })

  it('creates the EDITED values, never the originals', async () => {
    const input = rosterInput()
    propose(input, Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)

    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))
    const nameField = screen.getByLabelText('Role 1 name')
    fireEvent.change(nameField, { target: { value: 'Pricing analyst' } })
    fireEvent.click(screen.getByRole('button', { name: /Create these 2/ }))

    await waitFor(() => expect(listAgents().filter((a) => !a.system)).toHaveLength(2))
    expect(listAgents().some((a) => a.name === 'Pricing analyst')).toBe(true)
    expect(listAgents().some((a) => a.name === input.roles[0].name)).toBe(false)
  })

  it('a capability the user lacks cannot even be ticked', async () => {
    propose(rosterInput(), Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))

    // Default settings: vault + writes granted; web + tools are not, so their
    // boxes cannot be ticked at all — an ungrantable capability never looks
    // grantable.
    expect(screen.getByLabelText('Role 1 vault')).not.toBeDisabled()
    expect(screen.getByLabelText('Role 1 writes')).not.toBeDisabled()
    expect(screen.getByLabelText('Role 1 web')).toBeDisabled()
    expect(screen.getByLabelText('Role 1 tools')).toBeDisabled()
  })

  it("does not staff a seat whose AI can't answer, and says why", async () => {
    // Gemini is switched off on this install (Google closed that login for
    // individual accounts), so a seat proposed on it must NOT be created — and
    // the reason must be on screen rather than the seat quietly vanishing.
    const input = rosterInput()
    input.roles[1] = { ...input.roles[1], model: 'gemini' }
    propose(input, Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)

    expect(screen.getByText(/can’t be staffed —/)).toBeInTheDocument()
    expect(screen.getByText(/This role will NOT be created/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Create all 1/ }))
    await waitFor(() => expect(listAgents().filter((a) => !a.system)).toHaveLength(1))
    expect(listAgents().some((a) => a.name === input.roles[1].name)).toBe(false)
  })

  it('dismissal is two-step and sticky, and creates nothing', async () => {
    propose(rosterInput(), Date.now())
    renderDesk()
    await screen.findByText(/Team proposed for Pricing relaunch/)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByText('Dismiss for good?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, dismiss' }))

    await waitFor(() => {
      expect(screen.queryByText(/Team proposed for Pricing relaunch/)).not.toBeInTheDocument()
    })
    expect(listAgents().filter((a) => !a.system)).toHaveLength(0)
    expect(listRosters().some((r) => r.status === 'dismissed')).toBe(true)
  })
})
