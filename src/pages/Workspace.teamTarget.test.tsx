// Mission Control §Give a task from Work (2026-08-06) — a team launched FROM
// the Work composer, end to end through the REAL store.
//
// The point of the feature is that the user's task is visible where he gave it:
// "I supposed to give a task in a work page where I see the progress, which AI
// doing the what". So a team launched here must be the SAME governed launch the
// Agents page performs — the one `launchTeam` in the store — with all of its
// discipline intact:
//
//   * ONE run id, passed to the engine so a timeout can really kill the child;
//   * the shared engine slot claimed for the duration and released after;
//   * a live run registered under kind 'team' (that is what lights the cards,
//     the narration and the console) and ALWAYS cleared — on success AND on
//     timeout;
//   * a busy slot refused IN THE CHAT, with nothing started and nothing
//     registered — never queued behind the user's back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, TEAM_BUSY_TEXT, TEAM_TIMEOUT_TEXT, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'

// The composer's target + route pills now live behind a "Change" disclosure:
// the DEFAULT is stated in words beside the send button ("Sukh takes this"),
// and the seven pills that used to shout from the composer open deliberately.
// Nothing about the controls changed — same options, same aria-labels, same
// per-message reset — so opening the panel is plumbing, not the thing under
// test, and this helper does it on demand and only once.
function openComposerControls() {
  if (screen.queryAllByRole('radio').length > 0) return
  const change = screen.queryByRole('button', { name: /Change who takes this/i })
  if (change) fireEvent.click(change)
}
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
    // The image-attach path, so the "a team run takes text only" rule can be
    // exercised for real rather than described.
    pickFile: async () => '/photos/uploader.png',
    readImageBase64: async () => 'data:image/png;base64,AAAA',
    runNativeTeam: h.runNativeTeam,
    cancelEngineRun: h.cancelEngineRun,
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

const teamResult = (passed: boolean): TeamResult =>
  ({
    run_id: 'r1',
    board: [{ from: 'lead', provider: 'local', is_real: true, content: 'done' }],
    synthesis: 'here is the plan the team agreed on',
    board_path: '/vault/agents/board-r1.jsonl',
    tokens: 120,
    passed,
    overBudget: false,
    tokenBudget: 100000,
    reason: passed ? '' : 'the critic rejected it',
    taskId: 'r1',
    spansPath: '/vault/spans.jsonl',
    verdictPath: '/vault/verdicts/r1.json',
  }) as unknown as TeamResult

