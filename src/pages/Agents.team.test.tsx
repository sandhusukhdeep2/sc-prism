// Mission-control adversarial audit (2026-08-06), H5 + M5 — the Agents page's
// team launcher.
//
// It ran a bare `Promise.race` against 300s with NO run id: a slow team run was
// abandoned with its engine child still alive, and because every run appends to
// the ONE spans.jsonl, that draining subprocess's spans became whatever run
// registered next — a card narrating a dead run's work. It also bypassed the
// app's one-engine-at-a-time busy protocol entirely (the spec bullet the
// builder skipped), so it could start on top of the manager driver.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { TeamResult } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({
  runNativeTeam: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
}))

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
    cancelEngineRun: h.cancelEngineRun,
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderAgents() {
  const view = render(
    <MemoryRouter initialEntries={['/agents']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Agents />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
  // The launcher lives behind the Team tab since the crew-first restructure
  // (2026-08-29) — every test here drives the launcher, so open its tab.
  fireEvent.click(screen.getByRole('tab', { name: /team/i }))
  return view
}

const teamResult = (passed: boolean): TeamResult =>
  ({
    run_id: 'r1',
    board: [{ from: 'lead', provider: 'claude', is_real: true, text: 'done' }],
    synthesis: 'here is the plan',
    board_path: '/vault/boards/r1.md',
    tokens: 120,
    passed,
    overBudget: false,
    tokenBudget: 100000,
    reason: passed ? '' : 'the critic rejected it',
    taskId: 'r1',
    spansPath: '/vault/spans.jsonl',
    verdictPath: '/vault/verdicts/r1.json',
  }) as unknown as TeamResult

/** Type a task into the launcher and press Launch. */
async function launch(task = 'plan the SOC 2 dashboard') {
  const intent = screen.getByPlaceholderText(/task for the team/i)
  fireEvent.change(intent, { target: { value: task } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /launch team/i }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('TeamLauncher — a timeout really cancels the engine child (H5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('passes a real run id to the engine and kills that run when it times out', async () => {
    h.runNativeTeam.mockImplementation(() => new Promise(() => {})) // never settles
    renderAgents()
    await launch()

    // The launch carries a cancellation handle (7th arg) — without one the
    // Rust bridge retains no child and a cancel could never land.
    const runId = h.runNativeTeam.mock.calls[0][6]
    expect(typeof runId).toBe('string')
    expect(runId).toMatch(/^run-/)
    // ...and the card is registered under that same id.
    expect(captured.app!.state.liveRuns).toHaveLength(1)
    expect(captured.app!.state.liveRuns[0].id).toBe(runId)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_001)
    })

    expect(h.cancelEngineRun).toHaveBeenCalledWith(runId)
    // Honest outcome: stopped (unknown), never dressed up as a fail or a pass.
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns[0]).toMatchObject({ kind: 'team', outcome: 'stopped' })
    expect(screen.getByText(/we stopped the team run at 5 minutes/i)).toBeInTheDocument()
  })

  it('does NOT cancel when the run finishes normally (M5 — no regression)', async () => {
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderAgents()
    await launch()

    expect(h.cancelEngineRun).not.toHaveBeenCalled()
    expect(screen.getByText(/✓ PASSED/)).toBeInTheDocument()
    expect(screen.getByText('here is the plan')).toBeInTheDocument()
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns[0]).toMatchObject({ kind: 'team', outcome: 'passed' })
  })
})

describe('TeamLauncher — the busy protocol (H5, spec §Part 2)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('refuses honestly while another engine run is in progress — and starts nothing', async () => {
    const project = addProject('Dashboard', 'ship it', 'npm test')
    updateProject(project.id, { status: 'running' })
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderAgents()
    await launch()

    expect(screen.getByText(/Another run is in progress/i)).toBeInTheDocument()
    // The refusal is real: no engine call, and no card that would claim one.
    expect(h.runNativeTeam).not.toHaveBeenCalled()
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns).toHaveLength(0)
  })

  it('holds the engine slot for the duration, then releases it (M5)', async () => {
    h.runNativeTeam.mockResolvedValue(teamResult(false))
    renderAgents()
    await settleSlot()

    // Free before…
    expect(captured.app!.claimEngine()).toBe(true)
    captured.app!.releaseEngine()

    await launch()
    // …and free again after, so the next launch is not wrongly refused.
    expect(h.runNativeTeam).toHaveBeenCalledTimes(1)
    expect(captured.app!.claimEngine()).toBe(true)
    captured.app!.releaseEngine()
  })
})

