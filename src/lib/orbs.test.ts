import { describe, expect, it } from 'vitest'
import { agentOrbs } from './orbs'
import { modelColor } from './modelColor'
import type { EngineSpan } from './nativeEngine'

function span(overrides: Partial<EngineSpan> & { attrs?: Record<string, unknown> }): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    ...overrides,
  }
}

describe('agentOrbs', () => {
  it('returns [] for an empty span list — no signal, no orbs', () => {
    expect(agentOrbs([])).toEqual([])
  })

  it('makes one orb per distinct agent with a model_call span, colored by model, in first-appearance order', () => {
    const spans: EngineSpan[] = [
      span({ attrs: { agent: 'developer', provider: 'claude-cli', model: 'claude-code-subscription' } }),
      span({ attrs: { agent: 'reviewer', provider: 'gemini', model: 'gemini-2.0-flash' } }),
      span({ attrs: { agent: 'planner', provider: 'openai', model: 'gpt-4o' } }),
    ]
    const orbs = agentOrbs(spans)
    expect(orbs.map((o) => o.agent)).toEqual(['developer', 'reviewer', 'planner'])
    expect(orbs[0].color).toBe(modelColor('claude-cli · claude-code-subscription'))
    expect(orbs[1].color).toBe(modelColor('gemini · gemini-2.0-flash'))
    expect(orbs[2].color).toBe(modelColor('openai · gpt-4o'))
    expect(orbs.every((o) => o.outcome === 'ok')).toBe(true)
    // distinct colors for distinct providers
    expect(new Set(orbs.map((o) => o.color)).size).toBe(3)
  })

  it('marks the outcome "failed" when the span status is error', () => {
    const spans: EngineSpan[] = [
      span({ status: 'error', attrs: { agent: 'reviewer', provider: 'gemini', model: 'gemini-2.0-flash' } }),
    ]
    expect(agentOrbs(spans)[0].outcome).toBe('failed')
  })

  it('marks an IN-FLIGHT span (status neither ok nor error) as "running" — never painted as passed', () => {
    // RunStream renders such a span as a neutral dot; the orb must agree, not
    // show a green success ring. Covers an explicit in-flight status and none.
    expect(
      agentOrbs([span({ status: 'running', attrs: { agent: 'developer', provider: 'claude-cli', model: 'x' } })])[0]
        .outcome,
    ).toBe('running')
    expect(
      agentOrbs([span({ status: undefined, attrs: { agent: 'developer', provider: 'claude-cli', model: 'x' } })])[0]
        .outcome,
    ).toBe('running')
  })

  it('collapses two spans for the same agent into ONE orb, deciding outcome from the LATEST span', () => {
    const spans: EngineSpan[] = [
      span({ status: 'error', attrs: { agent: 'developer', provider: 'claude-cli', model: 'claude-code-subscription' } }),
      span({ status: 'ok', attrs: { agent: 'developer', provider: 'gemini', model: 'gemini-2.0-flash' } }),
    ]
    const orbs = agentOrbs(spans)
    expect(orbs.length).toBe(1)
    expect(orbs[0].outcome).toBe('ok')
    expect(orbs[0].provider).toBe('gemini')
    expect(orbs[0].model).toBe('gemini-2.0-flash')
  })

  it('ignores non-model_call spans entirely', () => {
    const spans: EngineSpan[] = [
      span({ name: 'tier1', type: 'tier1', attrs: { passed: true } }),
      span({ name: 'route', type: 'route', attrs: { agent: 'developer', route: 'local' } }),
    ]
    expect(agentOrbs(spans)).toEqual([])
  })

  it('skips a model_call span with no agent rather than fabricating one', () => {
    const spans: EngineSpan[] = [span({ attrs: { provider: 'claude-cli', model: 'claude-code-subscription' } }), span({ attrs: {} })]
    expect(agentOrbs(spans)).toEqual([])
  })
})

// f2766c6's rule, applied where it was still leaking: an offline provider
// closes its span `ok` with is_real:false. Counting that as an answer is how
// the crew cluster came to read "3 answered" over a column that correctly
// marked the third agent unreachable.
describe('an unreachable agent is never counted as having answered', () => {
  it('a stub span closed ok but is_real:false reads FAILED, not ok', () => {
    const orbs = agentOrbs([
      {
        name: 'model_call',
        type: 'model_call',
        status: 'ok',
        attrs: { agent: 'critic', provider: 'gemini-cli', model: 'opus', is_real: false },
      },
    ] as never)
    expect(orbs).toHaveLength(1)
    expect(orbs[0].outcome).toBe('failed')
  })

  it('a genuine answer on the same shape still reads ok', () => {
    const orbs = agentOrbs([
      {
        name: 'model_call',
        type: 'model_call',
        status: 'ok',
        attrs: { agent: 'lead', provider: 'claude-cli', model: 'opus', is_real: true },
      },
    ] as never)
    expect(orbs[0].outcome).toBe('ok')
  })

  it('a span that never recorded is_real is taken at its status — nothing is invented', () => {
    const orbs = agentOrbs([
      {
        name: 'model_call',
        type: 'model_call',
        status: 'ok',
        attrs: { agent: 'lead', provider: 'local', model: 'qwen' },
      },
    ] as never)
    expect(orbs[0].outcome).toBe('ok')
  })
})
