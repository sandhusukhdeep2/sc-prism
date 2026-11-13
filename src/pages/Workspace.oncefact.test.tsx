// ONE STATEMENT PER FACT (the owner, 2026-11-14: "repetitive information is a
// lot… information is not totally connected with each other, and it's a bit
// cluttered"). Two places in the room said the same thing twice:
//   • a project's name was the room's heading AND the first line of Details;
//   • with the team taking a message, a fixed line said "your manager staffs
//     the team" above a line that names the seats really being sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
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
import Workspace from './Workspace'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

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

function threeAIs() {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, connected: true },
        { id: 'gemini', name: 'Gemini', baseUrl: '', apiKey: 'k', enabled: true, primary: false, connected: true },
      ],
    }),
  )
}

describe('the room says each thing once', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const p of getProjects().projects) removeProject(p.id)
  })
  afterEach(() => localStorage.clear())

  it('a project’s name is the room’s heading — Details does not repeat it', async () => {
    const project = addProject('Once Only', 'ship the thing', '', '/tmp/once-only')
    updateProject(project.id, { status: 'planned', plan: ['step one'] })
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { universal: [], [project.id]: [] },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: project.id,
      }),
    )
    renderWorkspace()
    expect(await screen.findByRole('heading', { level: 1, name: 'Once Only' })).toBeInTheDocument()
    const details = screen.getByRole('tabpanel')
    expect(within(details).queryByText('Once Only')).not.toBeInTheDocument()
    // What Details is for is still there: where the project stands, and its goal.
    expect(within(details).getByText('planned')).toBeInTheDocument()
    expect(within(details).getByText('ship the thing')).toBeInTheDocument()
  })

  it('with the team taking a message, who gets it is said by the line that names the seats — once', async () => {
    threeAIs()
    renderWorkspace()
    const box = (await screen.findByRole('textbox', { name: /describe/i })) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'review the launch plan and compare it with the old one' } })
    // The line that names the seats really being sent is there…
    expect(document.querySelector('.chat__routing')?.textContent ?? '').toMatch(/\S/)
    // …and no fixed sentence about "the team" sits above it saying less.
    expect(screen.queryByText(/your manager staffs the team/)).not.toBeInTheDocument()
  })
})
