// Settings → Routing & workload: the two lines under the token budget say
// what they count. Seen in the installed app, 2026-11-14: "3,573,470 tokens
// today, across 108 runs" (neither was today's) over "38% on your Mac" (a
// share of RUNS, under a line about tokens, beside a rail saying "67% local").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=routing']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const run = (id: string, at: string, target: 'local' | 'cloud', tokensIn: number, tokensOut: number) => ({
  taskId: id,
  task: 'x',
  response: '',
  route: { target, model: 'm', via: '', reason: '', routeLabel: '' },
  tier1: { tests: '', lint: true, build: true, pass: true },
  tier2: { evalScore: 0.9, passed: true, judge: 'j', trajectory: 't' },
  tokensIn,
  tokensOut,
  cost: 0,
  durationMs: 1,
  modelRoute: '',
  hooks: { blocked: 0, passed: true },
  writeback: { path: '', validated: true, committed: true },
  passed: true,
  at,
})

describe('Settings — the usage lines say what they count', () => {
  beforeEach(() => {
    localStorage.clear()
    const today = new Date()
    const at = (h: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, 0).toISOString()
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60_000).toISOString()
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: { universal: [] },
        verdicts: [
          run('a', at(0), 'local', 1000, 200),
          run('b', at(0), 'cloud', 300, 50),
          run('c', lastWeek, 'cloud', 900_000, 90_000),
        ],
        // The store's running total — every run it ever saw, never reset.
        stats: { tokensToday: 991_550, costToday: 0, tier1Saves: 0, localSharePct: 33, evalAvg: 0 },
      }),
    )
  })
  afterEach(() => localStorage.clear())

  it('"today" counts today’s runs and their tokens — not everything on record', () => {
    renderSettings()
    expect(screen.getByText('1,550 tokens today, across 2 runs')).toBeInTheDocument()
    expect(screen.queryByText(/991,550/)).not.toBeInTheDocument()
  })

  it('the split under it says it is a share of runs', () => {
    renderSettings()
    expect(screen.getByText(/of runs on your Mac/)).toBeInTheDocument()
  })
})
