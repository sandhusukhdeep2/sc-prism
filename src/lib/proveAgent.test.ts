import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  newRunId: vi.fn(() => 'run-x'),
  runNativeTask: vi.fn(),
  readSpansTail: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  // The one seam that turns the user's `~/sc-vault` into a real directory.
  resolveVaultDir: vi.fn(async (p?: string) => (p === '~/sc-vault' ? '/Users/me/sc-vault' : p || '/default/vault')),
}))
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})
const { proveAgent, proofChipText, proofLiveLines } = await import('./proveAgent')

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

describe('proveAgent — the vault path reaches the engine resolved', () => {
  // Seen in the app 2026-11-08: the proof ran with the stored `~/sc-vault`
  // verbatim, the engine joined it to its own cwd, and the run's spans, log
  // and verdict landed in `<app bundle>/resources/engine/~/sc-vault/` — so the
  // grade read a vault that had nothing in it.
  it('expands `~` before the run and reads the tail from the same directory', async () => {
    native.runNativeTask.mockResolvedValue({ taskId: 't3', response: 'Hello, I am Checker.', native: { models_used: ['local · gemma-3'] } })
    await proveAgent({ name: 'Checker', role: 'checks', model: 'local', tools: [] }, '~/sc-vault', settings)
    expect(native.runNativeTask.mock.calls[0][1]).toBe('/Users/me/sc-vault')
    expect(native.readSpansTail).toHaveBeenCalledWith('/Users/me/sc-vault', 400)
  })
  it('the live tail the ceremony shows is read from the resolved vault and keeps only this proof’s tool calls', async () => {
    native.readSpansTail.mockResolvedValue([
      { type: 'tool_exec', attrs: { agent: 'checker', round: 'proof', tool: 'vault_list' } },
      { type: 'model_call', attrs: { agent: 'checker', round: 'proof' } },
      { type: 'tool_exec', attrs: { agent: 'other', round: 'proof', tool: 'vault_list' } },
      { type: 'tool_exec', attrs: { agent: 'checker', round: '1', tool: 'vault_list' } },
    ])
    const lines = await proofLiveLines('~/sc-vault', 'Checker')
    expect(native.readSpansTail).toHaveBeenCalledWith('/Users/me/sc-vault', 200)
    expect(lines).toHaveLength(1)
    expect(lines[0].attrs?.tool).toBe('vault_list')
  })
})

describe('proofChipText — what a card says', () => {
  it('reads the three states', () => {
    expect(proofChipText(undefined)).toBe('not yet proven')
    expect(proofChipText({ at: Date.UTC(2026, 10, 8), proven: true, reason: '' })).toMatch(/^proven ✓ /)
    expect(proofChipText({ at: 0, proven: false, reason: 'local refused the request (HTTP 401)' })).toBe('unproven — local refused the request (HTTP 401)')
  })
})

// Seen in the installed app, 2026-11-14: every built-in card said "not yet
// proven" directly above "74 turns · last answered" — and offered to "Prove on
// claude · costs cents" a seat that had already answered seventy-four times.
// Proof is "it answers on its model"; real answered turns ARE that proof.
const { proofView } = await import('./proveAgent')

describe('proofView — what a card says about proof, and whether it offers Prove', () => {
  it('nothing proven and no work of its own: not yet proven, and Prove is offered', () => {
    expect(proofView(undefined, null)).toEqual({ text: 'not yet proven', tone: 'none', canProve: true })
  })

  it('a passed proof is dated and needs no further action', () => {
    const v = proofView({ at: Date.UTC(2026, 10, 8), proven: true, reason: '' }, null)
    expect(v.text).toMatch(/^proven ✓ /)
    expect(v).toMatchObject({ tone: 'proven', canProve: false })
  })

  it('a failed proof says why, in the engine’s words, and can be tried again', () => {
    expect(proofView({ at: 0, proven: false, reason: 'local refused the request (HTTP 401)' }, null)).toEqual({
      text: 'unproven — local refused the request (HTTP 401)',
      tone: 'unproven',
      canProve: true,
      reason: 'local refused the request (HTTP 401)',
    })
  })

  it('a seat whose own turns were answered in real runs is proven by its work', () => {
    expect(proofView(undefined, { answered: 74 })).toEqual({
      text: 'proven ✓ in real runs',
      tone: 'proven',
      canProve: false,
    })
  })

  it('…but turns that got no answer prove nothing', () => {
    expect(proofView(undefined, { answered: 0 })).toMatchObject({ text: 'not yet proven', canProve: true })
  })

  it('a proof on record says what it says, whatever the runs since', () => {
    // A failed proof names a real cause the user should see; work does not hide it.
    expect(proofView({ at: 0, proven: false, reason: 'no key' }, { answered: 9 }).tone).toBe('unproven')
  })
})
