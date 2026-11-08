import { describe, expect, it } from 'vitest'
import { roomCountLine } from './roomCount'
import type { StoredAgent } from './agents'

function agent(name: string, over: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: name, name, role: 'does things', model: 'local' as StoredAgent['model'], skills: [],
    enabled: true, usage: 0, evalScore: 0, system: false, orb: '', assignedTo: 'p1', ...over,
  }
}

const orb = (agent: string, outcome = 'done') => ({ agent, outcome })

describe('roomCountLine — agents from the store and the spans, never from a plan', () => {
  it('counts the room’s agents, how many have ever worked, and how many work now', () => {
    const agents = [agent('researcher', { usage: 3 }), agent('developer', { usage: 1 }), agent('writer')]
    expect(roomCountLine(agents, 'p1', [orb('researcher', 'running'), orb('developer')], true))
      .toBe('3 agents · 2 have worked · 1 working now')
  })

  it('nobody is working now when the run is not live, whatever the spans say', () => {
    const agents = [agent('researcher', { usage: 3 }), agent('developer', { usage: 1 })]
    expect(roomCountLine(agents, 'p1', [orb('researcher', 'running')], false)).toBe('2 agents · 2 have worked · 0 working now')
  })

  it('singulars read naturally', () => {
    expect(roomCountLine([agent('solo', { usage: 1 })], 'p1', [orb('solo', 'running')], true)).toBe('1 agent · 1 has worked · 1 working now')
  })

  it('a room with no assigned agents counts the crew that actually appears in the spans', () => {
    expect(roomCountLine([agent('elsewhere', { assignedTo: 'other' })], 'p1', [orb('a', 'running'), orb('b')], true))
      .toMatch(/^2 agents · /)
  })

  it('a disabled agent is not in the room', () => {
    const agents = [agent('researcher', { usage: 3 }), agent('retired', { enabled: false, usage: 9 })]
    expect(roomCountLine(agents, 'p1', [], false)).toBe('1 agent · 1 has worked · 0 working now')
  })

  it('nothing at all is an empty line, not "0 agents"', () => {
    expect(roomCountLine([], 'p1', [], true)).toBe('')
  })
})