/** Pick the team target, type a task, press Send, let the flow settle. */
async function giveTeamATask(task = 'plan the SOC 2 compliance dashboard') {
  openComposerControls()
  fireEvent.click(screen.getByRole('radio', { name: /^team$/i }))
  const field = screen.getByRole('textbox', { name: /describe/i })
  fireEvent.change(field, { target: { value: task } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Work composer → team: the SHARED governed launch', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('runs the engine with a real run id + the chosen roles, holds the engine slot, and reports the real outcome', async () => {
    // A launch that does not settle until we say so, so the mid-run state (slot
    // held, card live) is observable rather than inferred.
    let finish: (r: TeamResult) => void = () => {}
    h.runNativeTeam.mockImplementation(() => new Promise<TeamResult>((res) => { finish = res }))
    renderWorkspace()
    await giveTeamATask()

    // The engine got the task, the roles the composer showed, and a run id (7th
    // arg) — the cancellation handle without which a timeout could kill nothing.
    expect(h.runNativeTeam).toHaveBeenCalledTimes(1)
    const call = h.runNativeTeam.mock.calls[0]
    expect(call[0]).toBe('plan the SOC 2 compliance dashboard')
    expect(call[1]).toBe('/vault')
    // The roles the composer showed — and ONLY providers that are really
    // connected. The seeded settings have gemini off and keyless, so the
    // critic seat it used to be given is not offered (it could only stub).
    expect(call[3]).toBe('lead:local,researcher:local')
    expect(call[5]).toBe(100_000)
    const runId = call[6]
    expect(runId).toMatch(/^run-/)

    // MID-RUN: the live run is registered under that same id and kind 'team'
    // (this is what makes the card/narration/console light up on Work), and the
    // app's one engine slot is genuinely held.
    expect(captured.app!.state.liveRuns).toHaveLength(1)
    expect(captured.app!.state.liveRuns[0]).toMatchObject({ id: runId, kind: 'team' })
    // The card lists the seats the run REALLY has — the filtered roster, not
    // the ask, so a card can't show a model that was never going to speak.
    expect(captured.app!.state.liveRuns[0].models).toEqual(['lead:local', 'researcher:local'])
    expect(captured.app!.claimEngine()).toBe(false)
    // The ask is in the transcript, addressed to the team.
    expect(screen.getByText('→ team: plan the SOC 2 compliance dashboard')).toBeInTheDocument()

    await act(async () => {
      finish(teamResult(true))
      await Promise.resolve()
      await Promise.resolve()
    })

    // Cleared, released, and reported with the run's REAL numbers + board path.
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns[0]).toMatchObject({ kind: 'team', outcome: 'passed' })
    expect(captured.app!.claimEngine()).toBe(true)
    captured.app!.releaseEngine()
    expect(
      screen.getByText('team run passed · 120/100,000 tok · board saved: /vault/agents/board-r1.jsonl'),
    ).toBeInTheDocument()
    expect(screen.getByText('here is the plan the team agreed on')).toBeInTheDocument()
    expect(h.cancelEngineRun).not.toHaveBeenCalled()
  })

  it('a TIMEOUT kills the engine child, clears the card and says so in the chat', async () => {
    vi.useFakeTimers()
    try {
      h.runNativeTeam.mockImplementation(() => new Promise(() => {})) // never settles
      renderWorkspace()
      await giveTeamATask()

      const runId = h.runNativeTeam.mock.calls[0][6]
      expect(captured.app!.state.liveRuns).toHaveLength(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_001)
      })

      // The abandoned child is really killed (a draining engine keeps appending
      // to the ONE spans.jsonl and would be attributed to the next run).
      expect(h.cancelEngineRun).toHaveBeenCalledWith(runId)
      // Nothing keeps glowing, the outcome is the honest 'stopped' (not a fail,
      // not a pass), the slot is free again, and the chat says what happened.
      expect(captured.app!.state.liveRuns).toHaveLength(0)
      expect(captured.app!.state.finishedRuns[0]).toMatchObject({ kind: 'team', outcome: 'stopped' })
      expect(captured.app!.claimEngine()).toBe(true)
      captured.app!.releaseEngine()
      expect(screen.getByText(TEAM_TIMEOUT_TEXT)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an attached image is never claimed to have been sent (a team run takes text only)', async () => {
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderWorkspace()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach an image' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('uploader.png')).toBeInTheDocument()

    // Picking the team says so BEFORE the send, while the image can still be
    // removed or the target changed.
    openComposerControls()
  fireEvent.click(screen.getByRole('radio', { name: /^team$/i }))
    expect(screen.getByText(/a team run takes text only/i)).toBeInTheDocument()

    await giveTeamATask('plan the dashboard')

    // The ask that went out carries NO image marker — the bubble shows only
    // what the team actually received…
    expect(screen.getByText('→ team: plan the dashboard')).toBeInTheDocument()
    // …and the chat says plainly where the image went: nowhere.
    expect(
      screen.getByText('the attached image was not sent (a team run takes text only)'),
    ).toBeInTheDocument()
    expect(h.runNativeTeam.mock.calls[0][0]).toBe('plan the dashboard')
  })

  it('a BUSY engine is refused in the chat: nothing starts and nothing is registered', async () => {
    const project = addProject('Dashboard', 'ship it', 'npm test')
    updateProject(project.id, { status: 'running' })
    h.runNativeTeam.mockResolvedValue(teamResult(true))
    renderWorkspace()
    await giveTeamATask()

    // The honest refusal, in the SAME words the Agents page uses.
    expect(screen.getByText(TEAM_BUSY_TEXT)).toBeInTheDocument()
    // And it is a real refusal: no engine call, no live run, no finished run —
    // nothing queued silently behind the user's back.
    expect(h.runNativeTeam).not.toHaveBeenCalled()
    expect(captured.app!.state.liveRuns).toHaveLength(0)
    expect(captured.app!.state.finishedRuns).toHaveLength(0)
  })
})
