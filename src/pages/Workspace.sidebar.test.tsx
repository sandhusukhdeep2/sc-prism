import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, UNIVERSAL } from '../store/AppStore'

// Mirrors main.tsx's provider stack (same pattern as App.smoke.test.tsx /
// Projects.deeplink.test.tsx), mounted directly on the Work page.
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

// P1-3a: the old <ProjectSwitcher> tab (a <select> in .chat__tabs) is gone —
// a left sidebar now lists Manager + every project as its own chat
// session, and switching is a plain button click (no route change). Runs
// non-native (no __TAURI_INTERNALS__ stub) — the native-only file-attach and
// vault-probing effects are out of scope here and would otherwise reject
// against a fake `invoke`.
describe('Workspace left sidebar (Manager + projects)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('lists Manager and each seeded project, Manager active by default', () => {
    addProject('Sidebar Alpha', 'ship it', '', '/tmp/sidebar-alpha')
    addProject('Sidebar Beta', 'ship it', '', '/tmp/sidebar-beta')
    renderWorkspace()

    const universalBtn = screen.getByRole('button', { name: /^manager$/i })
    expect(universalBtn).toBeInTheDocument()
    expect(universalBtn.className).toMatch(/is-active/)

    expect(screen.getByRole('button', { name: /sidebar alpha/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sidebar beta/i })).toBeInTheDocument()
  })

  // P5 (HONESTY): with NO agent running, the Work page must show a true empty
  // state, never a fabricated "implementer · waiting for a task" card.
  //
  // UPDATED (visual system v2, 2026-08-18): the sentence being looked for moved
  // house. It used to be `<AgentCardEmpty>`'s "no agent running — describe a
  // task to start one", rendered in the right rail. The v2 rebuild retires that
  // rail on the Universal thread and states the quiet case in the two v2
  // surfaces instead: no crew board renders AT ALL (no crew → no pipeline), and
  // the measured ledger says in words that it has recorded nothing. The rule is
  // untouched — a quiet page fabricates no agent — and is now checked in the
  // stronger form: not "an honest empty card" but "no card, and no claim".
  it('renders an honest idle empty state (no fabricated live agent) when nothing is running', () => {
    renderWorkspace()
    expect(document.querySelector('.crew')).toBeNull()
    expect(document.querySelector('.lrun__card')).toBeNull()
    // This fixture seeds ONE verdict with no engine timestamp. That IS a
    // recorded run, so it correctly gets a row — while the week, which can only
    // count runs it can place in time, says exactly why it cannot place it.
    // Row present + week honest is the designed pair, not a contradiction (see
    // `recentRuns` in lib/pipeline.ts).
    //
    // The row is a TABLE row now: the ledger moved out of the 320px rail into
    // the full-width evidence band under the work, where the five facts it has
    // always carried (task, outcome, checks, ran on, took) fit as real columns.
    expect(document.querySelectorAll('.ledger__table tbody tr').length).toBe(1)
    // "this week" either has nothing at all, or has only undated verdicts it
    // refuses to place in a week — both are the honest empty statement, and
    // neither draws an arc.
    expect(screen.getByText(/no runs recorded this week yet|no timed runs this week/i)).toBeInTheDocument()
    expect(document.querySelector('.ledger__donut')).toBeNull()
    // The old fake card's role/task strings must still be gone.
    expect(screen.queryByText('waiting for a task')).not.toBeInTheDocument()
    expect(screen.queryByText(/^idle · /)).not.toBeInTheDocument()
  })

  it('clicking a project switches the active thread — its nav item goes active, Manager does not, and its own thread content replaces the previous one', () => {
    const projectA = addProject('Sidebar Gamma', 'ship it', '', '/tmp/sidebar-gamma')
    const projectB = addProject('Sidebar Omega', 'ship it', '', '/tmp/sidebar-omega')
    // P1-3b: setActiveProject no longer drops a "now working on…" divider on
    // switch (per-scope threads already make the switch unambiguous, and the
    // divider masked the Begin-interview empty state) — so prove a real
    // thread switch by seeding each project with its OWN distinct message
    // (same persisted-session seeding approach as the test below) and
    // asserting the visible content, not a removed side effect.
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: {
          [UNIVERSAL]: [],
          [projectA.id]: [{ id: 'a-1', kind: 'assistant', text: 'gamma-only reply' }],
          [projectB.id]: [{ id: 'b-1', kind: 'assistant', text: 'omega-only reply' }],
        },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: projectA.id,
      }),
    )
    renderWorkspace()

    // Scoped to the nav: P3-3's rail Delete button is aria-labelled "Delete
    // <project name>", which would otherwise also match these loose
    // name-regexes once a project is active (its own context rail renders).
    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    const gammaBtn = within(nav).getByRole('button', { name: /sidebar gamma/i })
    const omegaBtn = within(nav).getByRole('button', { name: /sidebar omega/i })
    const universalBtn = within(nav).getByRole('button', { name: /^manager$/i })

    expect(gammaBtn.className).toMatch(/is-active/)
    expect(omegaBtn.className).not.toMatch(/is-active/)
    expect(universalBtn.className).not.toMatch(/is-active/)
    expect(screen.getByText('gamma-only reply')).toBeInTheDocument()
    expect(screen.queryByText('omega-only reply')).not.toBeInTheDocument()

    fireEvent.click(omegaBtn)

    expect(within(nav).getByRole('button', { name: /sidebar omega/i }).className).toMatch(/is-active/)
    expect(within(nav).getByRole('button', { name: /sidebar gamma/i }).className).not.toMatch(/is-active/)
    expect(within(nav).getByRole('button', { name: /^manager$/i }).className).not.toMatch(/is-active/)
    // The active thread really changed, not just the nav highlight: Omega's
    // own seeded message now renders and Gamma's no longer does.
    expect(screen.getByText('omega-only reply')).toBeInTheDocument()
    expect(screen.queryByText('gamma-only reply')).not.toBeInTheDocument()
  })

  it('shows the "Begin interview" empty state for the active project once its thread is empty', () => {
    const project = addProject('Sidebar Delta', 'ship it', '', '/tmp/sidebar-delta')
    // Seed a persisted session with Sidebar Delta already active and its
    // thread empty — i.e. reopening a project session (P1-3b: switching via
    // the sidebar no longer drops a divider, so this empty state now shows
    // right after a real switch too, not just on reopen).
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { [UNIVERSAL]: [], [project.id]: [] },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: project.id,
      }),
    )
    renderWorkspace()

    // Scoped to the nav — see the note in the test above.
    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    expect(within(nav).getByRole('button', { name: /sidebar delta/i }).className).toMatch(/is-active/)
    expect(screen.getByRole('button', { name: /begin interview/i })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`a few questions about .${project.name}.`, 'i'))).toBeInTheDocument()
  })
})

