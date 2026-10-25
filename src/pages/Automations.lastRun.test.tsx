// The job row's LAST RUN — 2026-08-16 honesty pass, Finding 2a.
//
// MOVED 2026-08-19. These assertions used to render the Work page, where a
// panel called "Up next" carried them. The v2 rebuild moved recurring work off
// Work and onto Automations, which is the page that owns it — so the tests
// follow the rows rather than being deleted with the panel. What is under test
// is unchanged, and is the thing that matters: a job states its REAL newest run
// record, and never rounds a failure up to a pass.
//
// The finding was INVISIBILITY, not breakage: the manager driver genuinely
// fires (this user's store holds 22 real run records, with the reports on
// disk), but nothing on the Work page ever said so. The live card exists only
// for the few minutes of the run, `finishedRuns` is deliberately never
// persisted, and he restarts the app constantly — so a job that had run 11
// times read exactly like a job that had never run once: "in 12h".
//
// The row now states the job's REAL newest run record, which IS persisted.
// These tests seed the managers store on disk the way the app stores it and
// let the real module load it — no mocked hook, so the load → sanitize → row
// path is the one under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ManagersState } from '../lib/managers'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function seed(state: ManagersState): void {
  localStorage.setItem('scprism.managers', JSON.stringify(state))
}

/** Fresh module registry: the managers store loads its state at import time. */
async function renderJobs() {
  vi.resetModules()
  const { SettingsProvider } = await import('../lib/settings')
  const { ConnectivityProvider } = await import('../lib/connectivity')
  const { OnboardingProvider } = await import('../lib/onboarding')
  const { AppProvider } = await import('../store/AppStore')
  const { default: Automations } = await import('./Automations')
  const view = render(
    <MemoryRouter initialEntries={['/automations']}>
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
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

/** The manager-job row whose title is `title`, as rendered text. */
function rowText(title: string): string {
  const rows = Array.from(document.querySelectorAll('.mgrs__job'))
  const row = rows.find((r) => r.querySelector('.mgrs__jobtitle')?.textContent === title)
  return row?.textContent ?? ''
}

const now = Date.now()

const withJobs: ManagersState = {
  seeded: true,
  managers: [{ id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true }],
  jobs: [
    {
      id: 'job-ran',
      managerId: 'mgr-local',
      title: 'Vault health',
      department: 'operations',
      prompt: 'check the vault',
      everyMinutes: 12 * 60,
      lastRun: now - 5 * HOUR,
      // A REAL recorded run — the kind that has been accumulating unseen.
      runs: [{ at: now - 5 * HOUR, ok: true, summary: 'all clear' }],
      kind: 'report',
    },
    {
      id: 'job-never',
      managerId: 'mgr-local',
      title: 'Cost & drift review',
      department: 'finance',
      prompt: 'review costs',
      everyMinutes: 7 * 24 * 60,
      lastRun: 0,
      runs: [],
      kind: 'report',
    },
  ],
}

describe('Up next — the last run the job really had', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('states the real outcome and age of the newest run, alongside the next due time', async () => {
    seed(withJobs)
    await renderJobs()

    const text = rowText('Vault health')
    expect(text).toContain('last ✓ 5h ago')
    expect(text).toContain('next in 7h')
  })

  it('a FAILED last run says so — the row never rounds a failure up to a pass', async () => {
    seed({
      ...withJobs,
      jobs: [
        {
          ...withJobs.jobs[0],
          runs: [{ at: now - 45 * MINUTE, ok: false, summary: 'provider not connected' }],
          lastRun: now - 45 * MINUTE,
        },
      ],
    })
    await renderJobs()

    expect(rowText('Vault health')).toContain('last ✕ 45m ago')
  })

  it('says NOTHING about a last run for a job that has never run', async () => {
    seed(withJobs)
    await renderJobs()

    const text = rowText('Cost & drift review')
    expect(text).not.toMatch(/last [✓✕]/)
    expect(text).not.toContain('ago')
    expect(text).toContain('next due now') // only the fact it does have
  })
})
