import { describe, expect, it } from 'vitest'
import { recentFailures, skillStats } from './skillStats'
import type { Verdict, NativeVerdictExtra } from '../engine/types'
import type { StoredSkill } from './skills'

// ---------------------------------------------------------------------------
// Fixtures — mirrors desk.test.ts's makeVerdict pattern: every field the
// aggregator touches gets a real value, everything else is filler.
// ---------------------------------------------------------------------------

function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 't-1',
    task: 'do the thing',
    route: {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via gateway',
      reason: 'routine',
      routeLabel: 'local · qwen2.5-coder',
    },
    tier1: { tests: '0/0', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.9, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.01,
    durationMs: 1000,
    modelRoute: '100 tok in / 50 out',
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'verdicts/t-1.json', validated: true, committed: true },
    passed: true,
    ...over,
  }
}

function makeNative(disclosed: string[], over: Partial<NativeVerdictExtra> = {}): NativeVerdictExtra {
  return {
    hooksFired: [],
    hookDecisions: [],
    blocks: 0,
    approvals: 0,
    memoryInjected: 0,
    disclosed,
    rejectedWrites: 0,
    cacheHits: 0,
    cacheMisses: 0,
    spansPath: '',
    ...over,
  }
}

/** A native verdict that disclosed the given skill names. */
function nativeVerdict(disclosed: string[], over: Partial<Verdict> = {}): Verdict {
  return makeVerdict({ native: makeNative(disclosed), ...over })
}

function makeSkill(over: Partial<Pick<StoredSkill, 'id' | 'name'>> = {}): Pick<StoredSkill, 'id' | 'name'> {
  return { id: 'skill-1', name: 'code-review', ...over }
}

// ---------------------------------------------------------------------------
// skillStats — attribution matching
// ---------------------------------------------------------------------------

