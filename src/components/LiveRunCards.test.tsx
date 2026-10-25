// Mission Control (2026-08-05 spec §Live task cards) — the glow law.
//
// A card may glow ONLY while its run is genuinely live, i.e. while it is in
// the store's `liveRuns` list. These tests pin exactly that: the glow class
// tracks membership in `live` and nothing else, and a finished run — same id,
// same intent — never carries it. They also pin the model-attribution rule:
// names come from REAL spans, and when two runs are in flight (so a span
// cannot be told apart) NOTHING is claimed.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LiveRunCards from './LiveRunCards'
import {
  activeRuns,
  elapsedLabel,
  outcomeDetail,
  runSpans,
  currentRunSpans,
  type FinishedRun,
  type LiveRun,
} from '../lib/liveRuns'
import type { EngineSpan } from '../lib/nativeEngine'

const T0 = 1_700_000_000_000

const liveRun = (over: Partial<LiveRun> = {}): LiveRun => ({
  id: 'run-1',
  kind: 'chat',
  intent: 'fix the uploader bug',
  startedAt: T0,
  models: [],
  ...over,
})

const finishedRun = (over: Partial<FinishedRun> = {}): FinishedRun => ({
  id: 'run-1',
  kind: 'chat',
  intent: 'fix the uploader bug',
  startedAt: T0,
  endedAt: T0 + 5_000,
  outcome: 'passed',
  detail: '',
  ...over,
})

function renderCards(props: {
  live?: LiveRun[]
  finished?: FinishedRun[]
  spans?: EngineSpan[]
  now?: number
}) {
  return render(
    <MemoryRouter>
      <LiveRunCards
        live={props.live ?? []}
        finished={props.finished ?? []}
        spans={props.spans ?? []}
        now={props.now ?? T0 + 12_000}
      />
    </MemoryRouter>,
  )
}

/** The card element for an intent, whether it glows or not. */
function cardFor(intent: string): HTMLElement {
  const el = screen.getByText(intent).closest('.lrun__card, .lrun__row')
  if (!el) throw new Error(`no card/row rendered for “${intent}”`)
  return el as HTMLElement
}

describe('LiveRunCards — the glow tracks liveRuns and nothing else', () => {
  it('GLOWS for a run that is in liveRuns', () => {
    renderCards({ live: [liveRun()] })
    const card = cardFor('fix the uploader bug')
    expect(card.className).toMatch(/lrun__card--glow/)
  })

  it('does NOT glow when the same run has finished (identical id + intent)', () => {
    renderCards({ live: [], finished: [finishedRun()] })
    const row = cardFor('fix the uploader bug')
    expect(row.className).not.toMatch(/glow/)
    // ...and it really is the finished row, with the real outcome on it.
    expect(row.className).toMatch(/lrun__row/)
    expect(screen.getByText('passed')).toBeInTheDocument()
  })

  it('renders NOTHING when no run is live and none has finished', () => {
    const { container } = renderCards({})
    expect(container.querySelector('.lrun')).toBeNull()
    expect(container.querySelector('.lrun__card--glow')).toBeNull()
  })

  it('glows one card per live run and no more', () => {
    renderCards({
      live: [liveRun(), liveRun({ id: 'run-2', kind: 'team', intent: 'plan the dashboard' })],
      finished: [finishedRun({ id: 'run-0', intent: 'an earlier ask' })],
    })
    const glowing = document.querySelectorAll('.lrun__card--glow')
    expect(glowing).toHaveLength(2)
    expect(cardFor('an earlier ask').className).not.toMatch(/glow/)
  })

  it('shows the kind badge, the real intent and the elapsed clock', () => {
    renderCards({ live: [liveRun({ kind: 'team', intent: 'plan the dashboard' })], now: T0 + 72_000 })
    expect(screen.getByText('team')).toBeInTheDocument()
    expect(screen.getByText('plan the dashboard')).toBeInTheDocument()
    expect(screen.getByText('1:12')).toBeInTheDocument()
  })
})