/** Let the providers mount before poking the store handle. */
async function settleSlot() {
  await act(async () => {
    await Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// The provider gate (2026-08-12) — the launcher's half of it.
//
// A live run put three agents on the board: claude-cli, local, and gemini-cli —
// the last one `is_real: false`, 13 tokens, an HOUR after that provider was
// switched off in Settings. The seat was given because the agent was enabled;
// nobody checked whether its provider could answer. These pin that a seat on a
// disconnected provider is dropped, that the drop is SAID OUT LOUD, and that a
// roster with nothing left refuses instead of running a one-stub "team".
// ---------------------------------------------------------------------------

/** Replace the roster input's contents (the launcher's `name:provider` field). */
function setRoster(value: string) {
  fireEvent.change(screen.getByLabelText(/team roster/i), { target: { value } })
}

/** The launcher panel alone — the agent CARDS below it carry their own
 *  "sits out" lines (the other half of this fix), so queries are scoped. */
function panel() {
  return within(document.querySelector('.team') as HTMLElement)
}

/** The PREFLIGHT line specifically — "who sits out if you launch this roster
 *  right now". Since 2026-08-19 the roster PICKER sits in the same panel and
 *  names each library agent's own sit-out reason beside it, so a query scoped
 *  only to `.team` now legitimately matches twice. These assertions are about
 *  the preflight line, so they say so. */
function preflight() {
  const el = document.querySelector('.team__sitout') as HTMLElement | null
  return el ? within(el) : null
}

describe('TeamLauncher — an agent on a provider that is not connected', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('says who is REASSIGNED, and why, BEFORE the launch', async () => {
    // The 2026-08-29 rule: a seat no longer dies with its brand — it moves to
    // a provider that can answer, and the move is said out loud up front.
    renderAgents()
    await settleSlot()
    act(() => setRoster('lead:local,critic:gemini-cli'))

    expect(preflight()!.getByText(/critic reassigned/i)).toBeInTheDocument()
    expect(preflight()!.getByText(/switched off in Settings/i)).toBeInTheDocument()
  })

  it('the Agents cards say it too — an agent on a dead provider is marked there', async () => {
    renderAgents()
    await settleSlot()
    // The seeded library has agents on gemini, and gemini is not connected here.
    // This one test reads the CREW cards, not the launcher — go back.
    fireEvent.click(screen.getByRole('tab', { name: /crew/i }))
    const tile = document.querySelector('.agent-tile__sitout')
    expect(tile).not.toBeNull()
    expect(tile!.textContent).toMatch(/sits out: (Claude|Gemini)/i)
  })

  it('the roster the engine receives carries the REASSIGNED seat, never the dead one', async () => {
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderAgents()
    await settleSlot()
    act(() => setRoster('lead:local,critic:gemini-cli'))
    await launch()

    expect(h.runNativeTeam).toHaveBeenCalledTimes(1)
    // 4th arg is the roster string: the critic keeps a seat on a provider
    // that can actually answer, and never on the dead one.
    const sent = String(h.runNativeTeam.mock.calls[0][3])
    expect(sent).toContain('lead:local')
    expect(sent).toMatch(/critic:(?!gemini)/)
    // (The up-front announcement is covered by the BEFORE-the-launch test;
    // after a result lands the preflight block yields to the result card.)
  })

  it('leaves a fully connected roster BYTE-IDENTICAL', async () => {
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderAgents()
    await settleSlot()
    act(() => setRoster('lead:local,researcher:local'))
    await launch()

    expect(h.runNativeTeam.mock.calls[0][3]).toBe('lead:local,researcher:local')
    // Nothing to warn about: the preflight line does not render at all.
    expect(preflight()).toBeNull()
  })

  it('REFUSES honestly when NOTHING can answer — no fallback, nothing runs', async () => {
    // Reassignment needs somewhere to go: with every provider off, the seat
    // still sits out and the refusal is unchanged.
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        providers: [
          { id: 'local', name: 'Local model', baseUrl: '', apiKey: '', enabled: false, primary: false, model: '' },
          { id: 'claude', name: 'Claude', baseUrl: '', apiKey: '', enabled: false, primary: false, model: '' },
          { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)', baseUrl: '', apiKey: '', enabled: false, primary: false, model: '' },
          { id: 'gemini', name: 'Gemini', baseUrl: '', apiKey: '', enabled: false, primary: false, model: '' },
        ],
      }),
    )
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderAgents()
    await settleSlot()
    act(() => setRoster('critic:gemini-cli'))
    await launch()

    expect(panel().getByText(/No agent could run/i)).toBeInTheDocument()
    // A refusal is not a failure: no engine call, no card, no result.
    expect(h.runNativeTeam).not.toHaveBeenCalled()
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns).toHaveLength(0)
    expect(panel().queryByText(/Team run failed/i)).not.toBeInTheDocument()
  })
})
