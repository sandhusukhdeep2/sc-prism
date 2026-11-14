import { describe, expect, it } from 'vitest'
import { runLines, teamOutcome, turnLine, verdictOutcome } from './runLines'
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'

// THE WORK, IN THE CHAT (spec 2026-11-14 "Visible agents"). The mockup the
// owner called "perfect example what I want" writes a run into the chat as
// SEAT-ATTRIBUTED LINES — who · on which AI · what it did — "each from a
// span", and closes it with one outcome strip. These are the lines and the
// strip, derived and nothing else: a line exists because spans say so.
let n = 0
const span = (over: Partial<EngineSpan> & { attrs?: Record<string, unknown> }): EngineSpan =>
  ({ span_id: `s${++n}`, status: 'ok', start: n, end: n + 0.5, ...over }) as unknown as EngineSpan
const call = (agent: string, attrs: Record<string, unknown> = {}, over: Partial<EngineSpan> = {}) =>
  span({
    type: 'model_call',
    name: 'model_call',
    ...over,
    attrs: { agent, provider: 'local', model: 'gemma-3', is_real: true, tokens_in: 100, tokens_out: 40, ...attrs },
  })
const tool = (agent: string, attrs: Record<string, unknown>, over: Partial<EngineSpan> = {}) =>
  span({ type: 'tool_exec', name: 'tool_exec', ...over, attrs: { agent, ...attrs } })

