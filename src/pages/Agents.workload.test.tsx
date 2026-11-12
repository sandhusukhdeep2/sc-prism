// The Agents page and the workload slider (2026-11-12).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

const native = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    isNative: vi.fn(() => true),
    resolveVaultDir: vi.fn(async () => '/vault'),
    listVaultTree: vi.fn(async () => [...files.keys()]),
    readVaultFile: vi.fn(async (_v: string, rel: string) => files.get(rel) ?? null),
    writeVaultNote: vi.fn(async (_v: string, rel: string, content: string) => {
      files.set(rel, content)
      return `/vault/${rel}`
    }),
    deleteVaultFile: vi.fn(async (_v: string, rel: string) => {
      files.delete(rel)
      return null
    }),
  }
})
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    ...native,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

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

// The workload slider (lib/workload.ts) re-seats the default team at run time
// WITHOUT rewriting the agents — so each card still shows the AI set on that
// agent. The page has to say when those are not where the seats will run.
const STORE = 'scprism.settings'
function seed(workload: string) {
  localStorage.setItem(
    STORE,
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false },
      ],
      workload,
    }),
  )
}

describe('Agents — the page says when the workload slider is re-seating the default team', () => {
  beforeEach(() => {
    localStorage.clear()
    native.files.clear()
  })
  afterEach(() => localStorage.clear())

  it('names the stop in force and where to change it', () => {
    seed('local-all')
    renderAgents()
    const note = screen.getByRole('note', { name: 'Workload slider' })
    expect(note.textContent).toContain('All local')
    expect(note.textContent).toContain('everything runs on this Mac')
    expect(screen.getByRole('link', { name: 'Change in Settings' })).toHaveAttribute('href', '/settings')
  })

  it('says nothing when every agent runs on its own AI', () => {
    seed('agents')
    renderAgents()
    expect(screen.queryByRole('note', { name: 'Workload slider' })).toBeNull()
  })
})
