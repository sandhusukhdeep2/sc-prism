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
    // A card can only speak for its own turns if the log it reads reaches back
    // far enough: with a 400-line tail three proven agents fell back to one
    // model-wide number two days after their proof (seen 2026-11-11).
    expect(native.readSpansTail).toHaveBeenCalledWith('/vault', 4000)
  })
})

// Seen in the installed app, 2026-11-14: every built-in card said "not yet
// proven" directly above "74 turns · last answered", with a button offering to
// "Prove on claude · costs cents" a seat the workload slider runs on the
// local model. A card says each thing once, and never against itself.
describe('Agents page — a card does not contradict itself', () => {
  const tileOf = (name: string) =>
    [...document.querySelectorAll('.agent-tile')].find(
      (el) => el.querySelector('.agent-tile__name')?.textContent === name,
    ) as HTMLElement

  async function mount() {
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
    await waitFor(() => expect(labelFor('Planner')).toContain('1 turn'))
  }

  it('a seat whose own turn was answered is proven by its work, and offers no Prove', async () => {
    await mount()
    const planner = tileOf('Planner')
    expect(planner.querySelector('.agent-tile__proof')).toHaveTextContent('proven ✓ in real runs')
    expect(planner.querySelector('.agent-tile__proof')).toHaveClass('is-proven')
    expect(planner.querySelector('.agent-tile__prove')).toBeNull()
  })

  it('a seat with no turn of its own is not yet proven, and Prove is offered', async () => {
    await mount()
    const retrieval = tileOf('Retrieval')
    expect(retrieval.querySelector('.agent-tile__proof')).toHaveTextContent('not yet proven')
    expect(retrieval.querySelector('.agent-tile__prove')).not.toBeNull()
  })

})
