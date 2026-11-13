// THE CHAT IS THE ROOM (spec 2026-11-14). The owner, of the Stage: "very
// complicated… repetitive information is a lot" — and of the animation in it:
// "that I like". So there is no Stage any more. While this room's run is
// working, one slim strip above the chat says what is running, draws the
// seats with the handoff in flight, and says who is speaking — once each. The
// engine's steps open beside the chat on request; nothing opens by itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { EngineSpan, TeamResult } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({
  runNativeTeam: vi.fn(),
  spans: [] as unknown[],
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => h.spans as EngineSpan[],
    runNativeTeam: h.runNativeTeam,
    cancelEngineRun: async () => {},
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

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('Work — one strip above the chat, and no Stage', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const p of getProjects().projects) removeProject(p.id)
    h.runNativeTeam.mockReset()
    h.spans = []
  })
  afterEach(() => localStorage.clear())

  it('with nothing running there is no strip and no Stage — the chat is the room', async () => {
    renderWorkspace()
    await settle()
    expect(document.querySelector('.strip')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Stage' })).not.toBeInTheDocument()
  })

  it('a live team run is drawn in the strip, and each fact about it is said once', async () => {
    let finish: (r: TeamResult) => void = () => {}
    h.runNativeTeam.mockImplementation((...args: unknown[]) => {
      const runId = String(args[6])
      // Spans carry the engine's clock in SECONDS; the page keeps the ones
      // that started after the live run did.
      const t = Date.now() / 1000
      h.spans = [
        { span_id: 'a', run_id: runId, type: 'model_call', name: 'model_call', start: t + 1, end: t + 2, status: 'ok', attrs: { agent: 'lead', provider: 'local', model: 'gemma', is_real: true, tokens_in: 10, tokens_out: 5 } },
        { span_id: 'b', run_id: runId, type: 'model_call', name: 'model_call', start: t + 3, status: 'open', attrs: { agent: 'researcher', provider: 'local', model: 'gemma', is_real: true } },
      ]
      return new Promise<TeamResult>((res) => {
        finish = res
      })
    })
    renderWorkspace()
    await settle()
    await act(async () => {
      void captured.app!.sendTeam({ task: 'plan the launch', display: '→ team: plan the launch', roster: 'lead:local,researcher:local' })
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3200))
    })
    await settle()
    // The strip is on screen without anyone asking for it — inside the chat
    // card, above the conversation, which never leaves the screen.
    const strip = document.querySelector('.chat .strip') as HTMLElement
    expect(strip).not.toBeNull()
    expect(strip).toHaveClass('is-live')
    expect(screen.getByText(/→ team: plan the launch/)).toBeInTheDocument()
    // Who is on it: each seat once, on the strip and nowhere else.
    expect(screen.getAllByRole('button', { name: 'What researcher is doing' })).toHaveLength(1)
    expect(document.querySelectorAll('.crew__seat')).toHaveLength(0)
    expect(document.querySelector('.stage')).toBeNull()
    // What is running: one line for the run — no second card above the chat.
    expect(document.querySelectorAll('.strip__run')).toHaveLength(1)
    expect(document.querySelector('.lrun__card')).toBeNull()
    // Who is speaking: one sentence — the old four-line narration is gone.
    expect(screen.getAllByRole('status').filter((n) => n.classList.contains('strip__caption'))).toHaveLength(1)
    expect(document.querySelector('.chat__narration')).toBeNull()
    // Nothing opened beside the chat by itself; the engine's steps are there
    // on request, and there is no Stage to choose.
    expect(document.querySelector('.pane')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Steps' }))
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Stage' })).toBeNull()
    // The full-window drawing is one click away.
    expect(screen.getByRole('link', { name: 'Watch this run full window' })).toHaveAttribute('href', '/live')
    // The engine closes the run: every span ends, and the run span with them.
    {
      const t = Date.now() / 1000
      h.spans = (h.spans as { status: string; end?: number; run_id?: string }[]).map((sp) => ({
        ...sp,
        status: 'ok',
        end: sp.end ?? t,
      }))
      const runId = (h.spans[0] as { run_id: string }).run_id
      h.spans.push({ span_id: 'run', run_id: runId, type: 'run', name: `run:${runId}`, start: t - 5, end: t, status: 'ok', attrs: {} })
    }
    await act(async () => {
      finish({
        run_id: 'r1',
        board: [{ from: 'lead', provider: 'local', is_real: true, content: 'done' }],
        synthesis: 'done',
        board_path: '/vault/agents/board-r1.jsonl',
        tokens: 120,
        passed: true,
        overBudget: false,
        tokenBudget: 100000,
        reason: '',
        taskId: 'r1',
        spansPath: '/vault/spans.jsonl',
        verdictPath: '/vault/verdicts/r1.json',
      } as unknown as TeamResult)
      await Promise.resolve()
    })
    await settle()
    // The run is over: the strip goes. The answer in the chat is the record;
    // nothing keeps saying "nothing is running now".
    expect(document.querySelector('.strip')).toBeNull()
    expect(screen.queryByText(/nothing is running now/)).not.toBeInTheDocument()
  }, 15000)

  it('a run that belongs to another room is not drawn here — the room says where the engine is', async () => {
    const project = addProject('Side Room', 'ship it', '', '/tmp/side-room')
    updateProject(project.id, { status: 'done', plan: ['step one'], stepIndex: 1 })
    renderWorkspace()
    await settle()
    // The Manager's own work starts (a heartbeat, a job) — registered with no
    // room, which is the Manager's.
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'manager', intent: 'Ops · morning sweep' })
      await Promise.resolve()
    })
    await settle()
    // In the Manager's room it is this room's run.
    expect(document.querySelector('.strip.is-live')).not.toBeNull()
    // In the project's room it is not: one quiet line, and a way there.
    await act(async () => {
      captured.app!.setActiveProject(project.id)
      await Promise.resolve()
    })
    await settle()
    expect(document.querySelector('.strip.is-live')).toBeNull()
    expect(screen.getByText(/Busy in Manager — Ops · morning sweep/)).toBeInTheDocument()
    expect(document.querySelectorAll('.strip__seat')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Go to Manager' }))
    await settle()
    expect(document.querySelector('.strip.is-live')).not.toBeNull()
    await act(async () => {
      captured.app!.endLiveRun(id, 'passed')
      await Promise.resolve()
    })
  })
})