describe('skillStats attribution', () => {
  it('counts a use when disclosed contains the exact skill name', () => {
    const skill = makeSkill({ name: 'code-review' })
    const verdicts = [nativeVerdict(['code-review'])]
    const stats = skillStats(verdicts, [skill])
    expect(stats.get('skill-1')?.uses).toBe(1)
  })

  it('matches case-insensitively', () => {
    const skill = makeSkill({ name: 'code-review' })
    const verdicts = [nativeVerdict(['Code-Review'])]
    const stats = skillStats(verdicts, [skill])
    expect(stats.get('skill-1')?.uses).toBe(1)
  })

  it('matches with surrounding whitespace trimmed', () => {
    const skill = makeSkill({ name: 'code-review' })
    const verdicts = [nativeVerdict(['  code-review  '])]
    const stats = skillStats(verdicts, [skill])
    expect(stats.get('skill-1')?.uses).toBe(1)
  })

  it('does not count a verdict that disclosed a different skill', () => {
    const skill = makeSkill({ name: 'code-review' })
    const verdicts = [nativeVerdict(['diff-context'])]
    const stats = skillStats(verdicts, [skill])
    expect(stats.get('skill-1')?.uses).toBe(0)
  })

  it('ignores sim verdicts without a native field entirely', () => {
    const skill = makeSkill({ name: 'code-review' })
    // No `native` at all — a browser-sim verdict.
    const verdicts = [makeVerdict()]
    const stats = skillStats(verdicts, [skill])
    expect(stats.get('skill-1')?.uses).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// skillStats — passRate + underperforming thresholds
// ---------------------------------------------------------------------------

describe('skillStats passRate + underperforming', () => {
  it('3 uses, 1 pass -> underperforming (passRate < 0.5 and uses >= 3)', () => {
    const skill = makeSkill()
    const verdicts = [
      nativeVerdict(['code-review'], { passed: true }),
      nativeVerdict(['code-review'], { passed: false }),
      nativeVerdict(['code-review'], { passed: false }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.uses).toBe(3)
    expect(stat?.passes).toBe(1)
    expect(stat?.passRate).toBeCloseTo(1 / 3)
    expect(stat?.underperforming).toBe(true)
  })

  it('2 uses, 0 pass -> NOT underperforming (below the 3-use floor)', () => {
    const skill = makeSkill()
    const verdicts = [
      nativeVerdict(['code-review'], { passed: false }),
      nativeVerdict(['code-review'], { passed: false }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.uses).toBe(2)
    expect(stat?.passes).toBe(0)
    expect(stat?.underperforming).toBe(false)
  })

  it('4 uses, 2 pass -> NOT underperforming (0.5 is not < 0.5, exact boundary)', () => {
    const skill = makeSkill()
    const verdicts = [
      nativeVerdict(['code-review'], { passed: true }),
      nativeVerdict(['code-review'], { passed: false }),
      nativeVerdict(['code-review'], { passed: true }),
      nativeVerdict(['code-review'], { passed: false }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.uses).toBe(4)
    expect(stat?.passes).toBe(2)
    expect(stat?.passRate).toBe(0.5)
    expect(stat?.underperforming).toBe(false)
  })

  it('passRate is 0 when uses === 0', () => {
    const skill = makeSkill()
    const stat = skillStats([], [skill]).get('skill-1')
    expect(stat?.uses).toBe(0)
    expect(stat?.passRate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// skillStats — lastUsedAt
// ---------------------------------------------------------------------------

describe('skillStats lastUsedAt', () => {
  it('takes `at` from the newest matching verdict (verdicts arrive newest-first)', () => {
    const skill = makeSkill()
    const verdicts = [
      nativeVerdict(['code-review'], { at: '2026-07-15T10:00:00Z' }),
      nativeVerdict(['code-review'], { at: '2026-07-10T10:00:00Z' }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.lastUsedAt).toBe('2026-07-15T10:00:00Z')
  })

  it("falls back to '' when the skill was never used", () => {
    const skill = makeSkill()
    const verdicts = [nativeVerdict(['other-skill'], { at: '2026-07-15T10:00:00Z' })]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.lastUsedAt).toBe('')
  })

  it("falls back to '' when the newest use has no `at`", () => {
    const skill = makeSkill()
    const verdicts = [nativeVerdict(['code-review'], { at: undefined })]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.lastUsedAt).toBe('')
  })
})

// ---------------------------------------------------------------------------
// skillStats — recent outcomes
// ---------------------------------------------------------------------------

describe('skillStats recent', () => {
  it('caps recent at 3, newest-first', () => {
    const skill = makeSkill()
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-4', at: '2026-07-15T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 't-3', at: '2026-07-14T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 't-2', at: '2026-07-13T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 't-1', at: '2026-07-12T00:00:00Z' }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.recent).toHaveLength(3)
    expect(stat?.recent.map((r) => r.taskId)).toEqual(['t-4', 't-3', 't-2'])
  })

  it('recent entries carry the run outcome fields', () => {
    const skill = makeSkill()
    const verdicts = [nativeVerdict(['code-review'], { taskId: 't-9', task: 'fix the bug', passed: false, at: '2026-07-15T00:00:00Z' })]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.recent[0]).toEqual({ taskId: 't-9', task: 'fix the bug', passed: false, at: '2026-07-15T00:00:00Z' })
  })
})

// ---------------------------------------------------------------------------
// skillStats — every skill keyed
// ---------------------------------------------------------------------------

describe('skillStats coverage', () => {
  it('gives every skill an entry, even at 0 uses', () => {
    const skills = [makeSkill({ id: 'skill-1', name: 'code-review' }), makeSkill({ id: 'skill-2', name: 'diff-context' })]
    const stats = skillStats([], skills)
    expect(stats.size).toBe(2)
    expect(stats.get('skill-2')).toEqual({
      uses: 0,
      passes: 0,
      attention: 0,
      decided: 0,
      passRate: 0,
      lastUsedAt: '',
      underperforming: false,
      recent: [],
    })
  })

  it('returns an empty map for an empty skill list', () => {
    const stats = skillStats([nativeVerdict(['code-review'])], [])
    expect(stats.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// recentFailures
// ---------------------------------------------------------------------------

describe('recentFailures', () => {
  it('returns only failing runs that used the skill, newest-first', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-3', passed: true, at: '2026-07-15T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false, at: '2026-07-14T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: false, at: '2026-07-13T00:00:00Z' }),
    ]
    const failures = recentFailures(verdicts, 'code-review')
    expect(failures.map((f) => f.taskId)).toEqual(['t-2', 't-1'])
    expect(failures.every((f) => f.passed === false)).toBe(true)
  })

  it('ignores failing runs that did not use the skill', () => {
    const verdicts = [nativeVerdict(['other-skill'], { passed: false })]
    expect(recentFailures(verdicts, 'code-review')).toEqual([])
  })

  it('defaults to max 3 and respects an explicit max', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-5', passed: false, at: '5' }),
      nativeVerdict(['code-review'], { taskId: 't-4', passed: false, at: '4' }),
      nativeVerdict(['code-review'], { taskId: 't-3', passed: false, at: '3' }),
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false, at: '2' }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: false, at: '1' }),
    ]
    expect(recentFailures(verdicts, 'code-review').map((f) => f.taskId)).toEqual(['t-5', 't-4', 't-3'])
    expect(recentFailures(verdicts, 'code-review', 2).map((f) => f.taskId)).toEqual(['t-5', 't-4'])
  })
})

// ---------------------------------------------------------------------------
// One verdict stream (2026-08-09): `allVerdicts` — the session + loop-run merge
// — is deleted with the loop simulator, so every projection below runs over the
// ONE real stream (the session verdict log, newest-first). The cases kept here
// are the ones that were about the projection, not about the merge.
// ---------------------------------------------------------------------------

describe('skillStats over the session verdict stream', () => {
  it('counts uses and passes over the stream', () => {
    const skill = makeSkill({ name: 'code-review' })
    const session = [
      nativeVerdict(['code-review'], { taskId: 's-2', passed: false, at: '2026-07-03T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-1', passed: true, at: '2026-07-02T00:00:00Z' }),
      nativeVerdict(['other-skill'], { taskId: 's-0', at: '2026-07-01T00:00:00Z' }),
    ]
    const stat = skillStats(session, [skill]).get('skill-1')
    expect(stat?.uses).toBe(2)
    expect(stat?.passes).toBe(1)
    expect(stat?.passRate).toBe(0.5)
  })

  it('keeps lastUsedAt/recent honest (newest-first, capped at 3)', () => {
    const skill = makeSkill({ name: 'code-review' })
    const session = [
      nativeVerdict(['code-review'], { taskId: 's-4', at: '2026-07-05T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-3', at: '2026-07-04T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-2', at: '2026-07-02T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-1', at: '2026-07-01T00:00:00Z' }),
    ]
    const stat = skillStats(session, [skill]).get('skill-1')
    expect(stat?.uses).toBe(4)
    expect(stat?.lastUsedAt).toBe('2026-07-05T00:00:00Z')
    expect(stat?.recent.map((r) => r.taskId)).toEqual(['s-4', 's-3', 's-2'])
  })

  it('fires underperforming (>=3 uses, <50% pass)', () => {
    const skill = makeSkill({ name: 'code-review' })
    const session = [
      nativeVerdict(['code-review'], { taskId: 's-3', passed: false, at: '2026-07-03T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-2', passed: false, at: '2026-07-02T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-1', passed: true, at: '2026-07-01T00:00:00Z' }),
    ]
    const stat = skillStats(session, [skill]).get('skill-1')
    expect(stat?.uses).toBe(3)
    expect(stat?.underperforming).toBe(true)
  })

  it('recentFailures reads the same stream, newest-first', () => {
    const session = [
      nativeVerdict(['code-review'], { taskId: 's-2', passed: false, at: '2026-07-02T00:00:00Z' }),
      nativeVerdict(['code-review'], { taskId: 's-1', passed: false, at: '2026-07-01T00:00:00Z' }),
    ]
    const failures = recentFailures(session, 'code-review')
    expect(failures.map((f) => f.taskId)).toEqual(['s-2', 's-1'])
  })
})

// ---------------------------------------------------------------------------
// The three-outcome counting rule (owed follow-up #2 to dc4124e)
//
// An ATTENTION run — the deterministic Tier-1 gate ran the project's checks
// over real written files and PASSED, and only the Tier-2 LLM reviewer
// dissented — is NOT a pass. But counting it identically to a hard failure
// understated real work and let an LLM opinion mark down a measurement. The
// rule: hold it OUT of the pass-rate denominator, and state its count.
// ---------------------------------------------------------------------------

describe('skillStats — an attention run is neither a pass nor a failure', () => {
  const skill = makeSkill({ name: 'code-review' })

  it('leaves the denominator and is counted on its own', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-3', passed: false, outcome: 'attention' }),
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false, outcome: 'failed' }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: true, outcome: 'passed' }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.uses).toBe(3)
    expect(stat?.passes).toBe(1)
    expect(stat?.attention).toBe(1)
    expect(stat?.decided).toBe(2)
    // 1 of 2 DECIDED = 50%. Not 1/3 (attention priced as a failure, the old
    // behaviour) and not 2/3 (attention priced as a pass, which the engine
    // explicitly refuses).
    expect(stat?.passRate).toBe(0.5)
  })

  it('does not count as a pass', () => {
    const stat = skillStats(
      [nativeVerdict(['code-review'], { passed: false, outcome: 'attention' })],
      [skill],
    ).get('skill-1')
    expect(stat?.passes).toBe(0)
    expect(stat?.passRate).toBe(0)
    expect(stat?.uses).toBe(1)
  })

  it('a skill whose runs ALL merely needed a look is not branded underperforming', () => {
    // Three green-checks runs the reviewer disliked. Under the old rule this
    // was "0% pass over 3 uses" and went straight to the AI-improve gate.
    const verdicts = [1, 2, 3].map((n) =>
      nativeVerdict(['code-review'], { taskId: `t-${n}`, passed: false, outcome: 'attention' }),
    )
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.attention).toBe(3)
    expect(stat?.decided).toBe(0)
    expect(stat?.underperforming).toBe(false)
  })

  it('real failures still brand a skill underperforming (the gate did not go soft)', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-4', passed: false, outcome: 'failed' }),
      nativeVerdict(['code-review'], { taskId: 't-3', passed: false, outcome: 'failed' }),
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false, outcome: 'failed' }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: true, outcome: 'passed' }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.decided).toBe(4)
    expect(stat?.underperforming).toBe(true)
  })

  it('carries the outcome onto each recent run so the drawer can mark it', () => {
    const stat = skillStats(
      [nativeVerdict(['code-review'], { passed: false, outcome: 'attention' })],
      [skill],
    ).get('skill-1')
    expect(stat?.recent[0].outcome).toBe('attention')
    expect(stat?.recent[0].passed).toBe(false)
  })

  it('an OLD verdict with no `outcome` counts exactly as it always did', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: true }),
    ]
    const stat = skillStats(verdicts, [skill]).get('skill-1')
    expect(stat?.attention).toBe(0)
    expect(stat?.decided).toBe(2)
    expect(stat?.passRate).toBe(0.5)
    expect(stat?.recent[0].outcome).toBeUndefined()
  })
})

describe('recentFailures — "failures" means failures', () => {
  it('excludes an attention run: its checks passed, so it is not evidence of a broken skill', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-2', passed: false, outcome: 'attention' }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: false, outcome: 'failed' }),
    ]
    expect(recentFailures(verdicts, 'code-review').map((f) => f.taskId)).toEqual(['t-1'])
  })

  it('still excludes passes, and still includes a legacy non-pass', () => {
    const verdicts = [
      nativeVerdict(['code-review'], { taskId: 't-2', passed: true }),
      nativeVerdict(['code-review'], { taskId: 't-1', passed: false }),
    ]
    expect(recentFailures(verdicts, 'code-review').map((f) => f.taskId)).toEqual(['t-1'])
  })
})
