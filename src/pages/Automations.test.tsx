import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ManagersState } from '../lib/managers'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Finding 1 of the 2026-08-09 honesty pass. /loop used to render a build-loop
// SIMULATOR whose plan came from a seeded RNG over a canned STEP_POOL, and whose
// state was never persisted — blank on every launch by construction. It now
// renders the user's REAL recurring work: manager jobs, the heartbeat, standing
// loops, and whatever is genuinely live. The managers store is projected in per
// test (its module reads localStorage once at import), so each case renders the
// page against a real-shaped ManagersState.

const MINUTE = 60_000
const now = Date.now()

const held = vi.hoisted(() => ({
  state: { managers: [], jobs: [], seeded: true } as unknown,
}))

vi.mock('../lib/managers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/managers')>()
  return {
    ...actual,
    useManagers: () => held.state,
    useManagerActions: () => ({
      ensure: () => {},
      setEnabled: () => {},
      addJob: () => {},
      removeJob: () => {},
      approve: () => {},
      reject: () => {},
      updateHeartbeat: () => {},
    }),
  }
})

const { default: Automations } = await import('./Automations')

const withJobs: ManagersState = {
  seeded: true,
  managers: [{ id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true }],
  jobs: [
    {
      id: 'job-1',
      managerId: 'mgr-local',
      title: 'Vault health',
      department: 'operations',
      prompt: 'check the vault',
      everyMinutes: 24 * 60,
      lastRun: now - 180 * MINUTE,
      runs: [{ at: now - 180 * MINUTE, ok: true, summary: 'all clear' }],
      kind: 'report',
    },
    {
      id: 'job-2',
      managerId: 'mgr-local',
      title: 'Cost & drift review',
      department: 'finance',
      prompt: 'review costs',
      everyMinutes: 30,
      lastRun: 0,
      runs: [],
      kind: 'report',
    },
  ],
}

function renderAutomations() {
  return render(
    <MemoryRouter initialEntries={['/loop']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Automations />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Automations — real recurring work, or an honest empty state', () => {
  beforeEach(() => {
    localStorage.clear()
    held.state = { managers: [], jobs: [], seeded: true }
  })
  afterEach(() => localStorage.clear())

  it('renders each REAL manager job with its cadence and last run', () => {
    held.state = withJobs
    renderAutomations()

    expect(screen.getByText('Vault health')).toBeInTheDocument()
    expect(screen.getByText('Cost & drift review')).toBeInTheDocument()
    // The manager that owns them, named from the real store.
    expect(screen.getAllByText('Local manager').length).toBeGreaterThan(0)
    // Cadence + last outcome, from the job's own record — never invented.
    expect(document.body.textContent).toMatch(/every 1d/)
    expect(document.body.textContent).toMatch(/every 30m/)
    expect(document.body.textContent).toMatch(/last ✓ 3h ago/)
    // A job that has genuinely never run says so instead of showing a time.
    expect(document.body.textContent).toMatch(/never ran/)
  })

  it('says a job will not run while its manager is OFF', () => {
    held.state = { ...withJobs, managers: [{ ...withJobs.managers[0], enabled: false }] }
    renderAutomations()
    expect(document.body.textContent).toMatch(/manager off — will not run/)
  })

  it('with nothing configured, says so AND where it would come from', () => {
    renderAutomations()

    expect(screen.getByText('Nothing is automated yet')).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/Standing jobs are created on the/)
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents')
    // The jobs card itself points at the same place rather than sitting blank.
    expect(document.body.textContent).toMatch(/they are created on the Agents page/)
  })

  it('claims nothing is running when the live-run registry is empty', () => {
    held.state = withJobs
    renderAutomations()
    expect(document.body.textContent).toMatch(/nothing is running/)
  })

  // Finding 3c: the clock ticked ONLY while `live.length > 0`, and nothing
  // running is this page's NORMAL state — so "last ✓ 2m ago" / "next in 5m"
  // froze at mount and quietly aged into wrong numbers while the user watched.
  it('keeps the ago/next labels ticking with nothing running', () => {
    vi.useFakeTimers()
    try {
      const base = Date.now()
      // A job that last ran just under a minute ago: its label must roll over
      // on its own, with no live run to drive a re-render.
      held.state = {
        ...withJobs,
        jobs: [
          {
            ...withJobs.jobs[0],
            lastRun: base - 20_000,
            runs: [{ at: base - 20_000, ok: true, summary: 'all clear' }],
          },
        ],
      } as ManagersState
      renderAutomations()
      expect(document.body.textContent).toMatch(/last ✓ just now/)

      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      // No live run, no re-render from anywhere else — the label moved because
      // the page keeps its own slow clock.
      expect(document.body.textContent).toMatch(/last ✓ 1m ago/)
    } finally {
      vi.useRealTimers()
    }
  })

  // Finding 5b: the deleted /loop composer was where one-off multi-step work
  // got started, and nothing was pointed at in its place.
  it('points one-off multi-step work at Work / Projects', () => {
    held.state = withJobs
    renderAutomations()
    expect(document.body.textContent).toMatch(/for a one-off piece of multi-step work/)
    expect(screen.getByRole('link', { name: 'project' })).toHaveAttribute('href', '/projects')
  })

  // Finding 5a: a parked job waits on the APPROVALS page, where the
  // Approve/Reject buttons actually are — not on the page that configures jobs.
  it('sends a parked job to the approvals gate, not the Agents page', () => {
    held.state = {
      ...withJobs,
      jobs: [{ ...withJobs.jobs[0], kind: 'dispatch', approval: 'ask', pendingSince: now - 1000 }],
    } as ManagersState
    renderAutomations()
    expect(document.body.textContent).toMatch(/awaiting your OK on the Approvals page/)
  })
})

// The fabricated plan generator must not come back — not on this page, not in
// the store, not anywhere in src/ (this file's own assertions excepted).
describe('the loop simulator is gone from the source tree', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full)
    }
  }
  walk('src')

  const offendersMatching = (re: RegExp, allowProseIn: string[] = []) =>
    files.filter(
      (f) => !allowProseIn.some((a) => f.endsWith(a)) && re.test(readFileSync(f, 'utf8')),
    )

  it('no STEP_POOL / buildPlan symbol survives anywhere in src/', () => {
    expect(offendersMatching(/\bSTEP_POOL\b|\bbuildPlan\b/)).toEqual([])
  })

  it('no loop state slice (state.loop / LoopState / runLoop) survives in src/', () => {
    // The Automations page's header comment explains what was deleted; that is
    // prose about the removal, not the removed code.
    expect(offendersMatching(/\bstate\.loop\b|\bLoopState\b|\brunLoop\b/, ['Automations.tsx'])).toEqual([])
  })

  it('the mock prefilled command ("Build the vault server per spec T1") is gone', () => {
    expect(offendersMatching(/per spec T1/)).toEqual([])
  })
})
