import { describe, expect, it } from 'vitest'
import { handoffs } from './handoffs'
import type { EngineSpan } from './nativeEngine'

function turn(agent: string, start: number, attrs: Record<string, unknown> = {}): EngineSpan {
  return {
    name: 'model_call', type: 'model_call', status: 'ok', start, duration_ms: 100,
    attrs: { agent, provider: 'local', model: 'gemma-3', ...attrs },
  }
}

function judge(agent: string, start: number): EngineSpan {
  return { name: 'eval', type: 'model_call', status: 'ok', start, duration_ms: 10, attrs: { agent, is_real: false } }
}

describe('handoffs — consecutive work turns by different agents', () => {
  it('a solo run has no handoffs', () => {
    expect(handoffs([turn('developer', 1), turn('developer', 2)])).toEqual([])
  })

  it('A then B is one handoff, labelled with B’s stage', () => {
    expect(handoffs([turn('researcher', 1, { stage: 'research' }), turn('developer', 2, { stage: 'draft' })]))
      .toEqual([{ from: 'researcher', to: 'developer', label: 'draft' }])
  })

  it('A → B → A is two handoffs with their own labels, not one', () => {
    const out = handoffs([
      turn('researcher', 1, { stage: 'research' }),
      turn('developer', 2, { stage: 'draft' }),
      turn('researcher', 3, { stage: 'check' }),
    ])
    expect(out).toEqual([
      { from: 'researcher', to: 'developer', label: 'draft' },
      { from: 'developer', to: 'researcher', label: 'check' },
    ])
  })

  it('A → A → B is one handoff', () => {
    expect(handoffs([turn('a', 1), turn('a', 2, { stage: 's' }), turn('b', 3, { stage: 't' })]))
      .toEqual([{ from: 'a', to: 'b', label: 't' }])
  })

  it('the judge’s eval span between two turns is not a handoff', () => {
    expect(handoffs([turn('a', 1), judge('a', 2), turn('b', 3, { stage: 'review' })]))
      .toEqual([{ from: 'a', to: 'b', label: 'review' }])
  })

  it('without a stage, a numeric round labels the handoff', () => {
    expect(handoffs([turn('a', 1, { round: 1 }), turn('b', 2, { round: 2 })])).toEqual([{ from: 'a', to: 'b', label: 'round 2' }])
  })

  it('with neither, the label is empty — never invented', () => {
    expect(handoffs([turn('a', 1), turn('b', 2)])).toEqual([{ from: 'a', to: 'b', label: '' }])
  })

  it('orders by span start, not by the order the lines arrived', () => {
    expect(handoffs([turn('b', 2, { stage: 'two' }), turn('a', 1, { stage: 'one' })]))
      .toEqual([{ from: 'a', to: 'b', label: 'two' }])
  })

  it('a turn with no agent attr breaks nothing and hands to nobody', () => {
    const anon: EngineSpan = { name: 'model_call', type: 'model_call', status: 'ok', start: 2, attrs: { provider: 'local' } }
    expect(handoffs([turn('a', 1), anon, turn('b', 3, { stage: 'x' })])).toEqual([{ from: 'a', to: 'b', label: 'x' }])
  })
})
