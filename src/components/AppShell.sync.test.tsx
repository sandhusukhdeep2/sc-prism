// The vault syncs run at APP START (Sukhdeep, 2026-08-29 evening: skills
// files were still missing because the migration only fired on a Skills page
// visit he never made). The shell mounts once per launch, so agents AND
// skills sync there — pages keep their own idempotent syncs for freshness,
// but no folder ever waits for a page visit again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

const spies = vi.hoisted(() => ({
  syncVaultAgents: vi.fn(async () => 0),
  syncVaultSkills: vi.fn(async () => 0),
}))
vi.mock('../lib/agents', async (orig) => {
  const actual = await orig<typeof import('../lib/agents')>()
  return { ...actual, syncVaultAgents: spies.syncVaultAgents }
})
vi.mock('../lib/skills', async (orig) => {
  const actual = await orig<typeof import('../lib/skills')>()
  return { ...actual, syncVaultSkills: spies.syncVaultSkills }
})
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

describe('AppShell syncs the vault folders on launch', () => {
  beforeEach(() => {
    localStorage.clear()
    spies.syncVaultAgents.mockClear()
    spies.syncVaultSkills.mockClear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('mounting the shell runs both syncs without any page visit', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SettingsProvider>
          <ConnectivityProvider>
            <OnboardingProvider>
              <AppProvider>
                <Routes>
                  <Route element={<AppShell />}>
                    <Route index element={<div>home</div>} />
                  </Route>
                </Routes>
              </AppProvider>
            </OnboardingProvider>
          </ConnectivityProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(spies.syncVaultAgents).toHaveBeenCalled()
      expect(spies.syncVaultSkills).toHaveBeenCalled()
    })
  })
})
