import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_REFINES,
  mergeReadiness,
  nextRunAction,
  refineIntent,
  stepIntent,
  stepNote,
  verdictFeedback,
} from './projectRun'
import type { Verdict } from '../engine/types'
import type { Project } from './projects'

// Minimal-but-valid Verdict fixture — every field nextRunAction/verdictFeedback
// touches gets a real value; everything else is filler so the shape type-checks.
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

const plan3 = ['scaffold', 'implement', 'test']

describe('nextRunAction', () => {
  it('advances to the next step after a pass', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 0,
      lastPassed: true,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'step', index: 1, refine: false })
  })

  it('advances again from a middle index after a pass', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 1,
      refinePass: 0,
      lastPassed: true,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'step', index: 2, refine: false })
  })

  it('finishes done when the last step passes', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 2,
      refinePass: 0,
      lastPassed: true,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'finish', status: 'done' })
  })

  it('finishes done on a single-step plan', () => {
    const action = nextRunAction({
      plan: ['only'],
      stepIndex: 0,
      refinePass: 0,
      lastPassed: true,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'finish', status: 'done' })
  })

  it('a pass after a refine still advances (refinePass is irrelevant once passed)', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 2,
      lastPassed: true,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'step', index: 1, refine: false })
  })

  it('a failed fresh step (refinePass 0) asks for refine pass 1', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 0,
      lastPassed: false,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'refine', pass: 1 })
  })

  it('a second failure (refinePass 1, below max 2) asks for refine pass 2', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 1,
      lastPassed: false,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'refine', pass: 2 })
  })

  it('refines exhausted at the max (2) with no answer yet asks the user', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 2,
      lastPassed: false,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'ask-extra-refine' })
  })

  it('a granted extra refine yields exactly one more refine pass (max + 1)', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 2,
      lastPassed: false,
      extraRefineGranted: true,
    })
    expect(action).toEqual({ kind: 'refine', pass: 3 })
  })

  it('a declined extra refine finishes attention', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 2,
      lastPassed: false,
      extraRefineGranted: false,
    })
    expect(action).toEqual({ kind: 'finish', status: 'attention' })
  })

  it('the granted extra refine failing too finishes attention outright — no re-ask', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 3,
      lastPassed: false,
      extraRefineGranted: true,
    })
    expect(action).toEqual({ kind: 'finish', status: 'attention' })
  })

  it('refinePass past max with no answer still finishes attention (never re-asks)', () => {
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 3,
      lastPassed: false,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'finish', status: 'attention' })
  })

  it('honors a custom maxRefines (1): first failure refines, second asks', () => {
    const first = nextRunAction(
      { plan: plan3, stepIndex: 0, refinePass: 0, lastPassed: false, extraRefineGranted: null },
      1,
    )
    expect(first).toEqual({ kind: 'refine', pass: 1 })
    const second = nextRunAction(
      { plan: plan3, stepIndex: 0, refinePass: 1, lastPassed: false, extraRefineGranted: null },
      1,
    )
    expect(second).toEqual({ kind: 'ask-extra-refine' })
  })

  it('defaults maxRefines to DEFAULT_MAX_REFINES (2) when omitted', () => {
    expect(DEFAULT_MAX_REFINES).toBe(2)
    const action = nextRunAction({
      plan: plan3,
      stepIndex: 0,
      refinePass: 2,
      lastPassed: false,
      extraRefineGranted: null,
    })
    expect(action).toEqual({ kind: 'ask-extra-refine' })
  })
})

describe('stepIntent', () => {
  it('produces the exact copy for a mid-plan step', () => {
    expect(stepIntent('Build a portfolio site', plan3, 1)).toBe(
      'Project goal: Build a portfolio site\nStep 2 of 3: implement',
    )
  })

  it('produces the exact copy for the first step', () => {
    expect(stepIntent('Ship the CLI', plan3, 0)).toBe('Project goal: Ship the CLI\nStep 1 of 3: scaffold')
  })

  it('produces the exact copy for the last step', () => {
    expect(stepIntent('Ship the CLI', plan3, 2)).toBe('Project goal: Ship the CLI\nStep 3 of 3: test')
  })
})

describe('refineIntent', () => {
  it('produces the exact copy for a refine pass', () => {
    expect(refineIntent('Build a portfolio site', 'Tier-1 checks failed (0/3).', 1)).toBe(
      'Project goal: Build a portfolio site\n' +
        'Refine attempt 1: the previous attempt did not pass verification. ' +
        'Fix this and complete the step:\nTier-1 checks failed (0/3).',
    )
  })

  it('produces the exact copy for a later pass number', () => {
    expect(refineIntent('Ship the CLI', 'The judge flagged a missing test.', 3)).toBe(
      'Project goal: Ship the CLI\n' +
        'Refine attempt 3: the previous attempt did not pass verification. ' +
        'Fix this and complete the step:\nThe judge flagged a missing test.',
    )
  })
})

