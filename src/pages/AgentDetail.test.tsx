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
import { create as createAgent, agentSlug, list as listAgents, update as updateAgent } from '../lib/agents'
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
    readSpansTail: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
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

  // A proof is a fact about ONE identity: "this charter, on this model, with
  // these tools answered and used its tools". Edit any of those and the fact
  // no longer describes the seat — so the chip goes back to "not yet proven"
  // instead of wearing a date earned by a different agent.
  it('editing the charter clears a stale proof, in the store and in the file', async () => {
    const a = createAgent({ name: 'proof-scout', role: 'r', model: 'local' })
    updateAgent(a.id, { proof: { at: Date.UTC(2026, 10, 8), proven: true, reason: '' } })
    renderAt(`/agents/${agentSlug(a.name)}`)
    fireEvent.change(screen.getByLabelText(/charter/i), { target: { value: 'A different job entirely.' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(native.files.get('agents/proof-scout.md')).toContain('A different job entirely.'))
    expect(listAgents().find((x) => x.id === a.id)?.proof).toBeUndefined()
    expect(native.files.get('agents/proof-scout.md')).not.toContain('proven_at:')
  })

  it('editing only the role keeps the proof — the identity it vouches for is unchanged', async () => {
    const a = createAgent({ name: 'proof-keeper', role: 'r', model: 'local' })
    updateAgent(a.id, { proof: { at: Date.UTC(2026, 10, 8), proven: true, reason: '' } })
    renderAt(`/agents/${agentSlug(a.name)}`)
    fireEvent.change(screen.getByLabelText(/what this coworker is for/i), { target: { value: 'a clearer one-liner' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(native.files.get('agents/proof-keeper.md')).toContain('a clearer one-liner'))
    expect(listAgents().find((x) => x.id === a.id)?.proof?.proven).toBe(true)
    expect(native.files.get('agents/proof-keeper.md')).toContain('proven_at:')
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

// THE AGENT'S OWN RECORD on its page (2026-11-11). The header said "73 runs on
// local · last failed" — a model-wide number — while its card on the crew page
// said "90 turns · last answered"; and the page showed nothing of what the
// agent had actually done. Both now read the agent's own spans.
describe('the agent page shows the agent’s own record', () => {
  beforeEach(() => {
    native.files.clear()
    native.readSpansTail.mockReset()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it('lists its latest turns and tools, and the header speaks for its own work', async () => {
    const a = createAgent({ name: 'record-scout', role: 'r', model: 'local' })
    native.readSpansTail.mockResolvedValue([
      { name: 'model_call', type: 'model_call', status: 'ok', start: 1, duration_ms: 2100, span_id: 's1', attrs: { agent: 'record-scout', round: 'proof', provider: 'local', model: 'gemma', is_local: true, is_real: true, tokens_in: 1911, tokens_out: 42 } },
      { name: 'tool_exec', type: 'tool_exec', status: 'ok', start: 2, span_id: 's2', attrs: { agent: 'record-scout', round: 'proof', tool: 'vault_list', server: 'vault' } },
    ])
    renderAt(`/agents/${agentSlug(a.name)}`)
    const card = await screen.findByRole('region', { name: /its record/i })
    await waitFor(() => expect(card.textContent).toContain('proof'))
    expect(card.textContent).toContain('local · gemma')
    expect(card.textContent).toMatch(/1,911\s*→\s*42/)
    expect(card.textContent).toContain('answered')
    expect(card.textContent).toMatch(/vault_list/)
    // The header's line is the same one its card on the crew page shows.
    expect(document.querySelector('.adetail__meta')!.textContent).toContain('1 turn · last answered · 1,953 tokens · 1 tool call · all on your Mac')
    expect(native.readSpansTail).toHaveBeenCalledWith('/vault', 4000)
  })

  it('a board round reads as "round 1" and every turn says when it happened', async () => {
    const a = createAgent({ name: 'record-rounds', role: 'r', model: 'local' })
    const at = Date.UTC(2026, 10, 9, 5, 0, 0) / 1000
    native.readSpansTail.mockResolvedValue([
      { name: 'model_call', type: 'model_call', status: 'ok', start: at, duration_ms: 5800, span_id: 'r1', attrs: { agent: 'record-rounds', round: 1, provider: 'local', model: 'gemma', is_local: true, is_real: true, tokens_in: 1007, tokens_out: 181 } },
    ])
    renderAt(`/agents/${agentSlug(a.name)}`)
    const card = await screen.findByRole('region', { name: /its record/i })
    await waitFor(() => expect(card.textContent).toContain('round 1'))
    expect(card.querySelector('.adetail__turnwhen')!.textContent).toMatch(/Nov/)
  })

  it('says so plainly when the log holds nothing of its own', async () => {
    const a = createAgent({ name: 'record-empty', role: 'r', model: 'local' })
    native.readSpansTail.mockResolvedValue([])
    renderAt(`/agents/${agentSlug(a.name)}`)
    const card = await screen.findByRole('region', { name: /its record/i })
    expect(card.textContent).toMatch(/no turns of its own in the recent log/i)
  })
})
