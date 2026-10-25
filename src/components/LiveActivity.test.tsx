import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import LiveActivity from './LiveActivity'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider } from '../store/AppStore'
import type { Project, ProjectStatus } from '../lib/projects'

// Mirrors the provider-stack pattern used by Workspace.sidebar.test.tsx, minus
// the pieces LiveActivity itself never touches (no react-router Link, no
// onboarding) — AppProvider only needs Settings + Connectivity ancestors
// (it calls useSettings()/useConnectivity() internally).
function renderLiveActivity(project: Project) {
  return render(
    <SettingsProvider>
      <ConnectivityProvider>
        <AppProvider>
          <LiveActivity project={project} />
        </AppProvider>
      </ConnectivityProvider>
    </SettingsProvider>,
  )
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-liveact-1',
    name: 'Live Activity Test Project',
    slug: 'live-activity-test-project',
    path: '/tmp/live-activity-test-project',
    goal: 'ship it',
    verifyCommand: '',
    createdAt: 0,
    status: 'new' as ProjectStatus,
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    ...over,
  }
}

describe('LiveActivity', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('shows the default system team with honest per-agent status when the project has no verdicts', () => {
    // No agents assigned to this project id -> team falls back to the
    // enabled system agents (Planner, Implementer, ...), none of which carry
    // a createdAt, so no "created" event leaks in either.
    const project = makeProject({ id: 'proj-liveact-empty', verdictIds: [] })
    renderLiveActivity(project)

    expect(screen.getByText('Planner')).toBeInTheDocument()
    expect(screen.getByText('Implementer')).toBeInTheDocument()
    expect(screen.getAllByText('no runs yet').length).toBeGreaterThan(0)
  })

  it('renders the TEAM only — the run/event feed moved to the engine console, so no feed rows appear here', () => {
    // Seed a real verdict matched to the project via verdictIds. LiveActivity
    // now renders team-only; the run feed built from this verdict lives in the
    // console (Workspace) instead, so it must NOT appear inside this component.
    const project = makeProject({ id: 'proj-liveact-withrun', verdictIds: ['t-real-1'] })
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { universal: [] },
        verdicts: [
          {
            taskId: 't-real-1',
            task: 'ship the thing',
            route: {
              target: 'local',
              model: 'x',
              via: 'via gateway',
              reason: 'routine',
              routeLabel: 'local · x',
            },
            tier1: { tests: '1/1', lint: true, build: true, pass: true },
            tier2: { evalScore: 0.9, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
            tokensIn: 100,
            tokensOut: 50,
            cost: 0.01,
            durationMs: 1000,
            modelRoute: '100 tok in / 50 out',
            hooks: { blocked: 0, passed: true },
            writeback: { path: 'verdicts/t-real-1.json', validated: true, committed: true },
            passed: true,
            at: new Date().toISOString(),
            native: {
              hooksFired: [],
              hookDecisions: [],
              blocks: 0,
              approvals: 0,
              memoryInjected: 0,
              disclosed: [],
              rejectedWrites: 0,
              cacheHits: 0,
              cacheMisses: 0,
              spansPath: '',
              models_used: ['local · x'],
            },
          },
        ],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      }),
    )

    renderLiveActivity(project)

    // The team still renders...
    expect(screen.getByText('Planner')).toBeInTheDocument()
    // ...but the run feed row does NOT (it now lives in the console).
    expect(screen.queryByText(/run passed/)).not.toBeInTheDocument()
    expect(screen.queryByText('no activity yet')).not.toBeInTheDocument()
  })
})
