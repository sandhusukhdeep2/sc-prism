import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import type { Dashboard } from '../engine/types'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// 2026-11-11: the cost card drew THIS SESSION's verdict costs while the trend
// sentence under it read the engine's run series, and the caption said "this
// session's verdicts" either way. One card, two series. The line is now drawn
// from the series the sentence reads, and the caption names that series.
const RUNS = 600
const DASH: Dashboard = {
  vault: '/vault',
  runs: RUNS,
  run_series: Array.from({ length: RUNS }, (_, i) => ({
    run_id: `r${i}`,
    task_id: `t${i}`,
    start: i,
    tokens: 100,
    cost: 0.01 + (i % 5) * 0.01,
    eval_score: null,
    passed: null,
    cache_hit_rate: 0,
    model_calls: 1,
  })),
  total_tokens: 0,
  total_cost: 0,
  cost_by_model: {},
  cost_by_operation: {},
  token_burn_by_time: {},
  hooks: {},
  eval_trend: [],
  cache: { total_calls: 0, hits: 0, misses: 0, hit_rate: 0, by_kind: {}, warmth: 0, warmth_curve: [] },
  drift: [],
  healthy: true,
} as Dashboard

vi.mock('../lib/nativeEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    nativeDashboard: async () => DASH,
    readNativeDashboard: async () => ({ kind: 'ok', dash: DASH }),
    readSpansTail: async () => [],
    runNativeOkf: async () => null,
  }
})

const { default: Memory } = await import('./Memory')

function renderMemory() {
  return render(
    <MemoryRouter initialEntries={['/memory']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Memory />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Memory — the cost card draws the series its sentence reads', () => {
  it('draws the engine’s recorded runs, as a line of at most 48 points, and says so', async () => {
    renderMemory()
    await waitFor(() => expect(screen.getByText(/all 600 recorded runs/)).toBeInTheDocument())
    const d = document.querySelector('.mem-cost__line')!.getAttribute('d') ?? ''
    expect((d.match(/[ML]/g) ?? []).length).toBe(48)
    // With no verdict in this session the old line was the flat "no data" one.
    expect(d).not.toBe('M0 20 L220 20')
    expect(document.body.textContent).not.toMatch(/this session's verdicts/)
  })
})

// A SENTENCE IS NEVER MONO (clear-room spec §B) — the Memory page's captions
// were set in monospace by the stylesheet; figures keep it.
describe('Memory — captions are text, figures are mono', () => {
  const css = readFileSync('src/pages/Memory.css', 'utf8')
  const rule = (sel: string) =>
    css.match(new RegExp('(^|\\n)' + sel.replace(/[.]/g, '\\.') + ' \\{[^}]*\\}'))?.[0] ?? ''
  for (const sel of ['.tier__label', '.tier__meta', '.mem-budget__ok', '.mem-budget__note', '.mem-share__illustrative', '.mem-legend', '.mem-ft__meta']) {
    it(`${sel} is not monospace`, () => {
      expect(rule(sel), sel).not.toBe('')
      expect(rule(sel), sel).not.toMatch(/font-mono/)
    })
  }
  it('figures keep their monospace', () => {
    for (const sel of ['.mem-budget__val', '.mem-saves__num', '.mem-ft__val']) {
      expect(rule(sel), sel).toMatch(/font-mono/)
    }
  })
  it('the count of recorded runs is labelled as the Work page labels it', async () => {
    // The same number read "recorded all time" on Work and "this session" here;
    // it is the durable record, which outlives a session.
    renderMemory()
    await waitFor(() => expect(screen.getByText(/^runs? recorded all time$/)).toBeInTheDocument())
    expect(readFileSync('src/pages/Memory.tsx', 'utf8')).not.toMatch(/recorded this session/)
  })
  it('the page makes no promise about next week’s cost', () => {
    expect(readFileSync('src/pages/Memory.tsx', 'utf8')).not.toMatch(/lowers cost every week/)
  })
  it('a card’s hint is a sentence, set as text', () => {
    expect(readFileSync('src/components/Card.tsx', 'utf8')).not.toMatch(/card__hint mono/)
  })
})
