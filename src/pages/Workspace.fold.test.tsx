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

// 2026-11-14 ("Visible agents"): the one fold line ("3 turns from 3 seats")
// became SEAT-ATTRIBUTED LINES, as the mockup writes a run into the chat — one
// line per turn (who · on which AI · the first thing it wrote), each opening
// its whole turn in place — closed by one outcome strip. The reason for the
// fold still holds: the working-out never buries the answer.
describe('Work — a run is written as one line per seat turn, then its outcome', () => {
  beforeEach(() => {
    localStorage.clear()
    h.runNativeTeam.mockReset()
  })
  afterEach(() => localStorage.clear())

  const turns = () => [...document.querySelectorAll('details.rl__turn')] as HTMLDetailsElement[]

  it('each turn is one line naming its seat and AI, and the answer stands on its own', async () => {
    await runTeam([
      turn('lead', 'claude-cli', 'Lead turn: split the work.\n\nThe lead’s second paragraph.'),
      turn('researcher', 'local', 'Researcher turn: three findings.\n\nThe researcher’s second paragraph.'),
      turn('critic', 'gemini', 'Critic turn: one objection.'),
    ].join('\n'))
    expect(turns()).toHaveLength(3)
    expect(turns().every((t) => !t.open)).toBe(true)
    // The seats are named on the lines themselves, with the AI each ran on.
    expect(turns().map((t) => t.querySelector('.rl__who')!.textContent)).toEqual(['Manager', 'Researcher', 'Critic'])
    expect(turns()[1].querySelector('.rl__ai')).toHaveAttribute('title', 'local · m')
    // Each line leads with the first thing its seat wrote…
    expect(turns()[0].querySelector('summary')!.textContent).toContain('Lead turn: split the work.')
    // …the rest of the turn is behind it, and the answer is not folded away.
    expect(screen.getByText('The lead’s second paragraph.')).not.toBeVisible()
    expect(screen.getByText('Here is the plan the team agreed on.')).toBeVisible()
  })

  it('a line opens in place to its whole turn, exactly as the seat wrote it', async () => {
    await runTeam([
      turn('lead', 'claude-cli', 'Lead turn: split the work.\n\nThe lead’s second paragraph.'),
      turn('researcher', 'local', 'Researcher turn: three findings.\n\nThe researcher’s second paragraph.'),
    ].join('\n'))
    fireEvent.click(turns()[1].querySelector('summary')!)
    expect(turns()[1].open).toBe(true)
    expect(screen.getByText('The researcher’s second paragraph.')).toBeVisible()
    // Only the one asked for.
    expect(turns()[0].open).toBe(false)
  })

  it('one seat’s single turn is one line too', async () => {
    await runTeam(turn('lead', 'local', 'Only the lead spoke.\n\nAnd it said this as well.'))
    expect(turns()).toHaveLength(1)
    expect(turns()[0].querySelector('.rl__who')!.textContent).toBe('Manager')
  })

  it('the run is closed by one strip: how it ended, the local share, the tokens, the saved board', async () => {
    await runTeam([
      turn('lead', 'claude-cli', 'Lead turn.'),
      turn('researcher', 'local', 'Researcher turn.'),
      turn('researcher', 'local', 'Researcher again.', 2),
    ].join('\n'))
    const strips = screen.getAllByRole('group', { name: 'How this run ended' })
    expect(strips).toHaveLength(1)
    expect(strips[0]).toHaveTextContent('✓ routed → verified → written')
    expect(strips[0]).toHaveTextContent('2 of 3 turns local')
    expect(strips[0]).toHaveTextContent('120 of 100,000 tokens')
    expect(screen.getByRole('button', { name: 'Reveal board-r1.jsonl' })).toHaveAttribute('title', '/vault/agents/board-r1.jsonl')
    // The app's raw line is not printed beside its own strip.
    expect(screen.queryByText(/team run passed ·/)).not.toBeInTheDocument()
  })
})
