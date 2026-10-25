// The per-agent page (Sukhdeep, dogfooding day one, 2026-08-29): "give option
// to go on each agent page to customise and change". Every agent card opens
// /agents/<slug>; edits save to the store AND write through to the agent's
// definition file (slice A plumbing), so what the page says IS what the file
// says. Harness: fake native vault + real stores, as Agents.vaultFiles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AgentDetail from './AgentDetail'
import Agents from './Agents'
import { create as createAgent, agentSlug } from '../lib/agents'
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
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Routes>
                <Route path="/agents" element={<Agents />} />
                <Route path="/agents/:slug" element={<AgentDetail />} />
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('the per-agent page', () => {
  beforeEach(() => {
    native.files.clear()
    native.writeVaultNote.mockClear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('shows the agent and saves an edit through to its file', async () => {
    const a = createAgent({ name: 'market-scout', role: 'watches the market', model: 'local' })
    renderAt(`/agents/${agentSlug(a.name)}`)
    expect(screen.getByDisplayValue('market-scout')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/what this coworker is for/i), {
      target: { value: 'tracks competitor pricing weekly' },
    })
    fireEvent.change(screen.getByLabelText(/charter/i), {
      target: { value: 'Watch three competitors. Cite sources.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      const file = native.files.get('agents/market-scout.md')
      expect(file).toContain('tracks competitor pricing weekly')
      expect(file).toContain('Watch three competitors. Cite sources.')
    })
  })

  it('a built-in system agent is read-only and says so', () => {
    renderAt('/agents/planner')
    expect(screen.getByText(/built-in/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument()
  })

  it('an unknown slug offers the way back, never a blank page', () => {
    renderAt('/agents/no-such-agent')
    expect(screen.getByText(/no agent called/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to agents/i })).toBeInTheDocument()
  })

  it('clicking a crew card opens that agent’s page', async () => {
    // Unique name: the agents store is module state, so earlier tests' rows
    // survive within this file — a reused name would render two tiles.
    createAgent({ name: 'pricing-scout', role: 'watches prices', model: 'local' })
    renderAt('/agents')
    fireEvent.click(screen.getByRole('link', { name: /open pricing-scout/i }))
    await waitFor(() => {
      expect(screen.getByLabelText(/what this coworker is for/i)).toBeInTheDocument()
    })
  })
})

// Slice B, the CLIENT half: the agent page edits the `tools:` line — the
// grants each board seat's turn really runs under (engine reads the file).
describe('the agent page edits per-seat tools', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('ticking web writes tools: [vault, web] into the file', async () => {
    const a = createAgent({ name: 'tool-scout', role: 'scouts', model: 'local' })
    renderAt(`/agents/${agentSlug(a.name)}`)
    fireEvent.click(screen.getByRole('checkbox', { name: /read the vault/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /use the web/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      expect(native.files.get('agents/tool-scout.md')).toContain('tools: [vault, web]')
    })
  })
})
