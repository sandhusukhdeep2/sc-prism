import { describe, expect, it } from 'vitest'
import type { EngineSpan } from './nativeEngine'
import { agentRecord, ownActivity } from './ownActivity'

// What ONE agent's card says about ITS OWN work, read from the spans that
// carry its name — never from the model-wide tally. Seen 2026-11-09: five
// system tiles all read "73 runs on local · last failed · 14% pass", one
// global number wearing five agents' names.
const call = (agent: string, over: Partial<EngineSpan['attrs']> = {}, status = 'ok', start = 1): EngineSpan => ({
  name: 'model_call', type: 'model_call', status, start,
  attrs: { agent, provider: 'local', model: 'gemma', is_local: true, is_real: true, tokens_in: 1000, tokens_out: 50, ...over },
})
const tool = (agent: string, name: string, start = 1): EngineSpan => ({
  name: 'tool_exec', type: 'tool_exec', status: 'ok', start, attrs: { agent, tool: name, server: 'vault' },
})

describe('ownActivity — the agent’s own turns', () => {
  // What "proven by its work" rests on: turns that really got an answer.
  it('counts the turns that were answered — not the ones refused, and not one still open', () => {
    const spans = [
      call('scout', {}, 'ok', 1),
      call('scout', { is_real: false, error: 'local refused the request (HTTP 401)' }, 'error', 2),
      call('scout', {}, 'ok', 3),
      call('scout', {}, 'running', 4),
    ]
    expect(ownActivity(spans, 'scout', true)).toMatchObject({ turns: 4, answered: 2 })
    expect(ownActivity([call('scout', { is_real: false }, 'ok', 1)], 'scout', false)).toMatchObject({ answered: 0 })
  })

  it('counts only this agent’s work turns and sums their tokens', () => {
    const a = ownActivity([call('scout', {}, 'ok', 1), call('scout', {}, 'ok', 2), call('other'), { name: 'eval', type: 'model_call', status: 'ok', start: 3, attrs: { agent: 'scout', tokens_in: 9, tokens_out: 9 } }], 'scout', false)
    expect(a).toMatchObject({ turns: 2, tokens: 2100, state: 'ok' })
    expect(a?.label).toBe('2 turns · last answered · 2,100 tokens · all on your Mac')
  })
  it('says no answer, with the engine’s own cause, when the latest turn was a stand-in', () => {
    const a = ownActivity([call('scout', {}, 'ok', 1), call('scout', { is_real: false, error: 'local refused the request (HTTP 401)' }, 'error', 2)], 'scout', false)
    expect(a?.state).toBe('failed')
    expect(a?.label).toBe('2 turns · last no answer — local refused the request (HTTP 401) · 2,100 tokens · all on your Mac')
  })
  it('is working while its latest turn is still open on a live run, and not on a parked one', () => {
    const spans = [call('scout', {}, 'ok', 1), call('scout', {}, 'open', 2)]
    expect(ownActivity(spans, 'scout', true)).toMatchObject({ state: 'working', label: 'working…' })
    expect(ownActivity(spans, 'scout', false)?.state).toBe('ok')
  })
  it('names the tool calls it made and drops the on-device claim when any turn left the Mac', () => {
    const a = ownActivity([call('scout', { is_local: false, provider: 'claude-cli' }, 'ok', 1), tool('scout', 'vault_read', 2), tool('scout', 'vault_list', 3)], 'scout', false)
    expect(a?.label).toBe('1 turn · last answered · 1,050 tokens · 2 tool calls')
  })
  it('matches the seat by slug — the companion is written as "Sukh", a team seat as "reviewer-verifier"', () => {
    expect(ownActivity([call('Sukh')], 'sukh', false)?.turns).toBe(1)
    expect(ownActivity([call('reviewer-verifier')], 'Reviewer / Verifier', false)?.turns).toBe(1)
  })
  it('returns null when the log holds no turn of its own — the card falls back to the model-wide line', () => {
    expect(ownActivity([call('other')], 'scout', false)).toBeNull()
  })
})

// THE AGENT'S RECORD (2026-11-11): its own page shows what it has really done
// — the latest turns with the AI that answered, tokens, time and result, and
// the tools it called — read from the spans that carry its name.
describe('agentRecord — the latest turns, newest first', () => {
  it('lists this agent’s work turns newest first with the span’s own figures', () => {
    const rec = agentRecord(
      [
        call('scout', { round: 'proof', tokens_in: 1911, tokens_out: 42 }, 'ok', 10),
        call('other', {}, 'ok', 11),
        { ...call('scout', { round: '1', provider: 'claude-cli', model: 'opus', is_local: false, tokens_in: 500, tokens_out: 200 }, 'ok', 20), duration_ms: 9000 },
        call('scout', { round: '2', is_real: false, error: 'local refused the request (HTTP 401)' }, 'error', 30),
      ],
      'Scout',
      5,
    )
    expect(rec.turns.map((t) => t.stage)).toEqual(['2', '1', 'proof'])
    expect(rec.turns[0]).toMatchObject({ result: 'no answer', cause: 'local refused the request (HTTP 401)' })
    expect(rec.turns[1]).toMatchObject({ ai: 'claude-cli · opus', local: false, tokensIn: 500, tokensOut: 200, ms: 9000, result: 'answered' })
    expect(rec.turns[2]).toMatchObject({ ai: 'local · gemma', local: true, tokensIn: 1911, tokensOut: 42, result: 'answered' })
    // When it happened: the span's own start (engine seconds), as epoch ms.
    expect(rec.turns.map((t) => t.at)).toEqual([30_000, 20_000, 10_000])
  })
  it('keeps only the newest N and counts the tools it called by name', () => {
    const spans = [
      call('scout', {}, 'ok', 1), call('scout', {}, 'ok', 2), call('scout', {}, 'ok', 3),
      tool('scout', 'vault_read', 4), tool('scout', 'vault_read', 5), tool('scout', 'web_search', 6), tool('other', 'vault_read', 7),
    ]
    const rec = agentRecord(spans, 'scout', 2)
    expect(rec.turns).toHaveLength(2)
    expect(rec.tools).toEqual([{ name: 'vault_read', count: 2 }, { name: 'web_search', count: 1 }])
  })
  it('an agent with no span of its own has an empty record', () => {
    expect(agentRecord([call('other')], 'scout', 5)).toEqual({ turns: [], tools: [] })
  })
})
