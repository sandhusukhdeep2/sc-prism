// The chat folds a run's own turns (2026-11-12, lib/chatFold.ts): one line
// that opens in place, with the answer standing on its own under it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import type { TeamResult } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({
  runNativeTeam: vi.fn(),
  board: '',
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
    readVaultFile: async () => h.board,
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

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const turn = (from: string, provider: string, content: string, round = 1) =>
  JSON.stringify({ from, provider, model: 'm', is_real: true, content, round })

async function runTeam(board: string) {
  h.board = board
  h.runNativeTeam.mockResolvedValue({
    run_id: 'r1', board: [], synthesis: 'Here is the plan the team agreed on.',
    board_path: '/vault/agents/board-r1.jsonl', tokens: 120, passed: true, overBudget: false,
    tokenBudget: 100000, reason: '', taskId: 'r1', spansPath: '', verdictPath: '',
  } as unknown as TeamResult)
  renderWorkspace()
  await settle()
  await act(async () => {
    await captured.app!.sendTeam({ task: 'plan the launch', display: '→ team: plan the launch', roster: 'lead:local,researcher:local' })
  })
  await settle()
}

describe('Work — a run’s own turns are folded under its answer', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
  })
  afterEach(() => localStorage.clear())

  it('shows one line for the turns, and the answer on its own', async () => {
    await runTeam([
      turn('lead', 'claude-cli', 'Lead turn: split the work.'),
      turn('researcher', 'local', 'Researcher turn: three findings.'),
      turn('critic', 'gemini', 'Critic turn: one objection.'),
    ].join('\n'))
    const fold = screen.getByText('3 turns from 3 seats').closest('details') as HTMLDetailsElement
    expect(fold).not.toBeNull()
    expect(fold.open).toBe(false)
    // The seats are named on the line itself.
    expect(fold.querySelector('summary')!.textContent).toContain('lead')
    expect(fold.querySelector('summary')!.textContent).toContain('researcher')
    expect(fold.querySelector('summary')!.textContent).toContain('critic')
    // The answer is not folded away with them.
    expect(screen.getByText('Here is the plan the team agreed on.')).toBeVisible()
    expect(screen.getByText('Lead turn: split the work.')).not.toBeVisible()
  })

  it('opens in place to every turn, exactly as each seat wrote it', async () => {
    await runTeam([
      turn('lead', 'claude-cli', 'Lead turn: split the work.'),
      turn('researcher', 'local', 'Researcher turn: three findings.'),
    ].join('\n'))
    const fold = screen.getByText('2 turns from 2 seats').closest('details') as HTMLDetailsElement
    fireEvent.click(fold.querySelector('summary')!)
    expect(fold.open).toBe(true)
    expect(screen.getByText('Lead turn: split the work.')).toBeVisible()
    expect(screen.getByText('Researcher turn: three findings.')).toBeVisible()
    expect(fold.querySelectorAll('.msg--seat')).toHaveLength(2)
  })

  it('one seat’s single turn stays a bubble — there is nothing to fold', async () => {
    await runTeam(turn('lead', 'local', 'Only the lead spoke.'))
    expect(screen.getByText('Only the lead spoke.')).toBeVisible()
    expect(document.querySelector('.msg--fold')).toBeNull()
  })
})
