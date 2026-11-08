import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// A card speaks for ITS OWN work when the span log carries its name (seen
// 2026-11-09: five system tiles all read "73 runs on local · last failed ·
// 14% pass", one model-wide number wearing five names). A tile with no turn
// of its own keeps the model-wide line, which says what it counts.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  listVaultTree: vi.fn(async () => [] as string[]),
  readVaultFile: vi.fn(async () => null),
  writeVaultNote: vi.fn(async (_v: string, rel: string) => `/vault/${rel}`),
  deleteVaultFile: vi.fn(async () => null),
  readSpansTail: vi.fn(async () => [
    { name: 'model_call', type: 'model_call', status: 'ok', start: 1, span_id: 'a', attrs: { agent: 'planner', provider: 'local', is_local: true, is_real: true, tokens_in: 1000, tokens_out: 50 } },
    { name: 'tool_exec', type: 'tool_exec', status: 'ok', start: 2, span_id: 'b', attrs: { agent: 'planner', tool: 'vault_list', server: 'vault' } },
  ]),
}))
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native, storeGet: () => new Promise<string | null>(() => {}), storeSet: async () => {} }
})

function labelFor(name: string): string {
  const tile = [...document.querySelectorAll('.agent-tile')].find((el) => el.querySelector('.agent-tile__name')?.textContent === name)
  return tile?.querySelector('.agent-usage__label')?.textContent ?? ''
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('Agents page — a card speaks for its own turns', () => {
  it('the Planner tile reads its own turn, tokens and tool call; a tile with no turn keeps the model-wide line', async () => {
    await act(async () => {
      render(
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
    })
    await waitFor(() => expect(labelFor('Planner')).toBe('1 turn · last answered · 1,050 tokens · 1 tool call · all on your Mac'))
    expect(labelFor('Retrieval')).toBe('no runs yet')
  })
})
