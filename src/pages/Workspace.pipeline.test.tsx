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
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
// WHERE THE CREW IS DRAWN (2026-11-14, "Visible agents"). Each seat is drawn
// ONCE, on the room's Team board above the chat — which also holds the seats
// of the room's team that have NOT been called (idle, claiming nothing). The
// step board — the rounds the engine reported, the count, the lock, anything
// parked on the user — is the Steps tab beside the chat, opened on request.
// Every honesty rule these tests hold is unchanged; only the surface moved.
const strip = () => within(document.querySelector('.ws__chatcol .board') as HTMLElement)
/** The seats that have really taken a turn (a span says so). */
const seats = () => document.querySelectorAll('.ws__chatcol .board__seat:not(.is-idle)')
const working = () => document.querySelectorAll('.ws__chatcol .board__seat.is-running')
/** Open the Steps tab (if it is not already) and scope to its board. */
const board = () => {
  const open = screen.queryByRole('button', { name: 'Steps' })
  if (open) fireEvent.click(open)
  return within(document.querySelector('.pane .crew') as HTMLElement)
}

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
    // The room's team is on its board, and not one seat claims a turn.
    expect(document.querySelector('.ws__chatcol .board')).not.toBeNull()
    expect(seats()).toHaveLength(0)
    expect(working()).toHaveLength(0)
    expect(screen.queryByText(/\d+ working/)).not.toBeInTheDocument()
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

    // One seat per agent that really has a model_call span — drawn ONCE, on
    // the Team board (the step board beside the chat draws none).
    expect(seats()).toHaveLength(4)
    // Each coworker names the AI that really answered.
    expect(strip().getAllByTitle(/local · Qwen3\.6-35B/).length).toBeGreaterThan(0)
    expect(strip().getAllByTitle(/claude-cli · opus/).length).toBeGreaterThan(0)
    expect(strip().getAllByTitle(/gemini · gemini-2\.0/).length).toBeGreaterThan(0)
    // The board is not on screen until asked for.
    expect(document.querySelector('.crew')).toBeNull()
    // The columns are the rounds the ENGINE reported, not phases we named.
    expect(board().getByText('Round 1')).toBeInTheDocument()
    expect(board().getByText('Pulling together')).toBeInTheDocument()
    expect(document.querySelectorAll('.crew__cluster .crew__mono')).toHaveLength(0)
    // rule 5 — the count is the real state of those spans.
    expect(board().getByText('3 working · 1 answered')).toBeInTheDocument()
    // rule 4 — a vault read really happened, so the badge is earned.
    // The per-seat work line left the board with the rows; the dossier and the chat carry it.
    // rule 1 — the three OPEN spans pulse; the closed one does not.
    // Each seat is drawn once (clear-room 2026-11-09 §A3): the live coworkers breathe on their SEATS.
    expect(working()).toHaveLength(3)
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
    expect(working().length).toBeGreaterThan(0)

    await act(async () => {
      captured.app!.pauseLiveRun(id, true)
    })

    // Not one seat breathes, nothing travels a link, and no progress line
    // claims movement…
    expect(document.querySelector('.board__seat.is-running')).toBeNull()
    expect(document.querySelector('.board__packet')).toBeNull()
    expect(strip().getByText('waiting on you')).toBeInTheDocument()
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
    expect(document.querySelector('.crew__bar')).toBeNull()
    // …while the real reason it stopped is stated in the black "Your call" card.
    expect(board().getByText('Your call')).toBeInTheDocument()
    expect(board().getByText('Waiting on your answer')).toBeInTheDocument()
    // A parked run is not "the last run": nothing captions it as finished.
    expect(screen.queryByText(/nothing is running now/)).toBeNull()
    expect(strip().getByText('build the dashboard')).toBeInTheDocument()

    // Answered: live again.
    await act(async () => {
      captured.app!.pauseLiveRun(id, false)
    })
    expect(working().length).toBeGreaterThan(0)
  })

  // rule 6 — two runs in flight.
  it('2+ RUNS: no crew is attributed to either run — the board draws no pipeline', async () => {
    const base = Date.now()
    h.readSpansTail.mockResolvedValue(crewSpans(base))
    await mounted()
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'manager', intent: 'ask one' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    // One run: its seats are lit on the board.
    expect(strip().getByRole('button', { name: 'What Researcher is doing' })).not.toHaveClass('is-idle')
    expect(seats().length).toBeGreaterThan(0)

    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'team', intent: 'ask two' })
    })

    // Every span in the file could belong to either run, so NONE is claimed:
    // no seats, no columns, no crew cluster, no lock badge, no counts — each
    // run still has its own line and clock.
    expect(document.querySelectorAll('.board__run')).toHaveLength(2)
    expect(seats()).toHaveLength(0)
    expect(working()).toHaveLength(0)
    expect(strip().getByRole('button', { name: 'What Researcher is doing' })).toHaveClass('is-idle')
    expect(document.querySelector('.crew')).toBeNull()
    expect(document.querySelector('.crew__cols')).toBeNull()
    expect(document.querySelector('.board__state')).toBeNull()
    expect(screen.queryByText('local · Qwen3.6-35B')).not.toBeInTheDocument()
    expect(document.querySelector('.crew__lock')).toBeNull()
    expect(screen.queryByText(/\d+ working/)).not.toBeInTheDocument()
  })
})
