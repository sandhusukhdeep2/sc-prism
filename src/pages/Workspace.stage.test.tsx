// 2026-11-11, the owner: "Build in the form of animation… user can expand to
// the text or terminal side, but can see the animation most of the time."
// While a team is working, the Work room shows the STAGE; the conversation and
// the engine steps are one click away. When nothing is running, the chat is
// the room again.
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
    // The stage is on screen without anyone asking for it.
    expect(document.querySelector('.stage')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Stage' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'What researcher is doing' })).toBeInTheDocument()
    // Each seat is drawn once: the board keeps its other lines, not its seats.
    expect(document.querySelectorAll('.crew__seat')).toHaveLength(0)
    // The conversation is one click away…
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(document.querySelector('.stage')).toBeNull()
    expect(screen.getByText(/→ team: plan the launch/)).toBeInTheDocument()
    // …and so is the stage again.
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }))
    expect(document.querySelector('.stage')).not.toBeNull()
    // The engine's own steps open from the stage.
    expect(screen.getByText('Engine steps')).toBeInTheDocument()
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
  }, 15000)
})