// P3-3: the rail's inline Delete (the only place delete used to live was the
// now-retired ProjectView) + the dangling-activeProjectId heal that keeps a
// deleted/orphaned project from leaving a ghost thread behind.
describe('Workspace rail: delete a project + heal a dangling active id (P3-3)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('deletes the active project from the rail (two-step in-app confirm) and falls back to Manager', () => {
    const project = addProject('Sidebar Epsilon', 'ship it', '', '/tmp/sidebar-epsilon')
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { [UNIVERSAL]: [], [project.id]: [] },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: project.id,
      }),
    )
    renderWorkspace()

    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    expect(within(nav).getByRole('button', { name: /sidebar epsilon/i })).toBeInTheDocument()

    // Arm the confirm — one click on ✕ must NOT delete anything (no native dialog).
    fireEvent.click(screen.getByRole('button', { name: /delete sidebar epsilon/i }))
    expect(within(nav).getByRole('button', { name: /sidebar epsilon/i })).toBeInTheDocument()

    // The explicit confirm performs the durable removal.
    fireEvent.click(screen.getByRole('button', { name: /confirm delete sidebar epsilon/i }))
    // Gone from the sidebar — its nav item is no longer a button there.
    expect(within(nav).queryByRole('button', { name: /sidebar epsilon/i })).not.toBeInTheDocument()
    // And the active session fell back to Universal, not a ghost thread.
    expect(within(nav).getByRole('button', { name: /^manager$/i }).className).toMatch(/is-active/)
  })

  it('does not delete when the in-app confirm is cancelled', () => {
    const project = addProject('Sidebar Zeta', 'ship it', '', '/tmp/sidebar-zeta')
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { [UNIVERSAL]: [], [project.id]: [] },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: project.id,
      }),
    )
    renderWorkspace()

    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    fireEvent.click(screen.getByRole('button', { name: /delete sidebar zeta/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel deleting project/i }))

    // Still there — cancelling the confirm must not remove it.
    expect(within(nav).getByRole('button', { name: /sidebar zeta/i })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: /sidebar zeta/i }).className).toMatch(/is-active/)
  })

  it('heals a dangling activeProjectId (no matching project) back to Manager', () => {
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { [UNIVERSAL]: [] },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        activeProjectId: 'ghost-id',
      }),
    )
    renderWorkspace()

    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    expect(within(nav).getByRole('button', { name: /^manager$/i }).className).toMatch(/is-active/)
    // No active-project rail — nothing to delete when there's no ghost thread.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})
