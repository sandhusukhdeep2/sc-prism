import { describe, expect, it } from 'vitest'
import {
  contradictionLine,
  isAttention,
  judgeContradictions,
  recordedOutcome,
  tally,
  tallyLabel,
  verdictTone,
} from './verdictOutcome'

/**
 * The one place the app decides what a three-valued outcome MEANS, and the one
 * counting rule every pass rate in the app is built from (owed follow-up #2 to
 * dc4124e).
 *
 * THE RULE: an ATTENTION run — the deterministic checks ran over real written
 * files and PASSED, only the LLM reviewer dissented — is excluded from the
 * pass-rate DENOMINATOR, and its count is stated wherever the rate is shown.
 * Counting it as a pass would claim a pass the engine refuses to give; counting
 * it as a failure lets an opinion mark down a measurement.
 */

const legacyPass = { passed: true }
const legacyFail = { passed: false }
const passed = { passed: true, outcome: 'passed' as const }
const attention = { passed: false, outcome: 'attention' as const }
const failed = { passed: false, outcome: 'failed' as const }
// A chat turn the judge cleared. `passed` is true (a good reply is a success),
// but it is CONVERSATION — counting it in a rate about task work poisons the
// rate in whichever direction it falls.
const replied = { passed: true, outcome: 'replied' as const }

describe('attention is only ever what the engine recorded', () => {
  it('is true only for a literal `outcome: attention`', () => {
    expect(isAttention(attention)).toBe(true)
    expect(isAttention(failed)).toBe(false)
    expect(isAttention(passed)).toBe(false)
  })

  it('is NEVER synthesised for a verdict that predates the field', () => {
    expect(isAttention(legacyFail)).toBe(false)
    expect(isAttention(legacyPass)).toBe(false)
    expect(recordedOutcome(legacyFail)).toBeUndefined()
  })
})

describe('verdictTone — how a surface should draw a verdict', () => {
  it('maps the engine’s three values straight through', () => {
    expect(verdictTone(passed)).toBe('passed')
    expect(verdictTone(attention)).toBe('attention')
    expect(verdictTone(failed)).toBe('failed')
  })

  it('an unrecorded non-pass is UNKNOWN, not failed — so it renders as it always did', () => {
    expect(verdictTone(legacyFail)).toBe('unknown-nonpass')
    expect(verdictTone(legacyPass)).toBe('passed')
  })
})

describe('judge contradictions', () => {
  const claim = 'judge called it truncated over 6 files on disk behind a passing gate'

  it('are surfaced with what they mean when recorded', () => {
    const line = contradictionLine({ tier2: { contradictions: [claim] } } as never)
    expect(line).toContain(claim)
    expect(line).toContain('unreliable')
  })

  it('produce nothing at all when none were recorded (no clean bill of health)', () => {
    expect(contradictionLine({ tier2: {} } as never)).toBe('')
    expect(judgeContradictions({ tier2: {} })).toEqual([])
    expect(judgeContradictions({})).toEqual([])
  })
})

describe('tally — four outcomes counted as four', () => {
  it('holds attention out of the denominator and reports it on its own', () => {
    const t = tally([passed, passed, attention, failed])
    expect(t).toEqual({ runs: 4, passes: 2, attention: 1, replied: 0, decided: 3, passRate: 2 / 3 })
  })

  it('an attention run is neither a pass nor a failure', () => {
    const t = tally([attention])
    expect(t.passes).toBe(0) // not a pass
    expect(t.decided).toBe(0) // and not counted against anything either
    expect(t.passRate).toBe(0)
  })

  it('all-attention: the rate has no denominator, and the label says so', () => {
    const t = tally([attention, attention])
    expect(t).toMatchObject({ runs: 2, attention: 2, decided: 0 })
    expect(tallyLabel(t)).toBe('no decided runs · 2 needed a look')
  })

  it('legacy verdicts tally exactly as they did before', () => {
    const t = tally([legacyPass, legacyFail, legacyFail])
    expect(t).toEqual({ runs: 3, passes: 1, attention: 0, replied: 0, decided: 3, passRate: 1 / 3 })
  })

  it('empty', () => {
    expect(tally([])).toEqual({ runs: 0, passes: 0, attention: 0, replied: 0, decided: 0, passRate: 0 })
  })
})

describe('replied — a chat turn leaves the rate the way attention does', () => {
  // The real number this rule exists for: 32 chat turns on one model read
  // "3% pass" on the team card. Folding a reply into the failures marks task
  // work down for conversation; folding it into the passes would inflate the
  // same rate with turns that verified nothing. It leaves the denominator.
  it('maps to its own tone', () => {
    expect(verdictTone(replied)).toBe('replied')
  })

  it('is never synthesised — passed alone stays passed', () => {
    expect(verdictTone(legacyPass)).toBe('passed')
  })

  it('is held out of the pass-rate denominator, exactly like attention', () => {
    const t = tally([passed, failed, replied, replied])
    expect(t).toEqual({ runs: 4, passes: 1, attention: 0, replied: 2, decided: 2, passRate: 1 / 2 })
  })

  it('a replied run is not a pass on the tally, despite passed=true', () => {
    const t = tally([replied])
    expect(t.passes).toBe(0)
    expect(t.decided).toBe(0)
    expect(t.passRate).toBe(0)
  })

  it('the label names held-out replies alongside the rate', () => {
    expect(tallyLabel(tally([passed, failed, replied]))).toBe(
      '50% pass of 2 decided runs · 1 reply (chat, not counted)',
    )
  })

  it('all-replied: no task-work rate is claimed at all', () => {
    expect(tallyLabel(tally([replied, replied]))).toBe('no task runs · 2 replies')
  })
})

describe('tallyLabel — every rate names what it counts', () => {
  it('states the denominator', () => {
    expect(tallyLabel(tally([passed, failed]))).toBe('50% pass of 2 decided runs')
  })

  it('states the held-out attention count alongside the rate', () => {
    expect(tallyLabel(tally([passed, failed, attention]))).toBe(
      '50% pass of 2 decided runs · 1 needed a look (not counted)',
    )
  })

  it('singularises one decided run', () => {
    expect(tallyLabel(tally([passed]))).toBe('100% pass of 1 decided run')
  })

  it('says "no runs yet" rather than 0%', () => {
    expect(tallyLabel(tally([]))).toBe('no runs yet')
  })

  it('never prints a bare percentage with nothing to anchor it', () => {
    for (const set of [[passed], [failed], [passed, attention], [attention]]) {
      const label = tallyLabel(tally(set))
      if (label.includes('%')) expect(label).toMatch(/of \d+ decided run/)
    }
  })
})
