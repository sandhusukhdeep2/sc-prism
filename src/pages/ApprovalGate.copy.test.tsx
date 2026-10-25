import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ManagersState } from '../lib/managers'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Finding 5a. The gate's empty state promised "A manager job set to 'ask me
// first' parks here before it runs" — which the DRIVER contradicts:
// `nextDispatchAction` returns 'run' for a report job regardless of its approval
// setting. A user whose three jobs are all report jobs on "ask me first" was
// therefore told to expect a park that can never arrive, and read the page as
// broken. The copy must describe the real rule (`jobCanPark`).

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

const { default: ApprovalGate } = await import('./ApprovalGate')

const manager = { id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true }
const job = (over: Record<string, unknown>) => ({
  id: 'j1',
  managerId: 'mgr-local',
  title: 'Vault health',
  department: 'operations',
  prompt: 'check the vault',
  everyMinutes: 60,
  lastRun: 0,
  runs: [],
  kind: 'report',
  approval: 'ask',
  ...over,
})

function renderGate() {
  return render(
    <MemoryRouter initialEntries={['/approval']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <ApprovalGate />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('ApprovalGate — the empty state states the rule the driver follows', () => {
  beforeEach(() => {
    localStorage.clear()
    held.state = { managers: [], jobs: [], seeded: true }
  })
  afterEach(() => localStorage.clear())

  it('does not promise that any "ask me first" job parks here', () => {
    held.state = { seeded: true, managers: [manager], jobs: [job({})] } as ManagersState
    renderGate()
    expect(screen.getByText('No approvals waiting')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(
      /A manager job set to “ask me first” parks here before it runs/,
    )
    expect(document.body.textContent).toMatch(/Only work and team jobs park for approval/)
  })

  it('tells a report-jobs-only user that NOTHING of theirs can park', () => {
    held.state = {
      seeded: true,
      managers: [manager],
      jobs: [job({ id: 'j1' }), job({ id: 'j2' }), job({ id: 'j3' })],
    } as ManagersState
    renderGate()
    expect(document.body.textContent).toMatch(/all 3 of your jobs are report jobs/)
    expect(document.body.textContent).toMatch(/none of them can park here/)
  })

  it('counts the jobs that genuinely can park when some exist', () => {
    held.state = {
      seeded: true,
      managers: [manager],
      jobs: [job({ id: 'j1' }), job({ id: 'j2', kind: 'dispatch' })],
    } as ManagersState
    renderGate()
    expect(document.body.textContent).toMatch(/1 of your 2 jobs can park here/)
  })

  it('says nothing about job counts when there are no jobs at all', () => {
    renderGate()
    expect(document.body.textContent).not.toMatch(/can park here/)
    expect(document.body.textContent).toMatch(/Only work and team jobs park for approval/)
  })
})
