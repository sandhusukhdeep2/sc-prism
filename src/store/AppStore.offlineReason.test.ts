// A killed CLI is not an absent provider (2026-08-15).
//
// The user's spans showed two `claude-cli` calls running 48 minutes against a
// "180s" bound and then answering for real, long after the app had cancelled
// the run — and every beat in between read "stopped at 240s (possibly waiting
// on a held tool approval)" while the pending-approval dir was empty. With the
// engine's bound now enforceable, it reports the cause in its own words; the
// app must repeat those words instead of flattening them into "offline".
import { describe, expect, it } from 'vitest'
import { WAKE_TIMEOUT_MS, isRealCompletion, offlineReason } from './AppStore'

describe('offlineReason', () => {
  it('surfaces the engine-named cause of a killed CLI call', () => {
    expect(
      offlineReason('[offline:claude-cli:opus] the claude CLI did not answer within 180s'),
    ).toBe('the claude CLI did not answer within 180s')
  })

  it('says nothing for the deterministic offline stub (no cause to name)', () => {
    expect(offlineReason('[offline:claude-cli:opus] handled: plan the week (a1b2c3d4)')).toBe('')
  })

  it('says nothing for real model output or an empty reply', () => {
    expect(offlineReason('Here is the plan for the week.')).toBe('')
    expect(offlineReason('')).toBe('')
    expect(offlineReason(undefined)).toBe('')
  })

  it('leaves the not-real classification alone — a timeout is still not an answer', () => {
    const timedOut = '[offline:claude-cli:opus] the claude CLI did not answer within 180s'
    expect(isRealCompletion(timedOut)).toBe(false)
    expect(offlineReason(timedOut)).not.toBe('')
  })
})

describe('WAKE_TIMEOUT_MS', () => {
  it('stays above the engine per-call bound so the ENGINE loses the race first', () => {
    // gateway.py CLI_TIMEOUT_DEFAULT = 180s. If the client cancel ever met or
    // dropped below it, the client would always win and the engine could never
    // report why — the exact failure this pair of numbers exists to prevent.
    //
    // The INVARIANT is asserted, not the number. The wall is derived from the
    // wake's own turn budget (see AppStore.timeout.test.ts, which pins the
    // derivation); pinning a literal here made a correct widening of that
    // budget look like a regression.
    expect(WAKE_TIMEOUT_MS).toBeGreaterThan(180_000)
  })
})
