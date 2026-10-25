// THE LINK, PROVEN: a click in the roster picker → the exact `--agents` string
// the engine is launched with.
//
// Everything between the checkbox and the native boundary is REAL here: the
// real Agents page, the real RosterPicker over a real agent library, the real
// seat gate, the real `launchTeam` in AppStore. Only `runNativeTeam` — the one
// function that would spawn a process — is captured, so the test can state
// exactly what the engine WOULD have been asked to run.
//
// The roster string this produces is then run against the real engine on this
// machine (see the commit message), which is what closes the loop: the UI emits
// command X, and command X really drives two different AIs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { create as createAgent } from '../lib/agents'
import type { TeamResult } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({ runNativeTeam: vi.fn() }))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => [],
    runNativeTeam: h.runNativeTeam,
    cancelEngineRun: vi.fn(async () => {}),
  }
})

// His two REAL connected providers: the local server, and Claude Code.
const seedProviders = () =>
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        {
          id: 'local',
          name: 'Local model',
          baseUrl: 'http://127.0.0.1:8000',
          apiKey: 'k',
          enabled: true,
          model: 'Qwen3.6-35B',
        },
        { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)', enabled: true, model: 'opus' },
        { id: 'gemini', name: 'Gemini', enabled: false },
      ],
    }),
  )

function renderAgents() {
  const view = render(
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
  // Behind a tab since the crew-first restructure (2026-08-29): this suite
  // drives the launcher, so open its tab first.
  fireEvent.click(screen.getByRole('tab', { name: /team/i }))
  return view
}

/** The agent's row IN THE PICKER (its name also appears on its library tile). */
const seatRow = (name: string): HTMLElement => {
  const rows = Array.from(document.querySelectorAll('.rpick__seat')) as HTMLElement[]
  const row = rows.find((r) => r.querySelector('.rpick__name')?.textContent === name)
  if (!row) throw new Error(`no picker row for ${name} (rows: ${rows.length})`)
  return row
}

/** Tick an agent's box in the picker, exactly as a mouse would. */
const pick = (name: string) => {
  fireEvent.click(seatRow(name).querySelector('input[type="checkbox"]') as HTMLInputElement)
}

const teamResult = (): TeamResult =>
  ({
    passed: true,
    synthesis: 'done',
    board: [],
    tokens: 10,
    tokenBudget: 100_000,
    overBudget: false,
    runId: 'r1',
    boardPath: '/vault/agents/board-r1.jsonl',
    reason: '',
  }) as unknown as TeamResult

describe('the roster picker really launches the engine with the seats you ticked', () => {
  beforeEach(() => {
    localStorage.clear()
    seedProviders()
    // Two of HIS agents, deliberately on DIFFERENT AIs, plus one that cannot run.
    createAgent({ name: 'archivist', role: 'filing', model: 'local', skills: [], assignedTo: '' })
    createAgent({ name: 'auditor', role: 'review', model: 'claude', skills: [], assignedTo: '' })
    createAgent({ name: 'Researcher', role: 'sources', model: 'gemini', skills: [], assignedTo: '' })
    h.runNativeTeam.mockReset()
    h.runNativeTeam.mockResolvedValue(teamResult())
  })
  afterEach(() => localStorage.clear())

  it('two ticks on two DIFFERENT AIs become the engine’s --agents string', async () => {
    renderAgents()

    // The launcher now PRESETS the first three playable library seats (the
    // system crew) so a first visit shows a team that can actually run. This
    // test's proof is picker→engine fidelity, so clear the preset first —
    // every untick below is exercising the same contract.
    pick('Planner')
    pick('Implementer')
    pick('Reviewer / Verifier')
    pick('archivist')
    pick('auditor')

    fireEvent.change(screen.getByPlaceholderText(/task for the team/i), {
      target: { value: 'compare our two AIs on speed and quality' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /launch team/i }))
    })

    expect(h.runNativeTeam).toHaveBeenCalledTimes(1)
    const [intent, vault, , agentsArg] = h.runNativeTeam.mock.calls[0]
    expect(intent).toBe('compare our two AIs on speed and quality')
    expect(vault).toBe('/vault')

    // THE PROOF: the seats he ticked, each bound to its OWN provider token.
    //
    // Note `claude-cli`, not `claude`. The agent's library model is "claude",
    // and `resolveProviderToken` binds it to the half that can REALLY answer —
    // his Claude Code subscription — because the `claude` API provider has no
    // key and is switched off. The picker does not hand the engine a seat that
    // would arrive somewhere unusable.
    expect(agentsArg).toBe('archivist:local,auditor:claude-cli')

    // Two seats, two DIFFERENT AIs — which is the whole point.
    const tokens = String(agentsArg)
      .split(',')
      .map((s: string) => s.split(':')[1])
    expect(new Set(tokens).size).toBe(2)
  })

  it('an agent whose provider is off can NOT be ticked into the run', async () => {
    renderAgents()

    const row = seatRow('Researcher')
    expect((row.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true)
    expect(row.textContent).toMatch(/Gemini is switched off/i)

    pick('archivist')
    fireEvent.change(screen.getByPlaceholderText(/task for the team/i), {
      target: { value: 'anything' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /launch team/i }))
    })
    expect(String(h.runNativeTeam.mock.calls[0][3])).not.toMatch(/researcher/i)
  })

  it('unticking removes that seat from what the engine is asked to run', async () => {
    renderAgents()
    pick('Planner') // clear the preset trio (see above)
    pick('Implementer')
    pick('Reviewer / Verifier')
    pick('archivist')
    pick('auditor')
    pick('archivist') // untick

    fireEvent.change(screen.getByPlaceholderText(/task for the team/i), {
      target: { value: 'solo' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /launch team/i }))
    })
    expect(h.runNativeTeam.mock.calls[0][3]).toBe('auditor:claude-cli')
  })
})
