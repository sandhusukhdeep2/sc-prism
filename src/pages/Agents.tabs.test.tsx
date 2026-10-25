// The Agents page leads with the CREW (Sukhdeep, dogfooding day one,
// 2026-08-29): on his install the team launcher and the manager panel
// rendered first and the actual agent cards were buried at the bottom —
// "manager agent blocking whole page". The page now opens on the Crew tab
// (toolbar + cards, nothing else); Team launch and Managers each live behind
// their own tab. Harness copied from Agents.vaultFiles.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

describe('Agents page tabs — crew first, nothing blocking it', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('opens on Crew: cards and toolbar visible, launcher and managers absent', () => {
    renderAgents()
    expect(screen.getByPlaceholderText(/search agents/i)).toBeInTheDocument()
    expect(screen.getByText(/system agents/i)).toBeInTheDocument()
    expect(screen.queryByText(/launch a team/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/manager agents/i)).not.toBeInTheDocument()
  })

  it('the Team tab shows the launcher and hides the crew grid', () => {
    renderAgents()
    fireEvent.click(screen.getByRole('tab', { name: /team/i }))
    expect(screen.getByText(/launch a team/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/search agents/i)).not.toBeInTheDocument()
  })

  it('the Managers tab shows the manager panel', () => {
    renderAgents()
    fireEvent.click(screen.getByRole('tab', { name: /managers/i }))
    expect(screen.getByText(/manager agents/i)).toBeInTheDocument()
    expect(screen.queryByText(/launch a team/i)).not.toBeInTheDocument()
  })
})
