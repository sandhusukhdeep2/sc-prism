// 2026-11-11, the owner: "Build in the form of animation… user can expand to
// the text or terminal side, but can see the animation most of the time."
// While a team is working, the Work room shows the STAGE — since 2026-11-12
// BESIDE the chat, in the room's pane, so the conversation never leaves the
// screen. The engine's steps are a tab of the same pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
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

describe('Work — the stage takes the room while a team is working', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.spans = []
  })
  afterEach(() => localStorage.clear())

  it('with no crew there is no Stage tab — the chat is the room', async () => {
    renderWorkspace()
    await settle()
    expect(screen.queryByRole('button', { name: 'Stage' })).not.toBeInTheDocument()
    expect(document.querySelector('.stage')).toBeNull()
  })

  it('a live team run shows the stage, and the conversation is one click away', async () => {
    let finish: (r: TeamResult) => void = () => {}
    h.runNativeTeam.mockImplementation((...args: unknown[]) => {
      const runId = String(args[6])
      // Spans carry the engine's clock in SECONDS; the page keeps the ones
      // that started after the live run did.
      const t = Date.now() / 1000
      h.spans = [
        { span_id: 'a', run_id: runId, type: 'model_call', name: 'model_call', start: t + 1, end: t + 2, status: 'ok', attrs: { agent: 'lead', provider: 'local', model: 'm', is_real: true } },
        { span_id: 'b', run_id: runId, type: 'model_call', name: 'model_call', start: t + 3, status: 'open', attrs: { agent: 'researcher', provider: 'local', model: 'm' } },
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
    // The stage is on screen without anyone asking for it — BESIDE the chat.
    expect(document.querySelector('.pane .stage')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Stage' })).toHaveAttribute('aria-selected', 'true')
    // The pane's own tabs say what is open: the chat's header does not repeat them.
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    expect(screen.getByRole('button', { name: 'What researcher is doing' })).toBeInTheDocument()
    // Each seat is drawn once: the board above the drawing is one slim line.
    expect(document.querySelectorAll('.crew__seat')).toHaveLength(0)
    expect(document.querySelector('.pane .crew')).toHaveClass('crew--slim')
    // The chat is still the chat: the conversation is on screen at the same
    // time, with nothing to click to get back to it.
    expect(screen.getByText(/→ team: plan the launch/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
    // The engine's own steps are a tab of the same pane.
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }))
    expect(document.querySelector('.pane .stage')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true')
    // The pane closes, and the chat's header then offers to open it again.
    fireEvent.click(screen.getByRole('button', { name: 'Close the pane' }))
    expect(document.querySelector('.pane')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }))
    expect(document.querySelector('.pane .stage')).not.toBeNull()
    // The stage can be given the whole window.
    expect(screen.getByRole('link', { name: 'Open the stage on its own page' })).toHaveAttribute('href', '/live')
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
    // The run is over: the drawing does not vanish under the reader — it
    // stays, as a still picture, and says of what.
    expect(document.querySelector('.pane .stage')).not.toBeNull()
    expect(document.querySelector('.stage__packet')).toBeNull()
    expect(screen.getByText('the last team run · nothing is running now')).toBeInTheDocument()
  }, 15000)
})
