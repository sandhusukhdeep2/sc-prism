import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An agent remembers its proof (design 2026-11-08 §B): when it was proven,
// or why it is not — in the store, and in its vault file as `proven_at` /
// `unproven_reason` so the file stays the source of truth.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  storeGet: vi.fn(async () => null as string | null),
  storeSet: vi.fn(async () => {}),
}))
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})

const AT = Date.UTC(2026, 10, 8, 5, 0, 0)
const PROVEN = { at: AT, proven: true, reason: '' }
const UNPROVEN = { at: AT, proven: false, reason: 'local refused the request (HTTP 401): API key required' }
const base = { name: 'checker', role: 'checks proposals', model: 'local' as const, skills: [], tools: ['vault'], memory: [], charter: '' }

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})
afterEach(() => localStorage.clear())

describe('the vault file carries the proof', () => {
  it('a proven agent writes proven_at as an ISO time', async () => {
    const { serializeAgentMd } = await import('./agents')
    expect(serializeAgentMd({ ...base, proof: PROVEN })).toContain('proven_at: 2026-11-08T05:00:00.000Z')
    expect(serializeAgentMd({ ...base, proof: PROVEN })).not.toContain('unproven_reason')
  })
  it('an unproven agent writes the reason, in the engine’s words', async () => {
    const { serializeAgentMd } = await import('./agents')
    const md = serializeAgentMd({ ...base, proof: UNPROVEN })
    expect(md).toContain('unproven_reason: local refused the request (HTTP 401): API key required')
    expect(md).not.toContain('proven_at')
  })
  it('an agent never proven writes neither', async () => {
    const { serializeAgentMd } = await import('./agents')
    const md = serializeAgentMd(base)
    expect(md).not.toMatch(/proven_at|unproven_reason/)
  })
  it('round-trips through the parser', async () => {
    const { serializeAgentMd, parseAgentMd } = await import('./agents')
    expect(parseAgentMd('agents/checker.md', serializeAgentMd({ ...base, proof: PROVEN })).proof).toEqual(PROVEN)
    expect(parseAgentMd('agents/checker.md', serializeAgentMd({ ...base, proof: UNPROVEN })).proof).toEqual({ ...UNPROVEN, at: 0 })
    expect(parseAgentMd('agents/checker.md', serializeAgentMd(base)).proof).toBeUndefined()
  })
})

describe('the store carries the proof', () => {
  it('update stores a proof and it survives a reload', async () => {
    let mod = await import('./agents')
    const a = mod.create({ name: 'checker', role: 'checks proposals', model: 'local' })
    mod.update(a.id, { proof: PROVEN })
    expect(mod.list().find((x) => x.id === a.id)?.proof).toEqual(PROVEN)
    vi.resetModules()
    mod = await import('./agents')
    expect(mod.list().find((x) => x.id === a.id)?.proof).toEqual(PROVEN)
  })
  it('a system agent can be proven too — a proof is a fact about it, not an edit', async () => {
    const mod = await import('./agents')
    const sys = mod.list().find((x) => x.system)
    expect(sys, 'a seeded system agent exists').toBeTruthy()
    mod.update(sys!.id, { proof: UNPROVEN, name: 'renamed' })
    const after = mod.list().find((x) => x.id === sys!.id)!
    expect(after.proof).toEqual(UNPROVEN)
    expect(after.name).toBe(sys!.name)
  })
  it('the file wins when the agent owns one; the store keeps its proof otherwise', async () => {
    const { mergeVaultAgent, parseAgentMd, serializeAgentMd } = await import('./agents')
    const existing = { id: 'x', name: 'checker', role: 'r', model: 'local' as const, skills: [], enabled: true, usage: 0, evalScore: 0, system: false, orb: '', proof: PROVEN, sourcePath: 'agents/checker.md' }
    const parsed = parseAgentMd('agents/checker.md', serializeAgentMd({ ...base, proof: UNPROVEN }))
    expect(mergeVaultAgent(existing, parsed, 'agents/checker.md').proof).toEqual({ ...UNPROVEN, at: 0 })
    const stranger = { ...existing, sourcePath: undefined }
    const parsedPlain = parseAgentMd('agents/other.md', serializeAgentMd(base))
    expect(mergeVaultAgent(stranger, parsedPlain, 'agents/other.md').proof).toEqual(PROVEN)
  })
})
