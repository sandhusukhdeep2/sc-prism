// The v2 Work board, rendered. pipeline.test.ts proves the derivations; this
// proves the PIXELS obey them — that what reaches the DOM claims nothing more
// than the spans did.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import CrewBoard, { shortAi } from './CrewBoard'
import { modelColor } from '../lib/modelColor'
import type { EngineSpan } from '../lib/nativeEngine'
import type { LiveRun } from '../lib/liveRuns'

const call = (attrs: Record<string, unknown>, extra: Partial<EngineSpan> = {}): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'running',
  start: 100,
  attrs,
  ...extra,
})

const tool = (attrs: Record<string, unknown>, extra: Partial<EngineSpan> = {}): EngineSpan => ({
  name: 'tool_exec',
  type: 'tool_exec',
  status: 'ok',
  start: 100,
  attrs,
  ...extra,
})

const run = (over: Partial<LiveRun> = {}): LiveRun => ({
  id: 'r1',
  kind: 'project',
  intent: 'build the dashboard',
  startedAt: 1,
  models: [],
  ...over,
})

const draw = (spans: EngineSpan[], live: boolean, runs: LiveRun[] = []) =>
  render(<CrewBoard spans={spans} live={live} runs={runs} />)

// ── Rule 3 — no crew, no pipeline ───────────────────────────────────────────
describe('rule 3 — the board draws a pipeline only when there is a real crew', () => {
  it('renders NOTHING at all with no spans and nothing parked', () => {
    const { container } = draw([], true)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a solo run (a model_call with no agent attr)', () => {
    const { container } = draw([call({ provider: 'local', model: 'q', is_real: true })], true)
    expect(container.firstChild).toBeNull()
  })

  it('one column per real round, each labelled beneath the stack', () => {
    draw(
      [
        call({ agent: 'Scout', provider: 'local', model: 'qwen3', round: '1' }, { start: 10 }),
        call({ agent: 'Writer', provider: 'claude', model: 'opus', round: 'synthesis' }, { start: 20 }),
      ],
      true,
    )
    expect(screen.getByText('Round 1')).toBeInTheDocument()
    expect(screen.getByText('Pulling together')).toBeInTheDocument()
    expect(document.querySelectorAll('.crew__col')).toHaveLength(2)
  })
})

// ── Rule 1 — a monogram pulses ONLY while its run is genuinely live ─────────
describe('rule 1 — a paused run does not glow (the 16182f2 regression, in v2 form)', () => {
  const open = [call({ agent: 'Scout', provider: 'local', model: 'qwen3' })]

  it('an open span under a LIVE run pulses and shows a progress line', () => {
    draw(open, true)
    expect(document.querySelectorAll('.crew__mono--pulse').length).toBeGreaterThan(0)
    expect(document.querySelector('.crew__bar')).not.toBeNull()
  })

  it('the SAME span pulses nothing when nothing is executing — and no progress line', () => {
    draw(open, false)
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
    expect(document.querySelector('.crew__bar')).toBeNull()
  })

  it('a PARKED run: its "Your call" column shows, and not one monogram glows', () => {
    // This is exactly the shape of the bug: the run is still registered (it
    // resumes on the answer) but no engine is executing, so `live` is false.
    draw(open, false, [run({ paused: true })])
    expect(screen.getByText('Your call')).toBeInTheDocument()
    expect(screen.getByText('Waiting on your answer')).toBeInTheDocument()
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
  })

  it('a CLOSED span never pulses, even mid-run', () => {
    draw([call({ agent: 'Scout', provider: 'local', model: 'q', is_real: true }, { status: 'ok' })], true)
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
    expect(screen.getByTitle('answered')).toBeInTheDocument()
  })
})

