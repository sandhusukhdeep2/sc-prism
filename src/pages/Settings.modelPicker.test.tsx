import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import type { EngineSpan } from '../lib/nativeEngine'
import type { Verdict } from '../engine/types'

// CHOOSING A LOCAL MODEL, ON EVIDENCE (2026-08-17).
//
// He ran the SLOWEST of his three local models for days (115s p50) while a
// faster, stronger one sat unused (9.8s p50), because the picker was a bare
// list of ids. And a model that could not LOAD at all presented as "the
// provider is unreachable" — after he had already selected it.
//
// These tests hold the honesty rules at the RENDERED level: measured numbers
// only, each naming its source; an unrun model says so and is not ranked; a
// model that cannot load says so BEFORE it is chosen; the recommendation names
// its basis and disappears when the evidence does.

const FAST = 'gemma-4-26b-a4b-it-4bit'
const SLOW = 'Qwen3.8-27B-4bit'
const UNRUN = 'glm-4.5-air-6bit'

const spans: EngineSpan[] = []
let statusBody: string | null = null
let models: string[] = []

function call(model: string, ms: number, tokensOut?: number): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    duration_ms: ms,
    start: 1,
    attrs: { route: 'local', is_local: true, model, ...(tokensOut ? { tokens_out: tokensOut } : {}) },
  }
}

function verdict(model: string, evalScore: number): Verdict {
  return {
    taskId: `t-${model}-${evalScore}`,
    task: 'do the thing',
    route: { target: 'local', model, via: '', reason: '', routeLabel: '' },
    tier1: { tests: '1/1', lint: true, build: true, pass: true },
    tier2: { evalScore, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 1,
    tokensOut: 1,
    cost: 0,
    durationMs: 1,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed: true,
    native: {
      hooksFired: [],
      hookDecisions: [],
      blocks: 0,
      approvals: 0,
      memoryInjected: 0,
      disclosed: [],
      rejectedWrites: 0,
      cacheHits: 0,
      cacheMisses: 0,
      spansPath: '/vault/spans.jsonl',
      models_used: [`local · ${model}`],
    },
  }
}

/** Seed the durable session the picker reads its judged runs from. */
function seedVerdicts(list: Verdict[]) {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [] },
      verdicts: list,
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
    }),
  )
}

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readSpansTail: async () => spans,
    providerGetJson: async () => statusBody,
    checkExtensions: async () => ({ python: true, git: true, node: true }),
    readMcpServers: async () => [],
    readMcpApprovals: async () => ({ require: [] as string[], granted: [] as string[] }),
    readTrainingCount: async () => 0,
    runNativeMcpList: async () => [],
    withVaultGranted: async <T,>(_v: string, fn: () => Promise<T>) => fn(),
  }
})