describe('verdictFeedback', () => {
  it('prefers the tier1 failure text when tier1 failed', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '0/3', lint: false, build: false, pass: false },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      response: 'I would have written the file but tests failed.',
    })
    expect(verdictFeedback(v)).toBe('Tier-1 checks failed (0/3). Fix the failing checks and try again.')
  })

  it('falls back to the real completion text when tier1 passed but the run still failed', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '3/3', lint: true, build: true, pass: true },
      tier2: { evalScore: 0.2, passed: false, judge: 'DeepEval judge', trajectory: 'trajectory broke' },
      response: 'The eval judge rejected this because the API contract changed.',
    })
    expect(verdictFeedback(v)).toBe('The eval judge rejected this because the API contract changed.')
  })

  it('gives a generic message when there is no real completion text to quote', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '3/3', lint: true, build: true, pass: true },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      response: undefined,
    })
    expect(verdictFeedback(v)).toBe('The previous attempt did not pass verification.')
  })

  it('treats an offline/stub completion as not real, same as no completion', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '3/3', lint: true, build: true, pass: true },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      response: '[offline: no provider configured]',
    })
    expect(verdictFeedback(v)).toBe('The previous attempt did not pass verification.')
  })

  // Regression tests for C2: refine feedback lacked the real failure output —
  // the model only ever saw the synthesized "Tier-1 checks failed (0/3)"
  // summary, never the actual command output that would tell it WHAT to fix.
  it('prefers the real tier1 log text over the synthesized summary when tier1 failed', () => {
    const v = makeVerdict({
      passed: false,
      tier1: {
        tests: '0/3',
        lint: false,
        build: false,
        pass: false,
        log: 'FAILED tests/test_app.py::test_index - AssertionError: 404 != 200',
      },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      response: 'I would have written the file but tests failed.',
    })
    expect(verdictFeedback(v)).toBe(
      'FAILED tests/test_app.py::test_index - AssertionError: 404 != 200',
    )
  })

  it('falls back to the synthesized summary when tier1 failed but no log text is present', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '0/3', lint: false, build: false, pass: false },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      response: 'I would have written the file but tests failed.',
    })
    expect(verdictFeedback(v)).toBe('Tier-1 checks failed (0/3). Fix the failing checks and try again.')
  })

  it('falls back to the synthesized summary when tier1.log is present but blank', () => {
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '0/3', lint: false, build: false, pass: false, log: '   ' },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
    })
    expect(verdictFeedback(v)).toBe('Tier-1 checks failed (0/3). Fix the failing checks and try again.')
  })

  it('truncates a very long tier1 log to ~2000 chars', () => {
    const longLog = 'x'.repeat(5000)
    const v = makeVerdict({
      passed: false,
      tier1: { tests: '0/3', lint: false, build: false, pass: false, log: longLog },
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
    })
    const feedback = verdictFeedback(v)
    expect(feedback.length).toBeLessThanOrEqual(2001)
    expect(feedback.startsWith('x'.repeat(100))).toBe(true)
  })
})

// V2-5: existing-mode driver reads verdict.project.overwrote (which written
// paths already existed) into the step's lastNote, so the Projects page can
// surface "changed N existing files" without re-deriving it from the raw
// Verdict. Pure so it's unit-testable without the store.
describe('stepNote', () => {
  it('returns the base note unchanged when overwrote is absent (new-mode / no field)', () => {
    expect(stepNote('Wrote PROJECT.md')).toBe('Wrote PROJECT.md')
  })

  it('appends a " · changed N existing file(s)" suffix when overwrote is non-empty', () => {
    expect(stepNote('Wrote PROJECT.md', ['src/index.ts'])).toBe(
      'Wrote PROJECT.md · changed 1 existing file',
    )
    expect(stepNote('Wrote PROJECT.md', ['a.ts', 'b.ts', 'c.ts'])).toBe(
      'Wrote PROJECT.md · changed 3 existing files',
    )
  })

  it('returns the base note unchanged when overwrote is present but zero-length', () => {
    expect(stepNote('Wrote PROJECT.md', [])).toBe('Wrote PROJECT.md')
  })
})

// V2-5: drives the Projects page Merge button's visibility/label — 'ready'
// only once a run branch exists AND the driver isn't currently using it.
// Minimal-but-valid Project fixture, same pattern as AppStore.project.test.ts.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'demo',
    slug: 'demo',
    path: '/tmp/demo',
    goal: 'ship it',
    verifyCommand: '',
    createdAt: 0,
    status: 'done',
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    mode: 'existing',
    baseBranch: 'main',
    runBranch: 'scprism/demo-1',
    ...over,
  }
}

describe('mergeReadiness', () => {
  it('is "ready" when a run branch exists and the project is not running', () => {
    expect(mergeReadiness(makeProject({ status: 'done' }))).toBe('ready')
    expect(mergeReadiness(makeProject({ status: 'attention' }))).toBe('ready')
  })

  it('is "running" while the project is running, regardless of runBranch', () => {
    expect(mergeReadiness(makeProject({ status: 'running' }))).toBe('running')
    expect(mergeReadiness(makeProject({ status: 'running', runBranch: '' }))).toBe('running')
  })

  it('is "running" while the project is awaiting the extra-refine ask', () => {
    expect(mergeReadiness(makeProject({ status: 'awaiting' }))).toBe('running')
  })

  it('is "no-branch" when there is no run branch to merge, even if idle', () => {
    expect(mergeReadiness(makeProject({ status: 'done', runBranch: '' }))).toBe('no-branch')
    expect(mergeReadiness(makeProject({ status: 'done', runBranch: undefined }))).toBe('no-branch')
  })

  // FIX 1 (v2 final review — merge target guard): a run killed during step 1
  // (before any step ever passed) leaves runBranch set but baseBranch still
  // '' — the sticky case. There is nothing honest to pass as `into`, so the
  // Merge button must not render at all.
  it('is "no-branch" when runBranch is set but baseBranch is empty (killed during step 1)', () => {
    expect(mergeReadiness(makeProject({ status: 'attention', runBranch: 'scprism/demo-1', baseBranch: '' })))
      .toBe('no-branch')
    expect(mergeReadiness(makeProject({ status: 'done', runBranch: 'scprism/demo-1', baseBranch: undefined })))
      .toBe('no-branch')
  })

  it('prioritizes "running" over a missing branch when both are true', () => {
    expect(mergeReadiness(makeProject({ status: 'running', runBranch: '' }))).toBe('running')
  })
})
