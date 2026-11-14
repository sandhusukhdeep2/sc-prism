import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE APP'S NOTICES READ (clear-room spec 2026-11-09 §B, his screenshot of
// 2026-11-11): the team-run notice was one monospace block ending in a full
// absolute path. A notice is a sentence in body type; the file it mentions is
// a reveal action named by the file's own name (project-room rule 5: every
// file the room mentions is reachable from the room).
const native = vi.hoisted(() => ({ revealPath: vi.fn(async () => true) }))
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    revealPath: native.revealPath,
    listProjectFiles: async () => [],
    expandUserPath: async (p: string) => p,
    resolveVaultDir: async () => '',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    listVaultTree: async () => [],
    readVaultFile: async () => null,
    writeVaultNote: async () => null,
  }
})
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject, updateProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

const BOARD = '/tmp/vault/agents/board-hello-1032bacd.jsonl'
const NOTICE = `team run did not pass — [llm-judge] two seats answered | score=0.675 vs threshold=0.7 → BELOW | envelope ok · 2,967/100,000 tok · board saved: ${BOARD}`

function seed() {
  const project = addProject('Notice Target', 'ship it', '', '/tmp/notice-target')
  updateProject(project.id, { status: 'planned', plan: ['step one'] })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [project.id]: [{ id: 'n1', kind: 'notice', text: NOTICE }] },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      activeProjectId: project.id,
    }),
  )
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('a chat notice reads, and its file is reachable', () => {
  beforeEach(() => {
    localStorage.clear()
    native.revealPath.mockClear()
  })
  afterEach(() => localStorage.clear())

  // 2026-11-14 ("Visible agents"): a team run's own line is drawn as the
  // outcome strip that closes the run. The same two guarantees hold on it.
  it('a team run’s result reads as a strip in body type, with the saved board as a reveal action by name', async () => {
    seed()
    renderWorkspace()
    const why = await screen.findByText(/\[llm-judge\] two seats answered/)
    const strip = why.closest('.outcome') as HTMLElement
    expect(strip).not.toBeNull()
    expect(strip).toHaveTextContent('✕ did not pass')
    expect(why.className).not.toMatch(/\bmono\b/)
    expect(strip).toHaveTextContent('2,967 of 100,000 tokens')
    // The absolute path is not printed anywhere in it…
    expect(strip.textContent).not.toContain('/tmp/vault/agents')
    // …it is the reveal button, named by the file.
    const reveal = screen.getByRole('button', { name: /reveal board-hello-1032bacd\.jsonl/i })
    fireEvent.click(reveal)
    expect(native.revealPath).toHaveBeenCalledWith(BOARD)
  })
})

// A RUN'S VERDICT IN THE CHAT IS ONE STRIP (2026-11-14, "Visible agents").
// It used to be a black six-row card; the room's mockup closes a run with one
// line of chips, and the full record is one click away on its own page.
describe('a verdict in the chat is one strip, with the way to its full record', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('says how the run ended, what the checks said and what it cost — and links to the record', async () => {
    const project = addProject('Verdict Target', 'ship it', '', '/tmp/verdict-target')
    updateProject(project.id, { status: 'done', plan: ['step one'], stepIndex: 1 })
    const verdict = {
      taskId: 't1',
      task: 'add a guard',
      route: { target: 'local', model: 'gemma-3', via: '', reason: '', routeLabel: 'internal → local · gemma-3' },
      tier1: { tests: '12/12', lint: true, build: true, pass: true },
      tier2: { evalScore: 0.91, passed: true, judge: 'judge', trajectory: 'ok' },
      tokensIn: 5000,
      tokensOut: 2500,
      cost: 0,
      durationMs: 4000,
      modelRoute: '',
      hooks: { blocked: 0, passed: true },
      writeback: { path: 'verdicts/t1.md', validated: true, committed: true },
      passed: true,
      outcome: 'passed',
    }
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { universal: [], [project.id]: [{ id: 'v1', kind: 'verdict', verdict }] },
        verdicts: [verdict],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: project.id,
      }),
    )
    renderWorkspace()
    const strip = await screen.findByRole('group', { name: 'How this run ended' })
    expect(strip).toHaveTextContent('✓ routed → verified → written')
    expect(strip).toHaveTextContent('checks: 12/12 tests passed')
    expect(strip).toHaveTextContent('review: 0.91')
    expect(strip).toHaveTextContent('stayed local')
    expect(strip).toHaveTextContent('$0 cloud · 7.5k tokens')
    expect(screen.getByRole('link', { name: 'Open the full record of this run' })).toHaveAttribute('href', '/verdict')
    // The six-row card is gone from the chat.
    expect(document.querySelector('.verdict')).toBeNull()
  })
})