vi.mock('../lib/settings', async () => {
  const actual = await vi.importActual<typeof import('../lib/settings')>('../lib/settings')
  return { ...actual, listProviderModels: async () => models }
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const row = (id: string) => screen.getByTestId(`local-model-${id}`).textContent ?? ''

describe('Settings — the local model picker', () => {
  beforeEach(() => {
    localStorage.clear()
    spans.length = 0
    models = [SLOW, FAST, UNRUN]
    // The real machine's own report: a 24.96 GB ceiling, nothing resident yet.
    statusBody = JSON.stringify({
      load_seconds_per_gb_estimate: 1.6,
      memory: { final_ceiling: 24.96, current_model_memory: 0 },
      models: [
        { id: FAST, size_gb: 15.2 },
        { id: SLOW, size_gb: 21.36 },
        { id: UNRUN, size_gb: 42.36 },
      ],
    })
  })
  afterEach(() => localStorage.clear())

  it('renders each model’s measured speed and judged quality, from real evidence', async () => {
    spans.push(call(FAST, 9_800, 280), call(FAST, 9_800, 280), call(SLOW, 115_000, 300))
    seedVerdicts([verdict(SLOW, 0.81), verdict(SLOW, 0.81), verdict(FAST, 0.6)])
    renderSettings()

    await screen.findByTestId(`local-model-${FAST}`)
    expect(row(FAST)).toContain('9.8s a call (p50)')
    expect(row(FAST)).toContain('tok/s')
    expect(row(FAST)).toContain('0.60 mean Tier-2 judge score over 1 run')
    expect(row(FAST)).toContain('fastest here')

    expect(row(SLOW)).toContain('115s a call (p50)')
    expect(row(SLOW)).toContain('0.81 mean Tier-2 judge score over 2 runs')
    expect(row(SLOW)).toContain('highest judged quality')
  })

  it('an unrun model shows the honest empty state and is not ranked', async () => {
    spans.push(call(FAST, 9_800, 280), call(SLOW, 115_000, 300))
    seedVerdicts([verdict(SLOW, 0.81)])
    renderSettings()

    await screen.findByTestId(`local-model-${UNRUN}`)
    expect(row(UNRUN)).toContain('no runs recorded yet')
    expect(row(UNRUN)).toContain('not ranked')
    // No speed and no quality number may appear on a model he never ran.
    expect(row(UNRUN)).not.toMatch(/tok\/s/)
    expect(row(UNRUN)).not.toMatch(/mean Tier-2 judge score over \d/)
  })

  it('sleep artefacts (>15 min) are excluded from the measured speed', async () => {
    // The Mac slept through a call: a 13-hour span sits next to ordinary ones.
    spans.push(call(SLOW, 65_000, 300), call(SLOW, 46_863_000, 300), call(SLOW, 67_000, 300))
    renderSettings()

    await screen.findByTestId(`local-model-${SLOW}`)
    expect(row(SLOW)).toContain('over 2 runs here')
    expect(row(SLOW)).not.toMatch(/46863|13011s/)
  })

  it('says a model won’t load BEFORE it is selected, with the server’s numbers', async () => {
    // 42.36 GB against a 24.96 GB ceiling: the server would answer 507, which
    // the app used to report as "the provider is unreachable" — after the fact.
    renderSettings()
    await screen.findByTestId(`local-model-${UNRUN}`)
    expect(row(UNRUN)).toContain("won't load right now")
    expect(row(UNRUN)).toContain('42 GB needed')
    expect(row(UNRUN)).toContain('25 GB ceiling')
    // And it is never offered as the recommendation.
    expect(screen.queryByTestId('local-model-recommendation')?.textContent ?? '').not.toContain(UNRUN)
  })

  it('states the load cost as the server’s own estimate, labelled as one', async () => {
    renderSettings()
    await screen.findByTestId(`local-model-${FAST}`)
    expect(row(FAST)).toContain('about 24s on the first call')
    expect(row(FAST)).toContain("server's own estimate")
    expect(row(FAST)).toContain('not a measurement')
  })

  it('recommends on a named basis when the evidence supports one', async () => {
    spans.push(call(FAST, 9_800, 280), call(SLOW, 115_000, 300))
    seedVerdicts([verdict(SLOW, 0.81), verdict(FAST, 0.6)])
    renderSettings()

    const rec = await screen.findByTestId('local-model-recommendation')
    expect(rec.textContent).toContain(SLOW)
    expect(rec.textContent).toContain('highest judged quality')
    expect(rec.textContent).toContain('0.81')
  })

  it('recommends NOTHING when nothing has been measured, and says so', async () => {
    renderSettings()
    await screen.findByTestId(`local-model-${FAST}`)
    expect(screen.queryByTestId('local-model-recommendation')).toBeNull()
    expect(screen.getByTestId('local-model-picker').textContent).toContain('nothing to recommend')
  })

  it('shows no memory verdict at all when the server reports no status', async () => {
    statusBody = null
    renderSettings()
    await screen.findByTestId(`local-model-${FAST}`)
    expect(row(FAST)).not.toMatch(/won't load|fits right now/)
    expect(screen.getByTestId('local-model-picker').textContent).toContain(
      'did not report its memory status',
    )
  })
})