// H1 — a build that exhausts its refines PARKS on "one more shot?" and polls a
// ref every 140ms waiting for a human. The engine subprocess has already
// exited, so from that moment nothing is executing — potentially all night.
// The card stays (it really does resume on the answer) but must not glow.
describe('LiveRunCards — a run PARKED on the user does not glow', () => {
  const parked = (over: Partial<LiveRun> = {}) => liveRun({ paused: true, ...over })

  it('renders no glow class for a paused run', () => {
    renderCards({ live: [parked()] })
    const card = cardFor('fix the uploader bug')
    expect(card.className).not.toMatch(/glow/)
    expect(card.className).toMatch(/lrun__card--paused/)
    expect(document.querySelectorAll('.lrun__card--glow')).toHaveLength(0)
  })

  it('says "waiting on you" instead of implying work is happening', () => {
    renderCards({ live: [parked()] })
    expect(screen.getByText('waiting on you')).toBeInTheDocument()
    expect(screen.getByLabelText(/waiting on you: fix the uploader bug/)).toBeInTheDocument()
  })

  it('does not claim a model is "on it now" while parked', () => {
    renderCards({
      live: [parked()],
      spans: [
        {
          name: 'model_call',
          type: 'model_call',
          status: 'ok',
          start: (T0 + 1_000) / 1000,
          attrs: { agent: 'researcher', provider: 'local', model: 'qwen2.5-coder' },
        },
      ],
    })
    expect(screen.queryByText('on it now')).not.toBeInTheDocument()
    expect(screen.getByText('was on it')).toBeInTheDocument()
  })

  it('an unparked run in the same list still glows (the flag is per-run)', () => {
    renderCards({ live: [parked(), liveRun({ id: 'run-2', intent: 'a live one' })] })
    expect(cardFor('fix the uploader bug').className).not.toMatch(/glow/)
    expect(cardFor('a live one').className).toMatch(/lrun__card--glow/)
  })
})

describe('LiveRunCards — models come from REAL spans, never a guess', () => {
  const modelSpan = (agent: string, model: string, startMs: number): EngineSpan => ({
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    start: startMs / 1000,
    attrs: { agent, provider: 'local', model },
  })

  it('names the agents/models the run really used (single live run)', () => {
    renderCards({
      live: [liveRun()],
      spans: [modelSpan('researcher', 'qwen2.5-coder', T0 + 1_000)],
    })
    expect(screen.getByText('on it now')).toBeInTheDocument()
    expect(screen.getByText(/researcher · qwen2\.5-coder/)).toBeInTheDocument()
  })

  it('claims NO models when two runs are in flight (a span cannot be attributed)', () => {
    renderCards({
      live: [liveRun(), liveRun({ id: 'run-2', intent: 'second ask' })],
      spans: [modelSpan('researcher', 'qwen2.5-coder', T0 + 1_000)],
    })
    expect(screen.queryByText('on it now')).not.toBeInTheDocument()
    expect(screen.queryByText(/qwen2\.5-coder/)).not.toBeInTheDocument()
  })

  it('ignores spans that started BEFORE the run did (a previous run’s trail)', () => {
    renderCards({
      live: [liveRun()],
      spans: [modelSpan('ghost', 'gpt-4o', T0 - 60_000)],
    })
    expect(screen.queryByText(/ghost/)).not.toBeInTheDocument()
    expect(screen.queryByText(/gpt-4o/)).not.toBeInTheDocument()
  })

  it('labels a requested roster as "asked for", not as who answered', () => {
    renderCards({ live: [liveRun({ kind: 'team', models: ['lead:claude', 'researcher:local'] })] })
    expect(screen.getByText('asked for')).toBeInTheDocument()
    expect(screen.getByText('lead:claude')).toBeInTheDocument()
    expect(screen.queryByText('on it now')).not.toBeInTheDocument()
  })
})

describe('LiveRunCards — finished rows are honest and capped by the caller', () => {
  it('shows a failed run’s real detail text and links to the engine console', () => {
    renderCards({
      finished: [finishedRun({ outcome: 'failed', detail: 'no real reply — the provider was unreachable' })],
    })
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('no real reply — the provider was unreachable')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/console')
  })

  // L2 — the link said "trace ›" but goes to the global /console dashboard,
  // which shows the most recent spans; the app stores no per-run trace. The
  // label now says what the link actually opens.
  it('labels the link for where it really goes — it promises no stored trace', () => {
    renderCards({ finished: [finishedRun()] })
    expect(screen.getByText('console ›')).toBeInTheDocument()
    expect(screen.queryByText(/trace/i)).not.toBeInTheDocument()
  })

  it('a stopped run says "stopped" — never dressed up as a pass or a fail', () => {
    renderCards({ finished: [finishedRun({ outcome: 'stopped', detail: 'stopped at 120s — no reply came back' })] })
    expect(screen.getByText('stopped')).toBeInTheDocument()
    expect(screen.queryByText('passed')).not.toBeInTheDocument()
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
  })

  // A3 (2026-08-11 acceptance walk) — the real row read "… stopped · stopped at
  // 240s (possibly waiting on a held tool approval)". Say it once; keep both
  // pieces of information.
  it('does not print the outcome word twice when the detail repeats it', () => {
    renderCards({
      finished: [
        finishedRun({
          kind: 'heartbeat',
          intent: 'Sukh is awake',
          outcome: 'stopped',
          detail: 'stopped at 240s (possibly waiting on a held tool approval)',
        }),
      ],
    })
    // the chip, exactly once
    expect(screen.getAllByText('stopped')).toHaveLength(1)
    // and the detail, with its leading duplicate trimmed but nothing else lost
    expect(screen.getByText('at 240s (possibly waiting on a held tool approval)')).toBeInTheDocument()
  })

  it('leaves a detail that does not repeat the outcome exactly as written', () => {
    renderCards({
      finished: [finishedRun({ outcome: 'failed', detail: 'the run stopped before the model answered' })],
    })
    expect(screen.getByText('the run stopped before the model answered')).toBeInTheDocument()
  })
})

