// The v2 Work board, end to end through the REAL store (visual system v2 spec,
// 2026-08-18). CrewBoard.test.tsx proves the component obeys the honesty rules
// when it is handed spans; this proves the PAGE hands it the right ones —
// which is where rules 1 and 6 are actually won or lost.
//
//   rule 1  a monogram pulses only while the run is genuinely EXECUTING: the
//           page passes `activeRuns(...)`, so parking a run stops the glow.
//   rule 3  no crew → no pipeline anywhere on the page.
//   rule 6  with 2+ runs in flight `currentRunSpans` returns [], so no crew of
//           one run can ever appear under another.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { removeProject, getProjects } from '../lib/projects'
import type { EngineSpan } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({ readSpansTail: vi.fn(async () => [] as EngineSpan[]) }))

// Native (the board/console only render there). `storeGet` stays PENDING so
// SettingsProvider never hydrates and the connectivity cold-probe never runs —
// the same isolation Workspace.liveSignals.test.tsx uses.
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readSpansTail: h.readSpansTail,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
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

/** Queries scoped to the board — the live cards and the engine console name the
 *  same agents/models elsewhere on the page, and those are not what is under
 *  test here. */
const board = () => within(document.querySelector('.crew') as HTMLElement)

async function mounted() {
  const view = renderWorkspace()
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

/** A four-agent board, all spans starting AFTER the run registers. */
function crewSpans(base: number): EngineSpan[] {
  const at = (ms: number) => (base + ms) / 1000
  return [
    // Planning: the manager split the work and closed its turn.
    {
      name: 'model_call', type: 'model_call', status: 'ok', start: at(1_000),
      attrs: { agent: 'Sukh', provider: 'claude-cli', model: 'opus', round: '1', is_real: true, tokens_out: 210 },
    },
    // Researching, on the local model — still open.
    {
      name: 'model_call', type: 'model_call', status: 'running', start: at(2_000),
      attrs: { agent: 'researcher', provider: 'local', model: 'Qwen3.6-35B', round: '1' },
    },
    // Drafting, on Claude — still open.
    {
      name: 'model_call', type: 'model_call', status: 'running', start: at(3_000),
      attrs: { agent: 'writer', provider: 'claude-cli', model: 'opus', round: '1' },
    },
    // Pulling the board together — a real synthesis round, still open.
    {
      name: 'model_call', type: 'model_call', status: 'running', start: at(4_000),
      attrs: { agent: 'reviewer', provider: 'gemini', model: 'gemini-2.0', round: 'synthesis' },
    },
    // A real vault read — this is what earns the 🔒 badge.
    {
      name: 'tool_exec', type: 'tool_exec', status: 'ok', start: at(2_500),
      attrs: { provider: 'vault', tool: 'vault_read', path: 'notes/positioning.md' },
    },
  ]
}

describe('Work page — the v2 board', () => {
  beforeEach(() => {
    localStorage.clear()
    h.readSpansTail.mockReset()
    h.readSpansTail.mockResolvedValue([])
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  // rule 3 — quiet means quiet.
  it('QUIET: no crew, so no pipeline, no crew cluster and no lock badge', async () => {
    await mounted()
    expect(document.querySelector('.crew')).toBeNull()
    expect(document.querySelector('.crew__cols')).toBeNull()
    expect(document.querySelector('.crew__lock')).toBeNull()
    // …but the measured ledger is there, saying it has nothing yet.
    expect(screen.getByText(/no runs yet — your first run's story lands here/)).toBeInTheDocument()
    expect(screen.queryByText('no runs recorded this week yet')).not.toBeInTheDocument()
  })

  it('LIVE, four agents: a pipeline of real stages, each naming its own model', async () => {
    const base = Date.now()
    h.readSpansTail.mockResolvedValue(crewSpans(base))
    await mounted()
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'team', intent: 'positioning note' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The crew cluster: one seat per agent that really has a model_call span.
    expect(document.querySelectorAll('.crew__cluster .crew__mono')).toHaveLength(4)
    // The columns are the rounds the ENGINE reported, not phases we named.
    expect(board().getByText('Round 1')).toBeInTheDocument()
    expect(board().getByText('Pulling together')).toBeInTheDocument()
    // Each coworker names the AI that really answered.
    expect(board().getByText('local · Qwen3.6-35B')).toBeInTheDocument()
    expect(board().getAllByText('claude-cli · opus').length).toBeGreaterThan(0)
    expect(board().getByText('gemini · gemini-2.0')).toBeInTheDocument()
    // rule 5 — the count is the real state of those spans.
    expect(board().getByText('3 working · 1 answered')).toBeInTheDocument()
    // rule 4 — a vault read really happened, so the badge is earned.
    expect(board().getByText(/read 1 vault note — stayed on this Mac/)).toBeInTheDocument()
    // rule 1 — the three OPEN spans pulse; the closed one does not.
    expect(document.querySelectorAll('.crew__cols .crew__mono--pulse')).toHaveLength(3)
  })

  // rule 1 — the park (the regression fixed in 16182f2, restated for the board).
  it('PARKED: the board stops glowing entirely, and says what it is waiting for', async () => {
    const base = Date.now()
    h.readSpansTail.mockResolvedValue(crewSpans(base))
    await mounted()
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'project', intent: 'build the dashboard' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelectorAll('.crew__mono--pulse').length).toBeGreaterThan(0)

    await act(async () => {
      captured.app!.pauseLiveRun(id, true)
    })

    // Not one monogram glows, and no progress line claims movement…
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
    expect(document.querySelector('.crew__bar')).toBeNull()
    // …while the real reason it stopped is stated in the black "Your call" card.
    expect(board().getByText('Your call')).toBeInTheDocument()
    expect(board().getByText('Waiting on your answer')).toBeInTheDocument()
    expect(board().getByText('build the dashboard')).toBeInTheDocument()

    // Answered: live again.
    await act(async () => {
      captured.app!.pauseLiveRun(id, false)
    })
    expect(document.querySelectorAll('.crew__mono--pulse').length).toBeGreaterThan(0)
  })

  // rule 6 — two runs in flight.
  it('2+ RUNS: no crew is attributed to either run — the board draws no pipeline', async () => {
    const base = Date.now()
    h.readSpansTail.mockResolvedValue(crewSpans(base))
    await mounted()
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'chat', intent: 'ask one' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(board().getByText('researcher')).toBeInTheDocument()

    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'team', intent: 'ask two' })
    })

    // Every span in the file could belong to either run, so NONE is claimed:
    // no columns, no crew cluster, no lock badge, no counts.
    expect(document.querySelector('.crew')).toBeNull()
    expect(document.querySelector('.crew__cols')).toBeNull()
    expect(screen.queryByText('researcher')).not.toBeInTheDocument()
    expect(screen.queryByText('local · Qwen3.6-35B')).not.toBeInTheDocument()
    expect(document.querySelector('.crew__lock')).toBeNull()
    expect(screen.queryByText(/\d+ working/)).not.toBeInTheDocument()
  })
})
