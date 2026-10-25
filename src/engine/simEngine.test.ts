import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTask } from './simEngine'
import type { EngineEvent, Verdict } from './types'

// runTask uses seeded pseudo-randomness and short setTimeout delays for UI
// animation. Fake timers let us drive it to completion instantly and keep every
// derived value deterministic. No settings are passed, so no model call is made.
async function run(intent: string): Promise<{ verdict: Verdict; events: EngineEvent[] }> {
  vi.useFakeTimers()
  try {
    const events: EngineEvent[] = []
    const promise = runTask(intent, (e) => events.push(e))
    await vi.runAllTimersAsync()
    const verdict = await promise
    return { verdict, events }
  } finally {
    vi.useRealTimers()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runTask', () => {
  it('routes sensitive intents to the local model', async () => {
    // "customer" + "password" => two sensitive hits => restricted => on-device.
    const { verdict } = await run('reset the customer password')
    expect(verdict.route.target).toBe('local')
    expect(verdict.route.model).toBe('qwen2.5-coder')
    expect(verdict.route.routeLabel).toContain('local')
  })

  it('is reproducible for the same intent', async () => {
    const a = await run('add a dark mode toggle')
    const b = await run('add a dark mode toggle')
    // taskId comes from a module-level counter, so it differs run to run; every
    // other field is a pure function of the intent and must match exactly.
    expect({ ...a.verdict, taskId: '' }).toEqual({ ...b.verdict, taskId: '' })
  })

  it('short-circuits on a Tier 1 failure with no write-back', async () => {
    // This intent hashes to a seed where seed % 7 === 0, forcing a Tier 1 fail.
    const { verdict, events } = await run('improve the error message')
    expect(verdict.passed).toBe(false)
    expect(verdict.tier1.pass).toBe(false)
    // No write-back: nothing validated or committed.
    expect(verdict.writeback.validated).toBe(false)
    expect(verdict.writeback.committed).toBe(false)
    // Tier 2 never runs and no write-back event is streamed.
    expect(events.some((e) => e.type === 'tier2')).toBe(false)
    expect(events.some((e) => e.type === 'writeback')).toBe(false)
  })

  it('produces a passing Verdict with both tiers and a positive cost', async () => {
    const { verdict } = await run('add a dark mode toggle')
    expect(verdict.passed).toBe(true)
    expect(verdict.tier1.pass).toBe(true)
    expect(verdict.tier2.passed).toBe(true)
    expect(verdict.tier2.evalScore).toBeGreaterThan(0)
    expect(verdict.cost).toBeGreaterThan(0)
  })
})
