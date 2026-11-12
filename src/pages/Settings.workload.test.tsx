import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import { list as listAgents } from '../lib/agents'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// ONE control for the dependency (2026-11-12). The owner had asked for this
// three times — a dial for chat sends (08-29), buttons that rewrote every
// agent's model (08-31, 09-03) — and still described something else: who
// plans, who does the work, who checks. The workload slider is that control,
// and the two it replaces are gone rather than left beside it.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const STORE = 'scprism.settings'
const stored = () => JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>

function seed() {
  localStorage.setItem(
    STORE,
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, connected: true },
      ],
    }),
  )
}

describe('Settings — one workload slider, in place of the dial and the crew buttons', () => {
  beforeEach(() => {
    localStorage.clear()
    seed()
  })
  afterEach(() => localStorage.clear())

  it('shows the workload slider', () => {
    renderSettings()
    expect(screen.getByRole('slider', { name: /workload/i })).toBeInTheDocument()
  })

  it('the old dial and the crew-move buttons are gone', () => {
    renderSettings()
    expect(screen.queryByRole('slider', { name: /dependency dial/i })).toBeNull()
    expect(screen.queryByText('Move the whole crew')).toBeNull()
  })

  it('moving the slider re-seats a run — it does NOT rewrite the agents', () => {
    renderSettings()
    const before = listAgents().map((a) => `${a.id}:${a.model}`)
    fireEvent.change(screen.getByRole('slider', { name: /workload/i }), { target: { value: '3' } })
    expect(stored().workload).toBe('local-all')
    // The agents keep the AI set on them: the slider is an overlay, and
    // switching it off gives every seat back exactly as it was.
    expect(listAgents().map((a) => `${a.id}:${a.model}`)).toEqual(before)
  })

  it('the per-AI seat count follows the slider', () => {
    renderSettings()
    const crew = listAgents().filter((a) => a.enabled)
    const system = (a: (typeof crew)[number]) => (a.assignedTo ?? '') === 'system'
    // Switched off: every seat counts where its own file says.
    fireEvent.click(screen.getByRole('button', { name: 'Each agent’s own AI' }))
    const onClaude = crew.filter((a) => a.model === 'claude').length
    expect(onClaude).toBeGreaterThan(0)
    // (two AIs can hold the same number of seats, so more than one row may say it)
    expect(screen.getAllByText(`${onClaude} of ${crew.length} seats`).length).toBeGreaterThan(0)
    // All local: every system seat is counted on the local model instead.
    fireEvent.change(screen.getByRole('slider', { name: /workload/i }), { target: { value: '3' } })
    const stillClaude = crew.filter((a) => a.model === 'claude' && !system(a)).length
    const nowLocal = crew.filter((a) => system(a) || a.model === 'local').length
    expect(nowLocal).toBeGreaterThan(crew.filter((a) => a.model === 'local').length)
    expect(screen.getAllByText(`${nowLocal} of ${crew.length} seats`).length).toBeGreaterThan(0)
    expect(screen.getAllByText(`${stillClaude} of ${crew.length} seats`).length).toBeGreaterThan(0)
  })
})
