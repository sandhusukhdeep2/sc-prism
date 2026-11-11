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

  it('sets the sentence in body type and offers the saved board as a reveal action by name', async () => {
    seed()
    renderWorkspace()
    const sentence = await screen.findByText(/team run did not pass — \[llm-judge\] two seats answered/)
    expect(sentence.closest('.msg--notice')!.className).not.toMatch(/\bmono\b/)
    // The absolute path is not printed in the sentence…
    expect(sentence.textContent).not.toContain('/tmp/vault/agents')
    // …it is the reveal button, named by the file.
    const reveal = screen.getByRole('button', { name: /reveal board-hello-1032bacd\.jsonl/i })
    fireEvent.click(reveal)
    expect(native.revealPath).toHaveBeenCalledWith(BOARD)
  })
})
