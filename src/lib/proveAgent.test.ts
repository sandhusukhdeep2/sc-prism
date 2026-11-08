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

const providers = { baseUrl: 'http://127.0.0.1:8000', primary: 'local' } as never

beforeEach(() => {
  native.runNativeTask.mockReset()
  native.readSpansTail.mockReset().mockResolvedValue([])
})

describe('proveAgent — one path for the ceremony and the card', () => {
  it('runs the fixed proof attributed to the agent, on its own model, within budget', async () => {
    native.runNativeTask.mockResolvedValue({ response: 'Hello, I am Checker.' })
    const r = await proveAgent({ name: 'Checker', role: 'checks', model: 'local', tools: ['vault'] }, '/vault', providers)
    const [intent, vault, provs, runId, route, , budget, turns, mode] = native.runNativeTask.mock.calls[0]
    expect(intent).toContain('you are Checker, checks')
    expect(vault).toBe('/vault')
    expect(provs).toMatchObject({ agentName: 'checker', stage: 'proof', agentCapabilities: 'vault' })
    expect(runId).toBe('run-x')
    expect(route).toBe('local')
    expect([budget, turns, mode]).toEqual([400, 1, 'converse'])
    expect(r.proven).toBe(false) // vault was granted and never called
    expect(r.reason).toBe('vault was not called')
  })
  it('a cloud model proves on auto routing', async () => {
    native.runNativeTask.mockResolvedValue({ response: 'Hello.' })
    const r = await proveAgent({ name: 'Writer', role: 'writes', model: 'claude', tools: [] }, '/vault', providers)
    expect(native.runNativeTask.mock.calls[0][4]).toBe('auto')
    expect(r.proven).toBe(true)
  })
  it('an engine that throws grades as not finished, never throws out', async () => {
    native.runNativeTask.mockRejectedValue(new Error('bridge gone'))
    const r = await proveAgent({ name: 'W', role: 'w', model: 'local', tools: [] }, '/vault', providers)
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
