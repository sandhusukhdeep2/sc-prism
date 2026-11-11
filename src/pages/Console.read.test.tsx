import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import type { Dashboard } from '../engine/types'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// 2026-11-11 tour: the Console's cards held real numbers a reader could not
// read — burn as three blocks with no amounts, a 383-point eval line drawn as
// a band, and zeros in alarm red. These pin the redrawn cards.
const DASH: Dashboard = {
  vault: '/vault',
  runs: 400,
  run_series: [],
  total_tokens: 279173,
  total_cost: 0.42,
  cost_by_model: {
    'claude-sonnet-4': { calls: 20, tokens_in: 60000, tokens_out: 9833, tokens: 69833, cost: 0.4, provider: 'claude-cli' },
    'qwen3-local': { calls: 31, tokens_in: 200000, tokens_out: 9340, tokens: 209340, cost: 0.02, provider: 'local' },
  },
  cost_by_operation: {},
  token_burn_by_time: {},
  hooks: {
    dispatch: { fires: 51, total_ms: 35_042_000, avg_ms: 687_098, blocks: 0, errors: 0 },
    stop: { fires: 51, total_ms: 510, avg_ms: 10, blocks: 0, errors: 2 },
  },
  eval_trend: Array.from({ length: 383 }, (_, i) => ({ run_id: `r${i}`, task_id: `t${i}`, start: i, eval_score: i % 2 ? 0.9 : 0.6 })),
  cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
  drift: [],
  healthy: false,
}

vi.mock('../lib/nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    nativeDashboard: async () => DASH,
    readNativeDashboard: async () => ({ kind: 'ok', dash: DASH }),
  }
})

import Console from './Console'

function renderConsole() {
  return render(
    <MemoryRouter initialEntries={['/console']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Console />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Console — the numbers can be read', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('writes each provider’s amount and share beside its bar', async () => {
    renderConsole()
    const local = (await screen.findByText('local')).closest('.console__burnrow') as HTMLElement
    expect(local).toHaveTextContent('209.3K')
    expect(local).toHaveTextContent('75%')
    const claude = screen.getByText('claude').closest('.console__burnrow') as HTMLElement
    expect(claude).toHaveTextContent('69.8K')
    expect(claude).toHaveTextContent('25%')
    // The bar is a length along one axis; the largest provider fills it.
    expect(local.querySelector<HTMLElement>('.console__bar')!.style.width).toBe('100%')
    expect(claude.querySelector<HTMLElement>('.console__bar')!.style.width).toBe('33%')
  })

  it('does not paint a zero in alarm red, and still paints a real error count', async () => {
    renderConsole()
    await screen.findByText('local')
    const valueOf = (label: string) => screen.getByText(label).previousElementSibling as HTMLElement
    expect(valueOf('blocked')).toHaveTextContent('0')
    expect(valueOf('blocked').className).not.toMatch(/--red/)
    expect(valueOf('hook errors')).toHaveTextContent('2')
    expect(valueOf('hook errors').className).toMatch(/--red/)
  })

  it('draws a long eval history as a line of at most 48 points', async () => {
    renderConsole()
    await screen.findByText('local')
    const d = document.querySelector('.console__evalline')!.getAttribute('d') ?? ''
    const points = d.match(/[ML]/g) ?? []
    expect(points.length).toBeGreaterThan(1)
    expect(points.length).toBeLessThanOrEqual(48)
    expect(document.body.textContent).toMatch(/383 verdicts/)
  })
})

// A SENTENCE IS NEVER MONO (clear-room spec §B), applied to the Console.
describe('Console — sentences are text, figures are mono', () => {
  const src = readFileSync('src/pages/Console.tsx', 'utf8')
  const css = readFileSync('src/pages/Console.css', 'utf8')
  const SENTENCES = ['console__foot', 'console__evalnote', 'console__note', 'console__statslink', 'console__burnname', 'console__exportnote', 'console__metrics']
  for (const cls of SENTENCES) {
    it(`${cls} is not monospace`, () => {
      const withMono = new RegExp(`${cls}(?![\\w-])[^"'\`\\n]*\\bmono\\b|\\bmono\\b[^"'\`\\n]*${cls}(?![\\w-])`)
      expect(src).not.toMatch(withMono)
    })
  }
  it('amounts keep their monospace', () => {
    expect(src).toMatch(/console__burnamt mono/)
    expect(src).toMatch(/console__metric-val mono/)
  })
  it('the export caption is a caption, not a box that looks like a field', () => {
    expect(src).not.toMatch(/console__daterange/)
    expect(css).not.toMatch(/console__daterange/)
  })
  it('cards are as tall as what they hold, and stack in one column in a narrow window', () => {
    expect(css).toMatch(/\.console__grid \{[^}]*grid-auto-rows: auto/)
    expect(css).not.toMatch(/grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/)
    expect(css).toMatch(/@media \(max-width: 980px\) \{\s*\.console__grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(css).toMatch(/\.console__metrics \{[^}]*flex-wrap: wrap/)
  })
})