// ── Rule 2 — name + model from REAL attrs, never a guess ────────────────────
describe('rule 2 — the name and the AI are the span’s own words', () => {
  it('shows the agent name and `provider · model` in mono, verbatim', () => {
    draw([call({ agent: 'researcher', provider: 'local', model: 'Qwen3.6-35B' })], true)
    expect(screen.getByText('researcher')).toBeInTheDocument()
    const ai = screen.getByText('local · Qwen3.6-35B')
    expect(ai.className).toContain('mono')
  })

  it('a span with no provider/model reads the honest generic and goes GREY', () => {
    draw([call({ agent: 'someone' })], true)
    expect(screen.getByText('an AI')).toBeInTheDocument()
    const mono = document.querySelector('.crew__mono--sm') as HTMLElement
    expect(mono.className).toContain('crew__mono--idle')
    expect(mono.style.background).toBeTruthy()
  })

  it('the monogram is a LETTER tinted by its model — never a face or an image', () => {
    const { container } = draw([call({ agent: 'Writer', provider: 'claude-cli', model: 'opus' })], true)
    expect(container.querySelector('img')).toBeNull()
    const mono = container.querySelector('.crew__mono--sm') as HTMLElement
    expect(mono.textContent).toBe('W')
    // the app-wide model hue, so a monogram, an orb and a run-stream chip all
    // name the same model in the same colour
    expect(mono.style.background.replace(/\s/g, '')).toBe(hexToRgb(modelColor('claude')))
  })

  it('says what each coworker is doing right now, from the real ask/outcome', () => {
    draw(
      [
        call({ agent: 'Scout', provider: 'local', model: 'q', round: '1' }),
        call(
          { agent: 'Writer', provider: 'claude', model: 'opus', round: '1', is_real: true, tokens_out: 40 },
          { status: 'ok', start: 101 },
        ),
      ],
      true,
    )
    expect(screen.getByText('asked to contribute to the board (round 1)')).toBeInTheDocument()
    expect(screen.getByText('answered (40 tokens back)')).toBeInTheDocument()
  })
})

// ── Rule 5 — counts are real states ────────────────────────────────────────
describe('rule 5 — the crew count is a count of real span states', () => {
  it('the badge and the line report what the spans say', () => {
    draw(
      [
        call({ agent: 'A', provider: 'local', model: 'q' }, { status: 'running' }),
        call({ agent: 'B', provider: 'local', model: 'q' }, { status: 'running' }),
        call({ agent: 'C', provider: 'claude', model: 'o', is_real: true }, { status: 'ok' }),
      ],
      true,
    )
    expect(screen.getByText('2 working · 1 answered')).toBeInTheDocument()
    expect(document.querySelector('.crew__badge')?.textContent).toBe('2')
  })

  it('with nothing live it never says "working" — an open span is unfinished', () => {
    draw([call({ agent: 'A', provider: 'local', model: 'q' }, { status: 'running' })], false, [
      run({ paused: true }),
    ])
    expect(screen.queryByText(/working/)).not.toBeInTheDocument()
    expect(screen.getByText('1 unfinished')).toBeInTheDocument()
  })
})

// ── Rule 4 — the 🔒 badge ───────────────────────────────────────────────────
describe('rule 4 — the lock badge appears only on a real vault read', () => {
  const crew = call({ agent: 'Scout', provider: 'local', model: 'q' })

  it('no vault call → no badge', () => {
    draw([crew], true)
    expect(document.querySelector('.crew__lock')).toBeNull()
  })

  it('a real read → the badge, naming the measured count', () => {
    draw([crew, tool({ provider: 'vault', tool: 'vault_read', path: 'notes/a.md' })], true)
    expect(screen.getByText(/read 1 vault note — stayed on this Mac/)).toBeInTheDocument()
  })

  it('a BLOCKED vault call is not a read, and earns no badge', () => {
    draw([crew, tool({ provider: 'vault', tool: 'vault_read', blocked: true })], true)
    expect(document.querySelector('.crew__lock')).toBeNull()
  })
})

// ── "Your call" — the black card, and only for something real ──────────────
describe('the "Your call" column is the one place the black accent is spent', () => {
  it('a held tool call raises it, and names what is actually being asked', () => {
    draw([call({ agent: 'W', provider: 'claude', model: 'o' }), tool({ held: true, tool: 'file_write', agent: 'writer' })], true)
    expect(screen.getByText('Needs your OK')).toBeInTheDocument()
    expect(screen.getByText('writer wants to use file_write')).toBeInTheDocument()
    expect(document.querySelector('.crew__decide')).not.toBeNull()
  })

  it('an ANSWERED hold is not still waiting on you — no column', () => {
    draw(
      [call({ agent: 'W', provider: 'claude', model: 'o' }), tool({ held: true, tool: 'file_write', resolved: 'allow' })],
      true,
    )
    expect(screen.queryByText('Your call')).not.toBeInTheDocument()
    expect(document.querySelector('.crew__decide')).toBeNull()
  })
})

/** jsdom serialises an inline hex background as rgb(); mirror that here. */
function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r},${g},${b})`
}

// A local model's real id can be enormous. Sukhdeep's is
// "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP", which
// wrapped over three lines and pushed the rest of the card out.
describe('shortAi — the model name fits the card, and hides nothing', () => {
  it('keeps a short name exactly as it is', () => {
    expect(shortAi('local · qwen')).toBe('local · qwen')
  })

  it('cuts a long model but keeps the provider whole', () => {
    const out = shortAi('local · Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP')
    expect(out.startsWith('local · ')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan(34)
  })

  it('a provider with no model is left alone', () => {
    expect(shortAi('an AI')).toBe('an AI')
  })
})
