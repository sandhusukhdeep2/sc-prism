import { describe, expect, it } from 'vitest'
import type { EngineSpan } from './nativeEngine'
import { ownActivity } from './ownActivity'

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
