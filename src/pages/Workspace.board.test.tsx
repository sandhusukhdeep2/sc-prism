// THE ROOM IS ITS TEAM BOARD AND ITS CHAT (spec 2026-11-14 "Visible agents").
// The owner, of the Stage: "very complicated… repetitive information is a
// lot" — and of the animation in it: "that I like". And of the mockup that
// puts the Team board at the top of the room: "perfect example what I want".
// So there is no Stage; the room's team stands on a board above the chat at
// all times, a run is drawn ON it (who is at work, the handoff in flight),
// and it says what is running — each fact once. The engine's steps open
// beside the chat on request; nothing opens by itself.
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
  cancelEngineRun: vi.fn(async (_id: string) => {}),
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

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('Work — the Team board above the chat, and no Stage', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const p of getProjects().projects) removeProject(p.id)
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockReset()
    h.cancelEngineRun.mockImplementation(async () => {})
    h.spans = []
  })
  afterEach(() => localStorage.clear())

  it('with nothing running the room is its team at rest and its chat — and no Stage', async () => {
    renderWorkspace()
    await settle()
    const board = document.querySelector('.ws__chatcol .board') as HTMLElement
    expect(board).not.toBeNull()
    expect(board).not.toHaveClass('is-live')
    expect(board.querySelector('.board__run')).toBeNull()
    expect(board.querySelector('.is-running')).toBeNull()
    // The room's head counts the team and claims no work: nobody has worked.
    expect(document.querySelector('.ws__count')?.textContent).toMatch(/^\d+ agents?$/)
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Stage' })).not.toBeInTheDocument()
  })

  it('a live team run is drawn on the board, and each fact about it is said once', async () => {
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
    // Seen in the installed app, 2026-11-14: the run's lines were written
    // under the last message and the chat stayed where it was — they could
    // only be found by scrolling. The chat follows the run as it is written:
    // the engine reports one more step, and the chat is moved to it.
    expect(document.querySelectorAll('.rl__line')).toHaveLength(2)
    const body = document.querySelector('.chat__body') as HTMLElement
    let followed = 0
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => 0, set: () => void followed++ })
    {
      const t = Date.now() / 1000
      const runId = (h.spans[0] as { run_id: string }).run_id
      h.spans = [
        ...h.spans,
        { span_id: 'c', run_id: runId, type: 'tool_exec', name: 'tool_exec', start: t - 1, end: t, status: 'ok', attrs: { agent: 'researcher', provider: 'web', tool: 'web_search' } },
      ]
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1500))
    })
    await settle()
    expect(document.querySelector('.rl')).toHaveTextContent('searched the web')
    expect(followed).toBeGreaterThan(0)
    // The board is live without anyone asking for it — above the chat card,
    // and the conversation never leaves the screen.
    const board = document.querySelector('.ws__chatcol .board') as HTMLElement
    expect(board).not.toBeNull()
    expect(board).toHaveClass('is-live')
    expect(screen.getByText(/→ team: plan the launch/)).toBeInTheDocument()
    // Who is on it: each seat once, on the board and nowhere else.
    const researcher = screen.getAllByRole('button', { name: 'What Researcher is doing' })
    expect(researcher).toHaveLength(1)
    expect(document.querySelectorAll('.crew__seat')).toHaveLength(0)
    expect(document.querySelector('.stage')).toBeNull()
    // What is running: one line for the run — no second card above the chat.
    expect(document.querySelectorAll('.board__run')).toHaveLength(1)
    expect(document.querySelector('.lrun__card')).toBeNull()
    // Who is working: the seat itself says so — its ring breathes and its own
    // line reads "thinking". There is no separate sentence, and the old
    // four-line narration is gone.
    expect(researcher[0]).toHaveClass('is-running')
    expect(researcher[0]).toHaveTextContent('thinking')
    expect(screen.getByRole('button', { name: 'What Manager is doing' })).toHaveTextContent('answered')
    expect(document.querySelector('.chat__narration')).toBeNull()
    // The room's head counts off the same board.
    expect(document.querySelector('.ws__count')).toHaveTextContent('2 agents · 2 have worked · 1 working now')
    // Nothing opened beside the chat by itself; the engine's steps are there
    // on request, and there is no Stage to choose.
    expect(document.querySelector('.pane')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Steps' }))
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Stage' })).toBeNull()
    // It can be stopped from here: the board's Stop cancels the engine's run.
    expect(h.cancelEngineRun).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop this run' })).toBeInTheDocument()
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
    // The run is over: the board is the team at rest again — no run line, no
    // one at work — and each seat keeps what it did. The answer in the chat is
    // the record; nothing keeps saying "nothing is running now".
    const after = document.querySelector('.ws__chatcol .board') as HTMLElement
    expect(after).not.toHaveClass('is-live')
    expect(after.querySelector('.board__run')).toBeNull()
    expect(after.querySelector('.is-running')).toBeNull()
    expect(screen.getByRole('button', { name: 'What Researcher is doing' })).toHaveTextContent('done')
    expect(document.querySelector('.ws__count')).toHaveTextContent('2 agents · 2 have worked')
    expect(screen.queryByText(/nothing is running now/)).not.toBeInTheDocument()
  }, 20000)

  // Seen in the real app, 2026-11-14: a plain "hello" put up the strip ("chat ·
  // hello · working…") above a chat bubble that already said "… is thinking",
  // over a composer placeholder saying it a third time.
  it('one AI answering a message is not a run to draw — the Manager’s seat breathes, and no words repeat the chat', async () => {
    renderWorkspace()
    await settle()
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'chat', intent: 'hello' })
      await Promise.resolve()
    })
    await settle()
    const board = document.querySelector('.ws__chatcol .board') as HTMLElement
    expect(board.querySelector('.board__run')).toBeNull()
    expect(board.querySelector('.board__note')).toBeNull()
    expect(board.querySelector('.board__state')).toBeNull()
    expect(board.querySelectorAll('.is-running')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'What Manager is doing' })).toHaveClass('is-running')
    await act(async () => {
      captured.app!.endLiveRun(id, 'passed')
      await Promise.resolve()
    })
    await settle()
    expect(document.querySelector('.board .is-running')).toBeNull()
  })

  it('Stop on the board really cancels the engine’s run, and the room says it was stopped', async () => {
    let killed: (r: TeamResult | null) => void = () => {}
    h.runNativeTeam.mockImplementation(() => new Promise<TeamResult | null>((res) => (killed = res)))
    h.cancelEngineRun.mockImplementation(async () => killed(null))
    renderWorkspace()
    await settle()
    await act(async () => {
      void captured.app!.sendTeam({ task: 'plan the launch', display: '→ team: plan the launch', roster: 'lead:local,researcher:local' })
      await Promise.resolve()
    })
    await settle()
    const runId = String(h.runNativeTeam.mock.calls[0][6])
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }))
    await settle(12)
    expect(h.cancelEngineRun).toHaveBeenCalledWith(runId)
    expect(document.querySelector('.board__run')).toBeNull()
    expect(document.querySelector('.board')).not.toHaveClass('is-live')
    expect(screen.getByText(/Stopped — you stopped this team run/)).toBeInTheDocument()
    expect(screen.queryByText(/Team run failed/)).not.toBeInTheDocument()
  })

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
    expect(document.querySelector('.board.is-live')).not.toBeNull()
    // In the project's room it is not: one quiet line, and a way there.
    await act(async () => {
      captured.app!.setActiveProject(project.id)
      await Promise.resolve()
    })
    await settle()
    expect(document.querySelector('.board.is-live')).toBeNull()
    expect(screen.getByText(/Busy in Manager — Ops · morning sweep/)).toBeInTheDocument()
    // Seen in the real app, 2026-11-14: the head said "nothing running right
    // now" directly above "Busy in Manager — …". The head may not say that
    // while the engine is at work anywhere.
    expect(screen.queryByText(/nothing running right now/)).not.toBeInTheDocument()
    // This room's own team is on its board, and none of it is at work.
    expect(document.querySelectorAll('.board__seat.is-running')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Go to Manager' }))
    await settle()
    expect(document.querySelector('.board.is-live')).not.toBeNull()
    await act(async () => {
      captured.app!.endLiveRun(id, 'passed')
      await Promise.resolve()
    })
  })
})