describe('runLines — a run, as lines a span could back', () => {
  it('no spans, no lines', () => {
    expect(runLines([], true)).toEqual([])
  })

  it('each seat’s stretch of work is one line: who, on which AI, what it did', () => {
    const lines = runLines(
      [
        call('lead', { provider: 'claude-cli', model: 'fable' }),
        tool('researcher', { provider: 'vault', tool: 'vault_read', path: 'notes/brief.md' }),
        tool('researcher', { provider: 'vault', tool: 'vault_read', path: 'clients/northwind.md' }),
        call('researcher'),
      ],
      false,
    )
    expect(lines.map((l) => [l.who, l.ai])).toEqual([
      ['Manager', 'claude-cli · fable'],
      ['Researcher', 'local · gemma-3'],
      // (and, because notes were read, the room's privacy line — its own test)
      ['Privacy', 'this room'],
    ])
    expect(lines[0].text).toBe('answered · handed to Researcher')
    expect(lines[1].text).toBe('read notes/brief.md and clients/northwind.md · answered')
  })

  it('a seat that speaks again later gets a second line, in the order things happened', () => {
    const lines = runLines([call('lead'), call('researcher'), call('lead')], false)
    expect(lines.map((l) => l.who)).toEqual(['Manager', 'Researcher', 'Manager'])
    expect(lines[1].text).toBe('answered · handed to Manager')
    // The last stretch hands to nobody.
    expect(lines[2].text).toBe('answered')
  })

  it('web work is counted and names where it went', () => {
    const lines = runLines(
      [
        tool('researcher', { provider: 'web', tool: 'web_search', query: 'solar' }),
        tool('researcher', { provider: 'web', tool: 'web_search', query: 'solar cost' }),
        tool('researcher', { provider: 'web', tool: 'web_fetch', host: 'energysage.com' }),
        tool('researcher', { provider: 'web', tool: 'web_fetch', host: 'solantiq.com' }),
        tool('researcher', { provider: 'web', tool: 'web_fetch', host: 'example.org' }),
        call('researcher'),
      ],
      false,
    )
    expect(lines[0].text).toBe('searched the web ×2 · read energysage.com, solantiq.com +1 · answered')
  })

  it('a seat mid-call on a live run is thinking — and only on a live run', () => {
    const spans = [call('lead'), call('researcher', {}, { status: 'open', end: undefined } as never)]
    expect(runLines(spans, true)[1]).toMatchObject({ who: 'Researcher', text: 'thinking', tone: 'live' })
    // The same spans on a run that is not executing claim no thinking.
    expect(runLines(spans, false)[1].tone).not.toBe('live')
    expect(runLines(spans, false)[1].text).not.toContain('thinking')
  })

  it('a turn that got no answer says so, with the engine’s own cause, as a warning', () => {
    const lines = runLines(
      [call('writer', { is_real: false, error: 'local refused the request (HTTP 401)', tokens_in: 0, tokens_out: 0 })],
      false,
    )
    expect(lines[0].tone).toBe('warn')
    expect(lines[0].text).toBe('no answer — local refused the request (HTTP 401)')
  })

  it('a tool the rules stopped is a warning chip on that seat’s line', () => {
    const lines = runLines(
      [tool('researcher', { provider: 'mcp', server: 'files', tool: 'write', blocked: true }), call('researcher')],
      false,
    )
    expect(lines[0].chips).toContainEqual({ text: '1 blocked by your rules', kind: 'warn' })
  })

  it('notes read on a local seat are marked as having stayed local', () => {
    const lines = runLines(
      [tool('researcher', { provider: 'vault', tool: 'vault_read', path: 'a.md' }), call('researcher')],
      false,
    )
    expect(lines[0].chips).toContainEqual({ text: 'stayed local', kind: 'local' })
    // A cloud seat that read a note makes no such claim.
    const cloud = runLines(
      [tool('lead', { provider: 'vault', tool: 'vault_read', path: 'a.md' }), call('lead', { provider: 'claude-cli', model: 'fable' })],
      false,
    )
    expect(cloud[0].chips).toEqual([])
  })

  it('the room’s privacy is its own line: notes read here, and results kept off the cloud', () => {
    const lines = runLines(
      [
        tool('researcher', { provider: 'vault', tool: 'vault_read', path: 'a.md' }),
        tool('researcher', { provider: 'vault', tool: 'vault_read', path: 'b.md', withheld: true }),
        call('researcher'),
      ],
      false,
    )
    const privacy = lines[lines.length - 1]
    expect(privacy).toMatchObject({ who: 'Privacy', ai: 'this room' })
    expect(privacy.text).toBe('1 note read on this Mac · 1 result withheld from the cloud')
  })

  it('a run that touched no notes has no privacy line', () => {
    expect(runLines([call('lead')], false).some((l) => l.who === 'Privacy')).toBe(false)
  })

  it('the checks and the review are lines of their own, in the words of what ran', () => {
    const lines = runLines(
      [
        call('lead'),
        span({ type: 'tool_exec', name: 'tier1', attrs: { passed: true } }),
        span({ type: 'model_call', name: 'eval', attrs: { provider: 'claude-cli', model: 'fable' } }),
        span({ type: 'verdict', name: 'tier2', attrs: { score: 0.91, passed: true } }),
      ],
      false,
    )
    expect(lines.map((l) => [l.who, l.ai, l.text])).toEqual([
      ['Manager', 'local · gemma-3', 'answered'],
      ['Checks', '', 'your checks passed'],
      ['Review', 'claude-cli · fable', 'scored 0.91 — passed'],
    ])
  })

  it('checks that had nothing to run say so — never "passed"', () => {
    const lines = runLines([span({ type: 'tool_exec', name: 'tier1', attrs: { passed: true, skipped: true } })], false)
    expect(lines[0]).toMatchObject({ who: 'Checks', text: 'nothing to check on this run', tone: 'plain' })
    const failed = runLines([span({ type: 'tool_exec', name: 'tier1', attrs: { passed: false } })], false)
    expect(failed[0]).toMatchObject({ text: 'your checks failed', tone: 'warn' })
  })

  it('a review that did not pass is a warning', () => {
    const lines = runLines([span({ type: 'verdict', name: 'tier2', attrs: { score: 0.4, passed: false } })], false)
    expect(lines[0]).toMatchObject({ who: 'Review', text: 'scored 0.40 — did not pass', tone: 'warn' })
  })
})

