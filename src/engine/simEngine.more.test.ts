import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTask } from './simEngine'
import type { EngineEvent, Verdict } from './types'

// Fake timers drive the animated delays to completion instantly; no settings are
// passed so no real model call is attempted.
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

describe('runTask — routing and cost', () => {
  it('routes a reasoning-heavy, non-sensitive intent to a cloud frontier model', async () => {
    // Many reasoning keywords + length push reasoningLoad past the 0.55 cloud
    // threshold, and no sensitive words keep it eligible to leave the machine.
    const { verdict } = await run(
      'architect and design a plan to refactor and optimize the routing strategy across the whole system',
    )
    expect(verdict.route.target).toBe('cloud')
    expect(['claude-sonnet', 'gemini-pro']).toContain(verdict.route.model)
    expect(verdict.route.routeLabel).toContain('cloud')
  })

  it('always reports a strictly positive cost and emits a contract then a route', async () => {
    const { verdict, events } = await run('add a dark mode toggle')
    expect(verdict.cost).toBeGreaterThan(0)
    expect(verdict.tokensIn).toBeGreaterThan(0)

    const contractIdx = events.findIndex((e) => e.type === 'contract')
    const routeIdx = events.findIndex((e) => e.type === 'route')
    expect(contractIdx).toBeGreaterThanOrEqual(0)
    expect(routeIdx).toBeGreaterThan(contractIdx)
  })

  it('classifies an internal keyword (vault) as at least internal sensitivity', async () => {
    // A single non-sensitive infra keyword ("vault") lifts sensitivity to internal
    // without forcing a local-only route on its own.
    const { verdict } = await run('tidy up the vault index')
    expect(verdict.route.routeLabel).toContain('internal')
  })
})
