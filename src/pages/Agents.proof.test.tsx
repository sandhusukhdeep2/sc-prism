import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { create, update } from '../lib/agents'

// Every agent can be proven, and says whether it has been (design 2026-11-08 §B, Task 4).
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
    deleteVaultFile: vi.fn(async () => null),
  }
})
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native, storeGet: () => new Promise<string | null>(() => {}), storeSet: async () => {} }
})
const prover = vi.hoisted(() => ({ proveAgent: vi.fn() }))
vi.mock('../lib/proveAgent', async (orig) => {
  const actual = await orig<typeof import('../lib/proveAgent')>()
  return { ...actual, proveAgent: prover.proveAgent }
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
  native.files.clear()
  localStorage.clear()
  prover.proveAgent.mockReset()
})
afterEach(() => localStorage.clear())

describe('the crew cards wear their proof', () => {
  it('a proven agent shows a dated chip; an unproven one says why; a new one says not yet', async () => {
    const proven = create({ name: 'Proven One', role: 'r', model: 'local' })
    update(proven.id, { proof: { at: Date.UTC(2026, 10, 8), proven: true, reason: '' } })
    const un = create({ name: 'Unproven One', role: 'r', model: 'local' })
    update(un.id, { proof: { at: 0, proven: false, reason: 'local refused the request (HTTP 401)' } })
    create({ name: 'Fresh One', role: 'r', model: 'local' })
    await act(async () => {
      renderAgents()
    })
    expect(screen.getByText(/^proven ✓ /)).toBeInTheDocument()
    expect(screen.getByText('unproven — local refused the request (HTTP 401)')).toBeInTheDocument()
    expect(screen.getAllByText('not yet proven').length).toBeGreaterThan(0)
  })

  it('a cloud agent’s button says what proving costs', async () => {
    create({ name: 'Cloud One', role: 'r', model: 'claude' })
    await act(async () => {
      renderAgents()
    })
    expect(screen.getByRole('button', { name: 'Prove Cloud One' })).toHaveTextContent('Prove on claude · costs cents')
  })

  it('Prove runs the shared prover once and the chip updates', async () => {
    // A name no earlier test used: the agents store is module-level state and
    // survives between tests in this file.
    const a = create({ name: 'Prove Me', role: 'r', model: 'local' })
    prover.proveAgent.mockResolvedValue({ proven: true, at: Date.UTC(2026, 10, 8), lines: [], reason: '' })
    await act(async () => {
      renderAgents()
    })
    fireEvent.click(screen.getByRole('button', { name: `Prove ${a.name}` }))
    await waitFor(() => expect(prover.proveAgent).toHaveBeenCalledTimes(1))
    expect(prover.proveAgent.mock.calls[0][0]).toMatchObject({ name: 'Prove Me' })
    // Scoped to THIS tile: another test's proven agent is still in the store.
    const tile = screen.getByText('Prove Me').closest('.agent-tile') as HTMLElement
    await within(tile).findByText(/^proven ✓ /)
    // The proof is written to the agent's file, or the next vault sync erases it.
    await waitFor(() => expect(native.writeVaultNote).toHaveBeenCalledWith('/vault', 'agents/prove-me.md', expect.stringContaining('proven_at:')))
  })
})
