import { describe, expect, it } from 'vitest'
import { seatState } from './seatState'
import type { EngineSpan } from './nativeEngine'

// Span builders. An OPEN span is one the engine has not closed: its status is
// neither 'ok' nor 'error' (the same test narrate.ts and RunStream use).
function mc(
  agent: string,
  attrs: Record<string, unknown> = {},
  status: 'ok' | 'error' | 'open' = 'ok',
  start = 1,
): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    status: status === 'open' ? undefined : status,
    start,
    duration_ms: 100,
    attrs: { agent, provider: 'local', model: 'gemma-3', tokens_in: 10, tokens_out: 5, ...attrs },
  }
}

function tool(
  agent: string,
  name: string,
  attrs: Record<string, unknown> = {},
  status: 'ok' | 'error' | 'open' = 'ok',
  start = 2,
): EngineSpan {
  return {
    name: 'tool_exec',
    type: 'tool_exec',
    status: status === 'open' ? undefined : status,
    start,
    duration_ms: 50,
    attrs: { agent, tool: name, ...attrs },
  }
}

function judge(agent: string): EngineSpan {
  return { name: 'eval', type: 'model_call', status: 'ok', start: 3, duration_ms: 10, attrs: { agent, is_real: false } }
}

const REFUSED = 'local refused the request (HTTP 401): API key required'

describe('seatState — what one seat says, from its own spans', () => {
  it('an open model turn on a live run is thinking', () => {
    expect(seatState([mc('developer', {}, 'open')], 'developer', true)).toEqual({
      kind: 'thinking', text: 'thinking', tokens: 15,
    })
  })

  it('an open vault tool is reading your notes', () => {
    expect(seatState([tool('researcher', 'vault_read', { server: 'vault', path: 'notes/a.md' }, 'open')], 'researcher', true).text)
      .toBe('reading your notes')
  })

  it('an open web tool is searching the web', () => {
    expect(seatState([tool('researcher', 'web_search', { query: 'x' }, 'open')], 'researcher', true).text)
      .toBe('searching the web')
  })

  it('any other open tool is named by server · tool', () => {
    expect(seatState([tool('developer', 'list_issues', { server: 'github' }, 'open')], 'developer', true).text)
      .toBe('using github · list_issues')
  })

  it('a blocked tool stays blocked after the run ends — an outcome, not a liveness', () => {
    const s = seatState([tool('researcher', 'vault_read', { blocked: true })], 'researcher', false)
    expect(s.kind).toBe('blocked')
    expect(s.text).toBe('blocked')
  })

  it('a withheld result reads withheld', () => {
    expect(seatState([tool('researcher', 'web_fetch', { withheld: true })], 'researcher', true).text).toBe('withheld')
  })

  it('a refused turn names the cause from the span', () => {
    const s = seatState([mc('writer', { is_real: false, error: REFUSED, tokens_in: 2683, tokens_out: 0 })], 'writer', false)
    expect(s).toEqual({ kind: 'no-answer', text: 'no answer', cause: REFUSED, tokens: 2683 })
  })

  it('a span from before is_real existed reads as done, never no answer', () => {
    expect(seatState([mc('developer')], 'developer', false).kind).toBe('done')
  })

  it('a closed turn on a LIVE run reads answered — done is for a finished run', () => {
    expect(seatState([mc('developer')], 'developer', true)).toEqual({ kind: 'done', text: 'answered', tokens: 15 })
  })

  it('a turn the engine closed with status error is no answer, with the error attr as cause', () => {
    const s = seatState([mc('developer', { error: "ValueError('boom')" }, 'error')], 'developer', false)
    expect(s.kind).toBe('no-answer')
    expect(s.cause).toBe("ValueError('boom')")
  })

  it('a capability refusal reads blocked', () => {
    expect(seatState([tool('developer', 'terminal', { refused: true }, 'error')], 'developer', true).kind).toBe('blocked')
  })

  it("the judge's eval span is not this seat's work", () => {
    const s = seatState([judge('writer')], 'writer', true)
    expect(s.kind).toBe('idle')
    expect(s.tokens).toBe(0)
  })

  it('an open span on a run that is NOT live reads as its closed form — a parked run is not thinking', () => {
    expect(seatState([mc('developer', {}, 'open')], 'developer', false).kind).toBe('done')
  })

  it('no spans at all is idle with no text', () => {
    expect(seatState([], 'nobody', true)).toEqual({ kind: 'idle', text: '', tokens: 0 })
  })

  it('tokens are the sum over this agent’s work turns only', () => {
    const spans = [mc('developer', {}, 'ok', 1), mc('developer', {}, 'ok', 2), mc('researcher', {}, 'ok', 3), judge('developer')]
    expect(seatState(spans, 'developer', false).tokens).toBe(30)
  })

  it('the latest span decides: a closed refusal after an earlier good turn is still no answer', () => {
    const spans = [mc('writer', { is_real: true }, 'ok', 1), mc('writer', { is_real: false, error: REFUSED }, 'error', 2)]
    expect(seatState(spans, 'writer', false).kind).toBe('no-answer')
  })
})
