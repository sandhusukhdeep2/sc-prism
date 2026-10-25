import { describe, expect, it } from 'vitest'
import { agentWork } from './pipeline'
import type { EngineSpan } from './nativeEngine'

// Sukhdeep's design note asks for "8 results · 4 vault notes" under a
// coworker's name — what that agent has to SHOW for its turn. Every number here
// is a real tool_exec span. The same mock also carried "drafting section 2 of
// 4" and a filling bar; the engine has no notion of sections, so that number is
// deliberately absent rather than invented.

const tool = (agent: string, attrs: Record<string, unknown>, status = 'ok'): EngineSpan => ({
  name: 'tool_exec',
  type: 'tool_exec',
  status,
  attrs: { agent, ...attrs },
})

const read = (agent: string, over: Record<string, unknown> = {}, status = 'ok') =>
  tool(agent, { provider: 'vault', tool: 'vault_read', ...over }, status)

describe('what a coworker has to show for its turn', () => {
  it('counts the vault notes it really read', () => {
    expect(agentWork([read('researcher'), read('researcher')], 'researcher')).toBe('2 vault notes')
  })

  it('counts web results from the count the search really returned', () => {
    const spans = [tool('researcher', { tool: 'web_search', result_count: 8 })]
    expect(agentWork(spans, 'researcher')).toBe('8 results')
  })

  it('states both when both happened, results first', () => {
    const spans = [
      tool('researcher', { tool: 'web_search', result_count: 8 }),
      read('researcher'),
      read('researcher'),
      read('researcher'),
      read('researcher'),
    ]
    expect(agentWork(spans, 'researcher')).toBe('8 results · 4 vault notes')
  })

  it('singularises honestly', () => {
    expect(agentWork([read('r')], 'r')).toBe('1 vault note')
    expect(agentWork([tool('r', { tool: 'web_search', result_count: 1 })], 'r')).toBe('1 result')
  })

  it('counts only THIS agent’s work, never the crew’s', () => {
    const spans = [read('lead'), read('lead'), read('researcher')]
    expect(agentWork(spans, 'researcher')).toBe('1 vault note')
  })

  it('an agent with nothing to show says NOTHING, rather than "0 notes"', () => {
    expect(agentWork([], 'researcher')).toBe('')
    expect(agentWork([read('someone-else')], 'researcher')).toBe('')
  })
})

describe('a call that did not happen is not work done', () => {
  it('a gate refusal read nothing, so it counts for nothing', () => {
    expect(agentWork([read('r', { blocked: true })], 'r')).toBe('')
  })

  it('a call still held for a human has not read anything YET', () => {
    expect(agentWork([read('r', { held: true })], 'r')).toBe('')
    // …and once the human resolved it, it did.
    expect(agentWork([read('r', { held: true, resolved: true })], 'r')).toBe('1 vault note')
  })

  it('an errored call counts for nothing, by status or by attr', () => {
    expect(agentWork([read('r', {}, 'error')], 'r')).toBe('')
    expect(agentWork([read('r', { is_error: true })], 'r')).toBe('')
  })

  it('a search with no reported count adds no results rather than guessing one', () => {
    expect(agentWork([tool('r', { tool: 'web_search' })], 'r')).toBe('')
  })
})
