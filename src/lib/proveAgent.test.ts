import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  newRunId: vi.fn(() => 'run-x'),
  runNativeTask: vi.fn(),
  readSpansTail: vi.fn(async () => []),
}))
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})
const { proveAgent, proofChipText } = await import('./proveAgent')

import { DEFAULT_SETTINGS, type Settings } from './settings'
const settings: Settings = { ...DEFAULT_SETTINGS, vaultPath: '/vault', webResearch: true, providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, enabled: p.id === 'local' || p.id === 'claude-cli' })) }

beforeEach(() => {
  native.runNativeTask.mockReset()
  native.readSpansTail.mockReset().mockResolvedValue([])
})

describe('proveAgent — one path for the ceremony and the card', () => {
  it('runs the fixed proof attributed to the agent, with the user’s ceiling, an output cap and one turn per grant', async () => {
    native.runNativeTask.mockResolvedValue({ taskId: 't1', response: 'Hello, I am Checker.', native: { models_used: ['local · gemma-3'] } })
    const r = await proveAgent({ name: 'Checker', role: 'checks', model: 'local', tools: ['vault', 'web'] }, '/vault', settings)
    const [intent, vault, provs, runId, route, , budget, turns, mode] = native.runNativeTask.mock.calls[0]
    expect(intent).toContain('you are Checker, checks')
    expect(vault).toBe('/vault')
    expect(provs).toMatchObject({ agentName: 'checker', stage: 'proof', agentCapabilities: 'vault,web', maxTokens: 400, webResearch: true, primary: 'local' })
    expect(String(provs.userCapabilities)).toContain('vault') // the ceiling, or the engine grants nothing
    expect(provs.tier1).toBe('') // a proof never runs the project’s tests
    expect(runId).toBe('run-x')
    expect(route).toBe('local')
    expect([budget, turns, mode]).toEqual([0, 2, 'converse'])
    expect(r.proven).toBe(false) // granted tools were never called
    expect(r.reason).toBe('vault was not called')
  })
  it('a claude agent is proven on the claude provider that is actually switched on, not on the primary', async () => {
    native.runNativeTask.mockResolvedValue({ taskId: 't2', response: 'Hello.', native: { models_used: ['claude-cli · opus'] } })
    const r = await proveAgent({ name: 'Writer', role: 'writes', model: 'claude', tools: [] }, '/vault', settings)
    expect(native.runNativeTask.mock.calls[0][2]).toMatchObject({ primary: 'claude-cli' })
    expect(r.proven).toBe(true)
  })
  it('a brand that is switched off does not run at all and says so', async () => {
    const r = await proveAgent({ name: 'Seer', role: 'sees', model: 'gemini', tools: [] }, '/vault', settings)
    expect(native.runNativeTask).not.toHaveBeenCalled()
    expect(r.proven).toBe(false)
    expect(r.reason).toContain('gemini')
  })
  it('an engine that throws grades as not finished, never throws out', async () => {
    native.runNativeTask.mockRejectedValue(new Error('bridge gone'))
    const r = await proveAgent({ name: 'W', role: 'w', model: 'local', tools: [] }, '/vault', settings)
    expect(r.proven).toBe(false)
    expect(r.reason).toBe('the engine did not finish')
  })
})

describe('proofChipText — what a card says', () => {
  it('reads the three states', () => {
    expect(proofChipText(undefined)).toBe('not yet proven')
    expect(proofChipText({ at: Date.UTC(2026, 10, 8), proven: true, reason: '' })).toMatch(/^proven ✓ /)
    expect(proofChipText({ at: 0, proven: false, reason: 'local refused the request (HTTP 401)' })).toBe('unproven — local refused the request (HTTP 401)')
  })
})