describe('outcomeDetail (pure) — the chip says the word, the detail need not repeat it', () => {
  const stopped = (detail: string): FinishedRun => finishedRun({ outcome: 'stopped', detail })

  it('trims the leading outcome word and whatever separator followed it', () => {
    expect(outcomeDetail(stopped('stopped at 240s (possibly waiting on a held tool approval)'))).toBe(
      'at 240s (possibly waiting on a held tool approval)',
    )
    expect(outcomeDetail(stopped('stopped: engine busy'))).toBe('engine busy')
    expect(outcomeDetail(stopped('Stopped — no reply came back'))).toBe('no reply came back')
    expect(outcomeDetail(finishedRun({ outcome: 'failed', detail: 'failed · no provider' }))).toBe('no provider')
  })

  it('trims only a LEADING whole word — mid-sentence mentions and prefixes survive', () => {
    expect(outcomeDetail(stopped('the wake stopped at 240s'))).toBe('the wake stopped at 240s')
    // a word that merely starts with the outcome is not the outcome
    expect(outcomeDetail(stopped('stoppedness is not a word'))).toBe('stoppedness is not a word')
  })

  it('returns "" when the detail was nothing but the duplicate (the chip already said it)', () => {
    expect(outcomeDetail(stopped('stopped'))).toBe('')
    expect(outcomeDetail(stopped(''))).toBe('')
  })
})

describe('liveRuns helpers (pure)', () => {
  it('elapsedLabel counts up in m:ss then h:mm:ss, never negative', () => {
    expect(elapsedLabel(T0, T0 + 7_000)).toBe('0:07')
    expect(elapsedLabel(T0, T0 + 72_000)).toBe('1:12')
    expect(elapsedLabel(T0, T0 + 3_723_000)).toBe('1:02:03')
    expect(elapsedLabel(T0, T0 - 5_000)).toBe('0:00')
  })

  it('runSpans attributes nothing while 2+ runs are live', () => {
    const s: EngineSpan = { name: 'model_call', type: 'model_call', start: (T0 + 1000) / 1000 }
    expect(runSpans([s], liveRun(), 1)).toEqual([s])
    expect(runSpans([s], liveRun(), 2)).toEqual([])
    expect(runSpans([s], liveRun(), 0)).toEqual([])
  })

  it('currentRunSpans is empty when nothing is live, so narration cannot outlive a run', () => {
    const s: EngineSpan = { name: 'tier1', start: (T0 + 1000) / 1000 }
    expect(currentRunSpans([s], [])).toEqual([])
    expect(currentRunSpans([s], [liveRun()])).toEqual([s])
    // A span from before the live run began is not this run's.
    const older: EngineSpan = { name: 'tier1', start: (T0 - 1000) / 1000 }
    expect(currentRunSpans([older], [liveRun()])).toEqual([])
  })

  // H4 — this used to take the OLDEST live run's start time, so with A and B
  // in flight the spans of A stayed in the body after A had FINISHED (its
  // verdict, "the run finished") under the console's `live` header, while B was
  // the run actually going. Same rule as runSpans now: 2+ → nothing.
  it('currentRunSpans attributes nothing while 2+ runs are live', () => {
    const early: EngineSpan = { name: 'verdict', start: (T0 + 1_000) / 1000 }
    const late: EngineSpan = { name: 'tier1', start: (T0 + 40_000) / 1000 }
    const a = liveRun({ id: 'A', startedAt: T0 })
    const b = liveRun({ id: 'B', startedAt: T0 + 30_000 })
    expect(currentRunSpans([early, late], [b])).toEqual([late])
    expect(currentRunSpans([early, late], [a, b])).toEqual([])
  })

  // H1 — the ONE input to anything that pulses/glows: the runs really executing.
  it('activeRuns drops the runs parked on a human answer', () => {
    const parked = liveRun({ id: 'parked', paused: true })
    const going = liveRun({ id: 'going' })
    expect(activeRuns([parked, going]).map((r) => r.id)).toEqual(['going'])
    expect(activeRuns([parked])).toEqual([])
    expect(activeRuns([going])).toEqual([going])
  })
})
