import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `mapVerdict` carries the engine's three-valued outcome — and the judge's
 * recorded contradictions — through to the client VERBATIM.
 *
 * dc4124e added `outcome`/`outcome_reason` to the wire shape and mapped them
 * without synthesising. The owed follow-up needs one more field on the same
 * terms: `tier2.contradictions`, the judge claims the deterministic layer
 * disproved. The engine only RECORDS these (it never edits its reviewer's
 * marks), so if the client drops them, nothing in the product can ever tell the
 * user its reviewer was demonstrably wrong.
 */
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeTask } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const CONTRADICTION =
  'judge claimed "the produced artifact is truncated, failing to provide the actual implementation ' +
  'or the required files" over 6 file(s) measured on disk behind a passing tier-1 gate'

const REASON =
  'tests passed, reviewer dissented — the deterministic tier-1 gate ran `npm test` against 6 written ' +
  'file(s) and PASSED, but the tier-2 reviewer scored 0.5 below its 0.7 threshold.'

function raw(over: Record<string, unknown> = {}, tier2Over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    task_id: 'A-1042',
    tier1: { ran: true, passed: true, commands: ['npm test'], log: '# pass 11\n# fail 0' },
    tier2: { ran: true, passed: false, eval_score: 0.5, threshold: 0.7, ...tier2Over },
    tokens_spent: 1580,
    model_route: ['cloud'],
    hooks_fired: ['tier1', 'tier2'],
    artifacts: [],
    passed: false,
    timestamp: '2026-08-14T00:00:00Z',
    ...over,
  })
}

describe('mapVerdict — the three-valued outcome and the judge’s contradictions', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('carries `attention` + its reason verbatim, while `passed` stays strictly false', async () => {
    invokeMock.mockResolvedValue(raw({ outcome: 'attention', outcome_reason: REASON }))
    const v = await runNativeTask('build the todo CLI', '/vault')
    expect(v!.outcome).toBe('attention')
    expect(v!.outcomeReason).toBe(REASON)
    // The strict flag is untouched: project.py's git checkpoint and the training
    // rewards that gate on it must not loosen.
    expect(v!.passed).toBe(false)
  })

  it('carries recorded judge contradictions onto tier2', async () => {
    invokeMock.mockResolvedValue(
      raw({ outcome: 'attention', outcome_reason: REASON }, { contradictions: [CONTRADICTION] }),
    )
    const v = await runNativeTask('build the todo CLI', '/vault')
    expect(v!.tier2.contradictions).toEqual([CONTRADICTION])
  })

  it('leaves contradictions UNDEFINED when the engine recorded none (never an empty all-clear)', async () => {
    invokeMock.mockResolvedValue(raw({ outcome: 'attention' }, { contradictions: [] }))
    const v = await runNativeTask('build the todo CLI', '/vault')
    expect(v!.tier2.contradictions).toBeUndefined()
  })

  it('an OLDER verdict with no `outcome` gets none synthesised from `passed`', async () => {
    invokeMock.mockResolvedValue(raw())
    const v = await runNativeTask('build the todo CLI', '/vault')
    expect(v!.passed).toBe(false)
    expect(v!.outcome).toBeUndefined()
    expect(v!.outcomeReason).toBeUndefined()
    expect(v!.tier2.contradictions).toBeUndefined()
  })
})