describe('turnLine — a seat’s recorded turn, as one line', () => {
  it('names the seat and its AI, and leads with the first line of what it wrote', () => {
    const line = turnLine({
      id: 't1',
      kind: 'seat',
      agent: 'researcher',
      provider: 'local',
      model: 'gemma-3',
      text: '## Findings\n\nSolar panels convert light to current.\nMore below.',
    })
    expect(line).toMatchObject({ who: 'Researcher', ai: 'local · gemma-3', local: true })
    // A markdown heading's marks are not part of the sentence.
    expect(line.text).toBe('Findings — Solar panels convert light to current.')
  })

  it('a long first line is cut, never the record: the whole turn stays one click away', () => {
    const long = 'x'.repeat(400)
    const line = turnLine({ id: 't', kind: 'seat', agent: 'lead', provider: 'claude-cli', model: '', text: long })
    expect(line.who).toBe('Manager')
    expect(line.ai).toBe('claude-cli')
    expect(line.text.length).toBeLessThanOrEqual(141)
    expect(line.text.endsWith('…')).toBe(true)
  })
})

const verdict = (over: Partial<Verdict> = {}): Verdict =>
  ({
    taskId: 't1',
    task: 'add a guard',
    route: { target: 'local', model: 'gemma-3', via: '', reason: '', routeLabel: 'internal → local · gemma-3' },
    tier1: { tests: '12/12', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.91, passed: true, judge: 'judge', trajectory: 'ok' },
    tokensIn: 5000,
    tokensOut: 2500,
    cost: 0,
    durationMs: 4000,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'verdicts/t1.md', validated: true, committed: true },
    passed: true,
    outcome: 'passed',
    ...over,
  }) as Verdict

describe('verdictOutcome — a run’s result, in one strip', () => {
  it('a passed run: routed, verified, written — with what each check said and what it cost', () => {
    const o = verdictOutcome(verdict())
    expect(o.tone).toBe('passed')
    expect(o.head).toBe('✓ routed → verified → written')
    expect(o.chips.map((c) => c.text)).toEqual(['checks: 12/12 tests passed', 'review: 0.91', 'stayed local'])
    expect(o.chips[2].kind).toBe('local')
    expect(o.cost).toBe('$0 cloud · 7.5k tokens')
  })

  it('checks that had nothing to run are said to have had nothing to run — never a tick', () => {
    const o = verdictOutcome(verdict({ tier1: { tests: '', lint: true, build: true, pass: true, skipped: true } }))
    expect(o.chips[0]).toEqual({ text: 'checks: nothing to run', kind: 'plain' })
  })

  it('a chat reply is answered, not "verified" and not "written"', () => {
    const o = verdictOutcome(
      verdict({ outcome: 'replied', tier1: { tests: '', lint: true, build: true, pass: true, skipped: true }, writeback: { path: '', validated: false, committed: false } }),
    )
    expect(o.tone).toBe('replied')
    expect(o.head).toBe('✓ routed → answered')
  })

  it('a cloud run says what it cost, and makes no local claim', () => {
    const o = verdictOutcome(
      verdict({ route: { target: 'cloud', model: 'fable', via: '', reason: '', routeLabel: 'public → cloud · fable' }, cost: 0.041 }),
    )
    expect(o.chips.some((c) => c.kind === 'local')).toBe(false)
    expect(o.cost).toBe('$0.04 cloud · 7.5k tokens')
  })

  it('the reviewer dissenting over passed checks needs a look, with the engine’s reason', () => {
    const o = verdictOutcome(
      verdict({ passed: false, outcome: 'attention', outcomeReason: 'the reviewer was not satisfied', tier2: { evalScore: 0.4, passed: false, judge: 'j', trajectory: '' } }),
    )
    expect(o.tone).toBe('attention')
    expect(o.head).toBe('⚠ needs a look')
    expect(o.why).toBe('the reviewer was not satisfied')
    expect(o.chips.find((c) => c.text.startsWith('review'))).toEqual({ text: 'review: 0.40', kind: 'warn' })
  })

  it('a failed run did not pass: the review never ran, and nothing was written', () => {
    const o = verdictOutcome(
      verdict({
        passed: false,
        outcome: 'failed',
        tier1: { tests: '3/12', lint: true, build: true, pass: false },
        writeback: { path: '', validated: false, committed: false },
      }),
    )
    expect(o.tone).toBe('failed')
    expect(o.head).toBe('✕ did not pass')
    expect(o.chips[0]).toEqual({ text: 'checks: 3/12 tests passed', kind: 'warn' })
    expect(o.chips.some((c) => c.text.startsWith('review'))).toBe(false)
  })
})

