import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tier-1 is a PROJECT gate — the last piece of the verification-spine saga.
//
// The app attaches the interview's verify command to EVERY run. With no project
// bound the cwd is '' and the gate could not run, so the run FAILED: that is why
// essentially every run in the user's history read `passed: false`, chat and
// manager report jobs included. The engine now SKIPS the gate honestly instead
// (`skipped` + a recorded reason), and the client must carry that skip through
// as a skip — never as a pass with ticks over checks that never executed.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeTask } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const SKIP_REASON =
  'skipped — no project bound, nothing to verify. A verify command is configured, but this ' +
  'run has no project directory, so there is no codebase to run it against.'

function rawVerdict(tier1: Record<string, unknown>): string {
  return JSON.stringify({
    task_id: 't-skip',
    tier1,
    tier2: { ran: true, passed: true, eval_score: 0.82 },
    tokens_spent: 120,
    model_route: ['local'],
    hooks_fired: ['tier1'],
    artifacts: [],
    passed: true,
    timestamp: '2026-08-11T00:00:00Z',
  })
}

describe('mapVerdict — a skipped Tier-1 stays a skip', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('carries skipped + the engine reason, and the run still passes', async () => {
    invokeMock.mockResolvedValue(
      rawVerdict({
        ran: true,
        passed: true,
        skipped: true,
        skip_reason: SKIP_REASON,
        skipped_commands: ['npm test'],
        commands: [],
        log: SKIP_REASON,
      }),
    )
    const v = await runNativeTask('hello, are you real?', '/vault')
    expect(v).not.toBeNull()
    expect(v!.passed).toBe(true)
    expect(v!.tier1.skipped).toBe(true)
    expect(v!.tier1.skipReason).toContain('no project bound')
    expect(v!.tier1.tests).toBe('skipped')
  })

  it('does NOT claim lint/build passed — nothing ran', async () => {
    invokeMock.mockResolvedValue(
      rawVerdict({ ran: true, passed: true, skipped: true, skip_reason: SKIP_REASON, commands: [] }),
    )
    const v = await runNativeTask('hello', '/vault')
    // `pass` is true (nothing to disprove) but no individual check may claim a
    // pass: a tick over a gate that never executed is the silent pass the
    // honesty rules forbid.
    expect(v!.tier1.pass).toBe(true)
    expect(v!.tier1.lint).toBe(false)
    expect(v!.tier1.build).toBe(false)
  })

  it('says something honest when an older engine flagged the skip with no reason', async () => {
    invokeMock.mockResolvedValue(rawVerdict({ ran: true, passed: true, skipped: true, commands: [] }))
    const v = await runNativeTask('hello', '/vault')
    expect(v!.tier1.skipped).toBe(true)
    expect(v!.tier1.skipReason).toBe('nothing to verify on this run — the gate did not run')
  })

  it('leaves a gate that REALLY ran completely unchanged', async () => {
    invokeMock.mockResolvedValue(
      rawVerdict({ ran: true, passed: true, skipped: false, commands: ['npm test'], log: 'ok' }),
    )
    const v = await runNativeTask('fix the parser', '/vault')
    expect(v!.tier1.skipped).toBeUndefined()
    expect(v!.tier1.skipReason).toBeUndefined()
    expect(v!.tier1.tests).toBe('1/1')
    expect(v!.tier1.lint).toBe(true)
    expect(v!.tier1.build).toBe(true)
  })

  it('a genuinely failing gate is still a failure, not a skip', async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({
        task_id: 't-fail',
        tier1: { ran: true, passed: false, skipped: false, commands: ['npm test'], log: '1 failing' },
        tier2: { ran: false, reason: 'short-circuited (tier1 failed)' },
        tokens_spent: 0,
        model_route: ['local'],
        hooks_fired: ['tier1'],
        artifacts: [],
        passed: false,
        timestamp: '2026-08-11T00:00:00Z',
      }),
    )
    const v = await runNativeTask('break the parser', '/vault')
    expect(v!.passed).toBe(false)
    expect(v!.tier1.pass).toBe(false)
    expect(v!.tier1.skipped).toBeUndefined()
    expect(v!.tier1.tests).toBe('?/1')
  })
})
