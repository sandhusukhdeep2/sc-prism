import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject, updateProject } from '../lib/projects'
import { SettingsProvider, DEFAULT_SETTINGS } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// MV5 (Manager View §5): "approve" mode (default) proposes the REAL resolved
// team before a build runs — `runProject` provably does not fire until the
// user clicks "Approve & build". "auto" mode runs directly (today's
// behavior). This test proves the gate at its actual trigger point: spy on
// `runProject` itself (via a partial mock of AppStore that substitutes it,
// keeping every other real context value from the real AppProvider) rather
// than only inferring it from UI text.
const runProjectSpy = vi.fn(async () => {})

vi.mock('../store/AppStore', async () => {
  const actual = await vi.importActual<typeof import('../store/AppStore')>('../store/AppStore')
  return {
    ...actual,
    useApp: () => {
      const real = actual.useApp()
      return { ...real, runProject: runProjectSpy }
    },
  }
})

// Role keys must name REAL library agents (the staffing gate, 2026-08-30,
// lib/projects.ts staffRoster) — these are seeded system-agent slugs, spread
// across three providers so the reassignment test below still has moves to show.
const ROSTER = 'planner:claude,researcher:gemini,implementer:local'

/**
 * Providers that can REALLY answer (2026-08-12). The build proposal now shows
 * the team as it would actually be assembled: a role whose provider isn't
 * connected sits out with a reason instead of being promised and then stubbed.
 * This test is about the approval GATE, so it seeds a genuinely connected
 * setup — claude/gemini with keys, local with a server URL — and the exclusion
 * behaviour is pinned separately below.
 */
function seedConnectedProviders() {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        { id: 'local', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: true },
        { id: 'claude', apiKey: 'sk-real', enabled: true, primary: false },
        { id: 'gemini', apiKey: 'g-real', enabled: true, primary: false },
      ],
    }),
  )
}

function seedPlannedProject() {
  const project = addProject('Approval Target', 'ship it', '', '/tmp/approval-target')
  updateProject(project.id, {
    status: 'planned',
    plan: ['step one', 'step two'],
    roster: ROSTER,
  })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [project.id]: [] },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      activeProjectId: project.id,
    }),
  )
  return project
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

describe('ProjectContextPanel — Start build approval gate (MV5)', () => {
  beforeEach(() => {
    localStorage.clear()
    runProjectSpy.mockClear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('approve mode (default): Start build proposes the real resolved team and does NOT call runProject', () => {
    expect(DEFAULT_SETTINGS.approvalMode).toBe('approve') // no settings seed needed — this IS the default
    seedConnectedProviders()
    seedPlannedProject()
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))

    // The gate's visible contract: the proposal shows the REAL roster (same
    // string `projectBuildRoster` resolved), not a fabricated one. Scoped to
    // the proposal panel itself — TeamRosterControl's own "manual override"
    // line renders the identical roster text elsewhere on the same page.
    const proposalText = screen.getByText(/the manager will assemble your team/i)
    expect(proposalText.textContent).toMatch(/planner → claude/)
    expect(proposalText.textContent).toMatch(/researcher → gemini/)
    expect(proposalText.textContent).toMatch(/implementer → local/)
    expect(screen.getByRole('button', { name: /approve & build/i })).toBeInTheDocument()
    // The real trigger gate: runProject provably has not fired yet.
    expect(runProjectSpy).not.toHaveBeenCalled()
  })

  it('a role whose provider is NOT connected is REASSIGNED in the proposal, with the reason', () => {
    // No seedConnectedProviders(): claude and gemini are off and keyless here.
    // Under the 2026-08-29 rule the seats no longer die with their brands —
    // they move to the provider that CAN answer (local, here), and the
    // proposal the user approves shows the move with its reason. That
    // approval IS the "ask me".
    seedPlannedProject()
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))

    const proposalText = screen.getByText(/the manager will assemble your team/i)
    expect(proposalText.textContent).toMatch(/implementer → local/)
    expect(proposalText.textContent).not.toMatch(/planner → claude/)
    expect(proposalText.textContent).not.toMatch(/researcher → gemini/)
    // …and the move is SAID, never silent.
    const sitOut = document.querySelector('.proj__teamsitout')
    expect(sitOut).not.toBeNull()
    expect(sitOut!.textContent).toMatch(/planner reassigned claude → local/i)
    expect(sitOut!.textContent).toMatch(/researcher reassigned gemini → local/i)
  })

  it('an override naming NO real agent reads as the staffing refusal, never as a promised team', () => {
    // The observed 2026-08-29 bug: "lead:claude" named nobody in the library,
    // and the engine bound a fallback charter to the seat. The proposal must
    // now say the build will refuse, and the seat's reason must be on screen.
    seedConnectedProviders()
    const project = seedPlannedProject()
    updateProject(project.id, { roster: 'lead:claude' })
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))

    expect(screen.getByText(/no team could be staffed — the build will refuse to start/i)).toBeInTheDocument()
    const sitOuts = [...document.querySelectorAll('.proj__teamsitout')]
    expect(
      sitOuts.some((el) => /lead sits out: no agent in your library is named “lead”/.test(el.textContent ?? '')),
    ).toBe(true)
    expect(runProjectSpy).not.toHaveBeenCalled()
  })

  it('approve mode: Cancel dismisses the proposal without running, and Start build reappears', () => {
    seedPlannedProject()
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))
    expect(screen.getByRole('button', { name: /approve & build/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(screen.queryByRole('button', { name: /approve & build/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start build/i })).toBeInTheDocument()
    expect(runProjectSpy).not.toHaveBeenCalled()
  })

  it('approve mode: "Approve & build" calls runProject with this project\'s id, and hides the proposal', () => {
    const project = seedPlannedProject()
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))
    fireEvent.click(screen.getByRole('button', { name: /approve & build/i }))

    expect(runProjectSpy).toHaveBeenCalledTimes(1)
    expect(runProjectSpy).toHaveBeenCalledWith(project.id)
    expect(screen.queryByRole('button', { name: /approve & build/i })).not.toBeInTheDocument()
  })

  it('auto mode: Start build calls runProject directly — no proposal is ever shown', () => {
    localStorage.setItem('scprism.settings', JSON.stringify({ approvalMode: 'auto' }))
    const project = seedPlannedProject()
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: /^start build/i }))

    expect(runProjectSpy).toHaveBeenCalledTimes(1)
    expect(runProjectSpy).toHaveBeenCalledWith(project.id)
    expect(screen.queryByText(/the manager will assemble your team/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve & build/i })).not.toBeInTheDocument()
  })
})
