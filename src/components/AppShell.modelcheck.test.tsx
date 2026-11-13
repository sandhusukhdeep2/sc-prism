// The day's model check runs from the shell — once per launch day, with no
// page visit — and what it changed is said once, by the app, in the Manager's room
// (the owner, 2026-11-14: "every time when we start working for the day on
// this software, check the new available AIs models … Always prefer a new
// one, the greatest one").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { saveModelCheck } from '../lib/modelCheckRun'

const spies = vi.hoisted(() => ({
  probeCli: vi.fn(async () => ({ ok: true, reply: 'ok', error: '' })),
  measureWorkload: vi.fn(() => ({ stop: null, why: '', quality: null })),
}))
vi.mock('../lib/workloadMeasure', () => ({ measureWorkload: spies.measureWorkload }))
vi.mock('../lib/agents', async (orig) => {
  const actual = await orig<typeof import('../lib/agents')>()
  return { ...actual, syncVaultAgents: async () => 0 }
})
vi.mock('../lib/skills', async (orig) => {
  const actual = await orig<typeof import('../lib/skills')>()
  return { ...actual, syncVaultSkills: async () => 0 }
})
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    storeGet: async () => null,
    storeSet: async () => {},
    probeCli: spies.probeCli,
    checkCli: async () => '/usr/local/bin/claude',
  }
})

const STORE = 'scprism.settings'
const model = () =>
  (JSON.parse(localStorage.getItem(STORE) ?? '{}') as { providers?: { id: string; model?: string }[] }).providers?.find(
    (p) => p.id === 'claude-cli',
  )?.model

function seed(extra: Record<string, unknown> = {}) {
  // Setup is finished: the shell renders the app, not the redirect to /welcome.
  localStorage.setItem(
    'scprism.onboarding',
    JSON.stringify({ completedSteps: ['welcome', 'providers', 'companion', 'vault', 'interview', 'review'], done: true }),
  )
  localStorage.setItem(
    STORE,
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude Code', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true, model: 'opus' },
      ],
      ...extra,
    }),
  )
}

// The Manager's room, reduced to the lines the APP itself has posted.
function AppLines() {
  const { state } = useApp()
  return (
    <ul>
      {(state.threads.universal ?? []).map((m) => (m.kind === 'notice' ? <li key={m.id}>{m.text}</li> : null))}
    </ul>
  )
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<div>home<AppLines /></div>} />
                </Route>
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('AppShell runs the day’s model check', () => {
  beforeEach(() => {
    localStorage.clear()
    spies.probeCli.mockClear()
  })
  afterEach(() => localStorage.clear())

  it('moves the primary to its plan’s top model once it answers, and says so', async () => {
    seed()
    renderShell()
    await waitFor(() => expect(spies.probeCli).toHaveBeenCalledWith('claude', undefined, 'fable'))
    await waitFor(() => expect(model()).toBe('fable'))
    expect(
      await screen.findByText(
        'Today’s model check — Claude Code now runs on fable (was opus). Change it in Settings → Your AIs.',
      ),
    ).toBeInTheDocument()
  })

  it('does nothing on a second launch the same day', async () => {
    seed()
    saveModelCheck({ catalog: {}, last: { at: Date.now(), moves: [], fresh: [], skipped: [] } })
    renderShell()
    await screen.findByText('home')
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/model check/)).not.toBeInTheDocument()
    expect(spies.probeCli.mock.calls.some((c) => (c as unknown[])[2] === 'fable')).toBe(false)
    expect(model()).toBe('opus')
  })

  it('with moving switched off it leaves the model alone', async () => {
    seed({ autoNewestModel: false })
    renderShell()
    await screen.findByText('home')
    await new Promise((r) => setTimeout(r, 30))
    expect(model()).toBe('opus')
  })
})
