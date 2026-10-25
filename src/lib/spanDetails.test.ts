import { describe, expect, it } from 'vitest'
import { spanDetails } from './spanDetails'
import type { EngineSpan } from './nativeEngine'

// Claude-Code-style depth for the room stream (Sukhdeep, 2026-08-29, from his
// own transcript screenshots: "I need my chat representation of data — file
// access and other stuff LIKE THIS"). Each action expands into labeled IN /
// OUT lines — ONLY from attrs the span really carries. The privacy line
// holds: model prompts and vault/MCP arguments are never recorded engine-side,
// so they can never appear here; a span with nothing to show expands to
// nothing rather than invented detail.
const span = (over: Partial<EngineSpan>): EngineSpan =>
  ({ run_id: 'r', span_id: 's', name: 'x', type: 'x', status: 'ok', attrs: {}, ...over }) as EngineSpan

describe('spanDetails — honest IN/OUT for each action kind', () => {
  it('tier1 shows the commands in and the outcome out', () => {
    const d = spanDetails(
      span({
        name: 'tier1',
        type: 'tool_exec',
        attrs: { commands: ['npm test'], cwd: '/p', passed: true, failed_commands: [] },
      }),
    )
    expect(d.in.join(' ')).toContain('npm test')
    expect(d.in.join(' ')).toContain('/p')
    expect(d.out.join(' ')).toMatch(/passed/i)
  })

  it('a model call shows route reason in and real tokens out — never a prompt', () => {
    const d = spanDetails(
      span({
        name: 'model_call',
        type: 'model_call',
        attrs: {
          agent: 'planner',
          provider: 'claude',
          model: 'sonnet',
          reason: "reasoning keyword 'plan' -> cloud",
          tokens_in: 900,
          tokens_out: 120,
          cache: 'miss',
        },
      }),
    )
    expect(d.in.join(' ')).toContain("'plan' -> cloud")
    expect(d.out.join(' ')).toContain('900')
    expect(d.out.join(' ')).toContain('120')
  })

  it('a memory retrieval shows the query in and what was injected out', () => {
    const d = spanDetails(
      span({
        name: 'memory',
        type: 'retrieval',
        attrs: { query: 'brand palette', injected: 3, injected_tokens: 812 },
      }),
    )
    expect(d.in.join(' ')).toContain('brand palette')
    expect(d.out.join(' ')).toContain('3')
  })

  it('a span with no detail attrs yields empty arrays, never filler', () => {
    const d = spanDetails(span({ name: 'stop', type: 'hook' }))
    expect(d.in).toEqual([])
    expect(d.out).toEqual([])
  })
})