describe('teamOutcome — a team run’s result, from the line the app already wrote', () => {
  const turns = [
    { id: 'a', kind: 'seat' as const, agent: 'lead', provider: 'claude-cli', model: 'fable', text: 'x' },
    { id: 'b', kind: 'seat' as const, agent: 'researcher', provider: 'local', model: 'gemma-3', text: 'y' },
    { id: 'c', kind: 'seat' as const, agent: 'researcher', provider: 'local', model: 'gemma-3', text: 'z' },
  ]

  it('a passed team run: the head, how many turns stayed local, and the tokens of the budget', () => {
    const o = teamOutcome('team run passed · 7,024/100,000 tok · board saved: /vault/agents/board-r1.jsonl', turns)!
    expect(o.tone).toBe('passed')
    expect(o.head).toBe('✓ routed → verified → written')
    expect(o.chips).toContainEqual({ text: '2 of 3 turns local', kind: 'local' })
    expect(o.cost).toBe('7,024 of 100,000 tokens')
    expect(o.path).toBe('/vault/agents/board-r1.jsonl')
  })

  it('a team run that did not pass carries its reason, and an over-budget run says so', () => {
    const o = teamOutcome('team run did not pass — the judge scored 0.42 · 120,000/100,000 tok (over budget)', turns)!
    expect(o.tone).toBe('failed')
    expect(o.head).toBe('✕ did not pass')
    expect(o.why).toBe('the judge scored 0.42')
    expect(o.chips).toContainEqual({ text: 'over budget', kind: 'warn' })
  })

  // Seen in the installed app, 2026-11-14: the strip printed the judge's raw
  // line — "[llm-judge] … | score=0.5125 vs threshold=0.7 -> BELOW | envelope
  // ok". The sentence is the reason; the score and its bar are a chip.
  it('the reviewer’s raw line is read apart: its sentence is the reason, its score and bar are a chip', () => {
    const o = teamOutcome(
      'team run did not pass — [llm-judge] two seats answered, but the note invents a reply | score=0.5125 vs threshold=0.7 -> BELOW | envelope ok · 6,128/100,000 tok · board saved: /v/agents/board-x.jsonl',
      turns,
    )!
    expect(o.why).toBe('two seats answered, but the note invents a reply')
    expect(o.chips).toContainEqual({ text: 'review: 0.51 — needs 0.70', kind: 'warn' })
    expect(o.path).toBe('/v/agents/board-x.jsonl')
    // The same line with the arrow the engine also writes.
    const arrow = teamOutcome('team run did not pass — [llm-judge] too thin | score=0.675 vs threshold=0.7 → BELOW | envelope ok · 10/100 tok', [])!
    expect(arrow.why).toBe('too thin')
    expect(arrow.chips).toContainEqual({ text: 'review: 0.68 — needs 0.70', kind: 'warn' })
  })

  it('a reason that is already a sentence is left exactly as written', () => {
    expect(teamOutcome('team run did not pass — the token budget ran out · 10/100 tok', [])!.why).toBe('the token budget ran out')
  })

  it('with no turns recorded it claims no local share', () => {
    const o = teamOutcome('team run passed · 10/100 tok', [])!
    expect(o.chips.some((c) => c.text.includes('turns'))).toBe(false)
  })

  it('any other line the app wrote is not a team outcome', () => {
    expect(teamOutcome('Stopped — you stopped this team run.', turns)).toBeNull()
    expect(teamOutcome('Today’s model check — nothing newer.', [])).toBeNull()
  })
})
