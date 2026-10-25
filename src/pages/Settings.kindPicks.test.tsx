import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import type { EngineSpan } from '../lib/nativeEngine'
import type { Verdict } from '../engine/types'
import { WORK_KINDS } from '../lib/localModelPick'

// THE BEST LOCAL MODEL FOR EACH KIND OF WORK (2026-08-29), rendered.
//
// The measured rows say what each model IS; these lines say what each is FOR —
// speed-weighted retrieval/research, quality-weighted implementer/reviewer,
// balanced chat — each line citing the numbers behind it, with a one-click way
// to adopt the pick. Rendered ONLY when evidence exists: with nothing measured
// there is nothing to suggest, so there is no block at all.
//
// And the 2026-08-28 lesson at the rendered level: when the picks would need
// two models the server's own figures say cannot co-load, every line names the
// single compromise and the callout states the arithmetic.

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
    taskId: `t-${model}-${evalScore}-${Math.random()}`,
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

/** The server's report with a chosen ceiling — sizes are the real machine's. */
function report(ceilingGb: number): string {
  return JSON.stringify({
    load_seconds_per_gb_estimate: 1.6,
    memory: { final_ceiling: ceilingGb, current_model_memory: 0 },
    models: [
      { id: FAST, size_gb: 15.2 },
      { id: SLOW, size_gb: 21.36 },
      { id: UNRUN, size_gb: 42.36 },
    ],
  })
}

const line = (kind: string) => screen.getByTestId(`local-kind-${kind}`).textContent ?? ''

describe('Settings — the best local model for each kind of work', () => {
  beforeEach(() => {
    localStorage.clear()
    spans.length = 0
    models = [SLOW, FAST, UNRUN]
    // Roomy by default so the per-kind split is visible; the collapse test
    // tightens it to the real machine's 24.96 GB.
    statusBody = report(48)
    spans.push(call(FAST, 9_800, 280), call(FAST, 9_800, 280), call(SLOW, 115_000, 300), call(SLOW, 115_000, 300))
    seedVerdicts([verdict(SLOW, 0.81), verdict(SLOW, 0.81), verdict(FAST, 0.6)])
  })
  afterEach(() => localStorage.clear())

  it('renders one line per kind, above the measured rows, each citing its numbers', async () => {
    renderSettings()
    await screen.findByTestId('local-kind-picks')
    for (const kind of WORK_KINDS) expect(screen.getByTestId(`local-kind-${kind}`)).toBeInTheDocument()

    // Speed-weighted kinds name the fast model and the measured figure.
    expect(line('retrieval')).toContain(FAST)
    expect(line('retrieval')).toContain('fastest measured here')
    expect(line('retrieval')).toContain('29 tok/s over 2 runs')
    // Quality-weighted kinds name the judged one and the judged figure.
    expect(line('implementer')).toContain(SLOW)
    expect(line('implementer')).toContain('highest judged quality (0.81 over 2 runs)')

    // The block sits ABOVE the measured rows it is derived from.
    const picks = screen.getByTestId('local-kind-picks')
    const firstRow = screen.getByTestId(`local-model-${FAST}`)
    expect(picks.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('adopts a pick through the existing provider path, and then says "in use"', async () => {
    renderSettings()
    await screen.findByTestId('local-kind-picks')

    fireEvent.click(screen.getByRole('button', { name: `Use ${SLOW} for implementer` }))

    // The provider's configured model changed — the measured row confirms it.
    await waitFor(() =>
      expect(screen.getByTestId(`local-model-${SLOW}`).textContent).toContain('in use'),
    )
    // And the line that suggested it now shows the state instead of a button.
    await waitFor(() => expect(line('implementer')).toContain('in use'))
    expect(screen.queryByRole('button', { name: `Use ${SLOW} for implementer` })).toBeNull()
  })

  it('renders NOTHING when nothing is measured — no evidence, no suggestions', async () => {
    spans.length = 0
    seedVerdicts([])
    renderSettings()
    await screen.findByTestId(`local-model-${FAST}`)
    expect(screen.queryByTestId('local-kind-picks')).toBeNull()
  })

  it('collapses a mix the server cannot hold and states its own figures', async () => {
    // The real machine: either model fits alone under 24.96 GB, never both —
    // the split that errored live on 2026-08-28 once Qwen went resident.
    statusBody = report(24.96)
    renderSettings()
    await screen.findByTestId('local-kind-picks')

    const note = screen.getByTestId('local-kind-memory').textContent ?? ''
    expect(note).toContain('15 GB')
    expect(note).toContain('21 GB')
    expect(note).toContain('25 GB ceiling')
    expect(note).toContain("the server's own figures")
    expect(note).toContain('one model at a time')
    // Every kind now names the same compromise model.
    for (const kind of WORK_KINDS) expect(line(kind)).toContain(FAST)
    expect(line('implementer')).toContain('compromise')
  })
})
