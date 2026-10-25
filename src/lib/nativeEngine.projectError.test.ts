import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE SWALLOWED ERROR (2026-08-28, found live): a project build step failed
// INSTANTLY and the app said "The engine did not respond in time." — but no
// engine process had ever started, no span was written, and the Rust bridge's
// Err (which carries the engine's own stderr) was eaten by a bare `catch`.
// A wall-clock timeout and a spawn failure are different facts; reporting one
// as the other sent the whole investigation to the wrong place. The wrapper
// now keeps the last real error so the driver can surface it verbatim.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { lastEngineProjectError, runNativeProject } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const providers = {} as EngineProviders

describe('runNativeProject — a bridge failure is kept, never swallowed', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  it('a rejected invoke returns null AND records the real reason', async () => {
    invokeMock.mockRejectedValue('engine produced no output (exit Some(1)): ModuleNotFoundError: x')
    const v = await runNativeProject('build it', '/tmp/p', '/vault', providers)
    expect(v).toBeNull()
    expect(lastEngineProjectError()).toContain('engine produced no output')
    expect(lastEngineProjectError()).toContain('ModuleNotFoundError')
  })

  it('a clean run clears the kept error — stale reasons never outlive success', async () => {
    invokeMock.mockRejectedValueOnce('boom')
    await runNativeProject('a', '/tmp/p', '/vault', providers)
    expect(lastEngineProjectError()).toContain('boom')
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        task_id: 't-ok',
        tier1: { ran: true, passed: true, commands: [], log: '' },
        tier2: { ran: true, passed: true, eval_score: 0.9, threshold: 0.7 },
        tokens_spent: 10,
        model_route: ['local'],
        hooks_fired: [],
        artifacts: [],
        passed: true,
        timestamp: '2026-08-28T00:00:00Z',
      }),
    )
    await runNativeProject('b', '/tmp/p', '/vault', providers)
    expect(lastEngineProjectError()).toBe('')
  })
})

describe('runNativeProject — the step budget rides the invoke payload', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  it('a caller-set tokenBudget reaches the bridge; omitted sends 0 (engine default)', async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ task_id: 'x' }))
    await runNativeProject('build', '/tmp/p', '/vault', providers, { tokenBudget: 200_000 })
    let args = invokeMock.mock.calls[0][1] as Record<string, unknown>
    expect(args.tokenBudget).toBe(200_000)
    await runNativeProject('build', '/tmp/p', '/vault', providers)
    args = invokeMock.mock.calls[1][1] as Record<string, unknown>
    expect(args.tokenBudget).toBe(0)
  })
})
