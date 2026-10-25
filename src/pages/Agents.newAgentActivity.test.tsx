import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { create as createAgent, list as listAgents, remove as removeAgent } from '../lib/agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// The audit finding this file exists for, and why it is a PAGE test: the unit
// tests all asserted the STORED `usage: 0` and never what the Agents page
// RENDERS. A brand-new agent was shown another agent's history — every verdict
// whose model family matched (a live session had 18, all failed) — so thirty
// seconds after "it's in your agents now, with no runs yet" the page read
// "last failed · 18 runs · 0% pass". These assertions are on the rendered row.

/** 18 real, FAILED runs that all predate the agent under test — the shape of
 *  the live session in the audit. */
function seedOldRuns(count = 18): void {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [] },
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      verdicts: Array.from({ length: count }, (_, i) => ({
        taskId: `old-${i}`,
        task: 'hi',
        route: {},
        tier1: {},
        tier2: {},
        passed: false,
        at: '2026-08-01T09:00:00.000Z',
        native: { models_used: ['claude-cli · claude-opus', 'local · qwen'] },
      })),
    }),
  )
}

function renderAgents() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Agents />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** The activity label rendered on a named agent's tile. */
function labelFor(name: string): string {
  const tile = [...document.querySelectorAll('.agent-tile')].find(
    (el) => el.querySelector('.agent-tile__name')?.textContent === name,
  )
  return tile?.querySelector('.agent-usage__label')?.textContent ?? ''
}

describe('Agents page — a newly created agent shows NO history it did not make', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    for (const a of listAgents()) if (!a.system) removeAgent(a.id)
    localStorage.clear()
  })

  it('says "no runs yet" even with 18 matching-model runs already in the log', () => {
    seedOldRuns()
    createAgent({ name: 'Fresh Auditor', role: 'checks things', model: 'claude', skills: [] })
    renderAgents()

    expect(screen.getByText('Fresh Auditor')).toBeInTheDocument()
    expect(labelFor('Fresh Auditor')).toBe('no runs yet')
    // ...not one word of the borrowed history the row used to claim
    expect(labelFor('Fresh Auditor')).not.toMatch(/18|last failed|% pass/)
    // The built-in agents predate every timestamp the app has (they carry no
    // creation time at all), so they DO still count those runs — and their
    // label says exactly what it counts: runs on that model.
    expect(labelFor('Planner')).toBe('18 runs on claude · last failed · 0% pass of 18 decided runs')
  })

  it('once a run happens AFTER it exists, the row counts that run — and says what it counts', () => {
    const agent = createAgent({ name: 'Fresh Auditor', role: 'checks things', model: 'claude', skills: [] })
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { universal: [] },
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
        verdicts: [
          {
            taskId: 'after-1',
            task: 'check the uploader diff',
            route: {},
            tier1: {},
            tier2: {},
            passed: true,
            at: new Date(agent.createdAt! + 60_000).toISOString(),
            native: { models_used: ['claude-cli · claude-opus'] },
          },
          {
            taskId: 'before-1',
            task: 'hi',
            route: {},
            tier1: {},
            tier2: {},
            passed: false,
            at: new Date(agent.createdAt! - 60_000).toISOString(),
            native: { models_used: ['claude-cli · claude-opus'] },
          },
        ],
      }),
    )
    renderAgents()

    // ONE run — the older one still isn't this agent's — and the label names
    // what is really being counted: runs on the MODEL, not "this agent's runs"
    // (the app has no per-agent runner and must not imply one).
    expect(labelFor('Fresh Auditor')).toBe('1 run on claude · last passed · 100% pass of 1 decided run')
  })
})
