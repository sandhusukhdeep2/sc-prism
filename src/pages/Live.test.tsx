// THE LIVE PAGE (2026-11-12). The owner: "I need one page just showing the
// animation when it's working." The stage, as large as the window allows, for
// the run executing now — or the last team run, as a still picture. Nothing
// else: no composer, no room list. It is the room pane's Stage tab, expanded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Live from './Live'
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

function renderLive() {
  return render(
    <MemoryRouter initialEntries={['/live']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Live />
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

const seat = (id: string, runId: string, agent: string, start: number, open: boolean) => ({
  span_id: id, run_id: runId, type: 'model_call', name: 'model_call', start,
  ...(open ? { status: 'open' } : { status: 'ok', end: start + 1 }),
  attrs: { agent, provider: 'local', model: 'gemma', is_real: true, tokens_in: 100, tokens_out: 40 },
})

describe('the Live page — the stage, and nothing else', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
    h.spans = []
  })
  afterEach(() => localStorage.clear())

  it('with nothing running and nothing to show, it says so and offers the way back', async () => {
    renderLive()
    await settle()
    expect(document.querySelector('.stage')).toBeNull()
    expect(screen.getByText('Nothing is running.')).toBeInTheDocument()
    expect(screen.getByText('When a team works, it is drawn here.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the room' })).toHaveAttribute('href', '/')
  })

  it('a team at work is drawn across the page, with who is speaking', async () => {
    let finish: (r: TeamResult) => void = () => {}
    h.runNativeTeam.mockImplementation((...args: unknown[]) => {
      const runId = String(args[6])
      const t = Date.now() / 1000
      h.spans = [seat('a', runId, 'lead', t + 1, false), seat('b', runId, 'researcher', t + 3, true)]
      return new Promise<TeamResult>((res) => {
        finish = res
      })
    })
    renderLive()
    await settle()
    await act(async () => {
      void captured.app!.sendTeam({ task: 'plan the launch', roster: 'lead:local,researcher:local' })
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3200))
    })
    await settle()
    expect(document.querySelector('.live .stage')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'What researcher is doing' })).toBeInTheDocument()
    expect(document.querySelectorAll('.stage__packet').length).toBeGreaterThan(0)
    expect(screen.getByText('working now')).toBeInTheDocument()
    // The task being worked on is named, in the user's own words.
    expect(screen.getByText('plan the launch')).toBeInTheDocument()
    // Nothing else is on the page: no composer, no room list.
    expect(screen.queryByRole('textbox')).toBeNull()
    await act(async () => {
      finish({
        run_id: 'r1', board: [], synthesis: 'done', board_path: '', tokens: 1, passed: true,
        overBudget: false, tokenBudget: 100000, reason: '', taskId: 'r1', spansPath: '', verdictPath: '',
      } as unknown as TeamResult)
      await Promise.resolve()
    })
  }, 15000)

  it('after a team run it is a still picture, and says of what', async () => {
    const t = Date.now() / 1000 - 600
    h.spans = [
      seat('a', 'old', 'lead', t, false),
      seat('b', 'old', 'researcher', t + 2, false),
      { span_id: 'r', run_id: 'old', type: 'run', name: 'run:old', start: t, end: t + 4, status: 'ok', attrs: {} },
    ]
    renderLive()
    await settle()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(document.querySelector('.live .stage')).not.toBeNull()
    expect(document.querySelector('.stage__packet')).toBeNull()
    expect(screen.getByText('the last team run · nothing is running now')).toBeInTheDocument()
  })
})
