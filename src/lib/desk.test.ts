import { describe, expect, it } from 'vitest'
import {
  buildDeskItems,
  buildPhase,
  buildProgressMeta,
  freeStandingSchedules,
  greeting,
  groupProjectSchedules,
  nextDueSchedule,
  passRate,
  passRateChipClass,
  proposalEvidenceHead,
  proposalEvidenceRuns,
  proposalReadingLine,
  proposalModelLine,
  proposalTouchLine,
  recentManagerRuns,
  recentProjects,
  statusLine,
  type DeskInputs,
  type DeskItem,
} from './desk'
import type { ManagerJob, ManagersState } from './managers'
import type { Project } from './projects'
import type { Notice } from '../store/AppStore'
import type { Verdict } from '../engine/types'
import type { Schedule } from './schedules'
import type { AgentProposal } from './agentProposals'
import type { QuestionSet } from './businessInterview'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'portfolio-site',
    slug: 'portfolio-site',
    path: '/tmp/portfolio-site',
    goal: 'build it',
    verifyCommand: 'npm test',
    createdAt: 1000,
    status: 'new',
    brief: '',
    plan: ['scaffold', 'implement', 'test', 'polish', 'ship'],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    mode: 'new',
    baseBranch: '',
    runBranch: '',
    ...over,
  }
}

function makeManager(over: Partial<ManagersState['managers'][number]> = {}) {
  return {
    id: 'mgr-local',
    providerId: 'local',
    name: 'Local manager',
    enabled: true,
    ...over,
  }
}

function makeJob(over: Partial<ManagerJob> = {}): ManagerJob {
  return {
    id: 'job-1',
    managerId: 'mgr-local',
    title: 'Cost review',
    department: 'finance',
    prompt: 'review costs',
    everyMinutes: 60,
    lastRun: 0,
    runs: [],
    ...over,
  }
}

function makeManagersState(over: Partial<ManagersState> = {}): ManagersState {
  return { managers: [makeManager()], jobs: [], seeded: true, ...over }
}

function makeNotice(over: Partial<Notice> = {}): Notice {
  return { id: 'n-1', projectId: 'proj-1', text: 'one more refine?', kind: 'request', ...over }
}

// Minimal-but-valid Verdict fixture — mirrors src/lib/projectRun.test.ts's
// makeVerdict pattern: every field the aggregator touches gets a real value,
// everything else is filler so the shape type-checks.
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

function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch-1',
    task: 'vault sweep',
    everyMinutes: 60,
    agents: '',
    enabled: true,
    lastRun: 0,
    runs: [],
    ...over,
  }
}

const emptyInputs: DeskInputs = {
  managers: { managers: [], jobs: [], seeded: true },
  projects: [],
  notices: [],
  anyDown: false,
  bannerDismissed: false,
  downSummary: '',
}

// ---------------------------------------------------------------------------
// buildDeskItems
// ---------------------------------------------------------------------------

describe('buildDeskItems', () => {
  it('returns [] when everything is empty', () => {
    expect(buildDeskItems(emptyInputs)).toEqual([])
  })

  it('produces exact ordering across all four kinds present at once: project-ask, dispatch, project-attention, connectivity', () => {
    const projects: Project[] = [
      makeProject({ id: 'p-ask', name: 'ask-project', status: 'awaiting', lastNote: 'fallback note' }),
      makeProject({ id: 'p-att', name: 'attn-project', status: 'attention', lastNote: 'stalled here' }),
    ]
    const jobs: ManagerJob[] = [
      makeJob({ id: 'j-dispatch', kind: 'dispatch', pendingSince: 500, title: 'Ship report', department: 'ops' }),
    ]
    const inputs: DeskInputs = {
      managers: { managers: [makeManager({ id: 'mgr-local', name: 'Local manager' })], jobs, seeded: true },
      projects,
      notices: [makeNotice({ projectId: 'p-ask', text: 'one more try?' })],
      anyDown: true,
      bannerDismissed: true,
      downSummary: 'Local model — unreachable',
    }

    const items = buildDeskItems(inputs)
    expect(items.map((i) => i.kind)).toEqual([
      'project-ask',
      'dispatch',
      'project-attention',
      'connectivity',
    ])
    expect(items).toEqual<DeskItem[]>([
      { kind: 'project-ask', projectId: 'p-ask', title: 'ask-project', detail: 'one more try?' },
      { kind: 'dispatch', jobId: 'j-dispatch', title: 'Ship report', detail: 'Local manager · ops' },
      { kind: 'project-attention', projectId: 'p-att', title: 'attn-project', detail: 'stalled here' },
      { kind: 'connectivity', title: 'Connectivity issue', detail: 'Local model — unreachable' },
    ])
  })

  describe('project-ask (each source alone)', () => {
    it('detail uses the latest matching request notice when present', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        projects: [makeProject({ id: 'p1', status: 'awaiting', lastNote: 'fallback' })],
        notices: [
          makeNotice({ projectId: 'p1', kind: 'request', text: 'older ask' }),
          makeNotice({ projectId: 'p1', kind: 'request', text: 'newest ask' }),
          makeNotice({ projectId: 'other', kind: 'request', text: 'not this project' }),
          makeNotice({ projectId: 'p1', kind: 'attention', text: 'wrong kind' }),
        ],
      }
      expect(buildDeskItems(inputs)).toEqual([
        { kind: 'project-ask', projectId: 'p1', title: 'portfolio-site', detail: 'newest ask' },
      ])
    })

    it('falls back to lastNote when there is no matching request notice', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        projects: [makeProject({ id: 'p1', status: 'awaiting', lastNote: 'fallback note' })],
        notices: [makeNotice({ projectId: 'p1', kind: 'attention', text: 'irrelevant' })],
      }
      expect(buildDeskItems(inputs)).toEqual([
        { kind: 'project-ask', projectId: 'p1', title: 'portfolio-site', detail: 'fallback note' },
      ])
    })

    it('ignores non-awaiting projects', () => {
      const inputs: DeskInputs = { ...emptyInputs, projects: [makeProject({ status: 'planned' })] }
      expect(buildDeskItems(inputs)).toEqual([])
    })
  })

  describe('dispatch (each source alone)', () => {
    it('includes a parked dispatch job with manager name + department', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: {
          managers: [makeManager({ id: 'mgr-a', name: 'Gemini manager' })],
          jobs: [makeJob({ id: 'j1', managerId: 'mgr-a', kind: 'dispatch', pendingSince: 10, title: 'Refactor', department: 'engineering' })],
          seeded: true,
        },
      }
      expect(buildDeskItems(inputs)).toEqual([
        { kind: 'dispatch', jobId: 'j1', title: 'Refactor', detail: 'Gemini manager · engineering' },
      ])
    })

    it('includes a parked team job with manager name + department (regression: team jobs park by default)', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: {
          managers: [makeManager({ id: 'mgr-a', name: 'Claude manager' })],
          jobs: [makeJob({ id: 'j1', managerId: 'mgr-a', kind: 'team', pendingSince: 10, title: 'Architecture review', department: 'engineering' })],
          seeded: true,
        },
      }
      expect(buildDeskItems(inputs)).toEqual([
        { kind: 'dispatch', jobId: 'j1', title: 'Architecture review', detail: 'Claude manager · engineering' },
      ])
    })

    it('falls back to "manager" when the manager is missing', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: {
          managers: [],
          jobs: [makeJob({ id: 'j1', managerId: 'ghost', kind: 'dispatch', pendingSince: 10, department: 'ops' })],
          seeded: true,
        },
      }
      expect(buildDeskItems(inputs)[0]).toEqual({
        kind: 'dispatch',
        jobId: 'j1',
        title: 'Cost review',
        detail: 'manager · ops',
      })
    })

    it('excludes non-dispatch, non-team jobs (report kind)', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: makeManagersState({ jobs: [makeJob({ kind: 'report', pendingSince: 10 })] }),
      }
      expect(buildDeskItems(inputs)).toEqual([])
    })

    it('excludes dispatch jobs that are not parked (pendingSince 0 or unset)', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: makeManagersState({
          jobs: [
            makeJob({ id: 'j1', kind: 'dispatch', pendingSince: 0 }),
            makeJob({ id: 'j2', kind: 'dispatch' }),
          ],
        }),
      }
      expect(buildDeskItems(inputs)).toEqual([])
    })

    it('excludes team jobs that are not parked (pendingSince 0 or unset)', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        managers: makeManagersState({
          jobs: [
            makeJob({ id: 'j1', kind: 'team', pendingSince: 0 }),
            makeJob({ id: 'j2', kind: 'team' }),
          ],
        }),
      }
      expect(buildDeskItems(inputs)).toEqual([])
    })
  })

  describe('tool-approval (held MCP tool calls)', () => {
    it('builds one honest item per held call, after the dispatch items', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        heldToolCalls: [
          { server: 'fs', tool: 'write_file', why: 'path=/tmp/a', at: 200 },
          { server: 'echo', tool: 'add', at: 100 },
        ],
      }
      const items = buildDeskItems(inputs)
      expect(items.map((i) => i.kind)).toEqual(['tool-approval', 'tool-approval'])
      // The row leads with the tool IDENTITY (server · tool); the status phrase
      // "held for your approval" (+ any why) moves to the secondary detail line.
      // `name` stays the tool name the engine grants.
      expect(items[0]).toEqual({
        kind: 'tool-approval',
        name: 'write_file',
        server: 'fs',
        tool: 'write_file',
        at: 200,
        title: 'fs · write_file',
        detail: 'held for your approval — path=/tmp/a',
      })
      expect(items[1]).toEqual({
        kind: 'tool-approval',
        name: 'add',
        server: 'echo',
        tool: 'add',
        at: 100,
        title: 'echo · add',
        detail: 'held for your approval',
      })
    })

    it('is absent when heldToolCalls is [] or omitted (byte-identical to before)', () => {
      expect(buildDeskItems({ ...emptyInputs, heldToolCalls: [] })).toEqual([])
      expect(buildDeskItems(emptyInputs)).toEqual([])
    })
  })

  describe('live-approval (paused runs — the most urgent, at the TOP)', () => {
    it('builds a live-approval item from a pending request, LEADING everything (ahead of tool-approval)', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        heldToolCalls: [{ server: 'echo', tool: 'add', at: 100 }],
        // `at` is wall-clock epoch SECONDS (200) — the item converts to ms (200000).
        pendingApprovals: [{ id: 'abc123', run_id: 'r1', server: 'fs', tool: 'write_file', args_summary: '{"p":1}', at: 200 }],
      }
      const items = buildDeskItems(inputs)
      // live-approval must be item #0 — before tool-approval.
      expect(items.map((i) => i.kind)).toEqual(['live-approval', 'tool-approval'])
      expect(items[0]).toEqual({
        kind: 'live-approval',
        id: 'abc123',
        server: 'fs',
        tool: 'write_file',
        at: 200_000, // seconds → ms
        title: 'Build paused — fs · write_file needs your approval to run',
        detail: '{"p":1}',
      })
    })

    it('falls back to an honest waiting detail when args_summary is empty/absent', () => {
      const items = buildDeskItems({
        ...emptyInputs,
        pendingApprovals: [{ id: 'x', server: 'echo', tool: 'add' }],
      })
      expect(items).toEqual([
        {
          kind: 'live-approval',
          id: 'x',
          server: 'echo',
          tool: 'add',
          at: undefined,
          title: 'Build paused — echo · add needs your approval to run',
          detail: 'The run is waiting for your decision to continue.',
        },
      ])
    })

    it('is absent when pendingApprovals is [] or omitted (byte-identical to before)', () => {
      expect(buildDeskItems({ ...emptyInputs, pendingApprovals: [] })).toEqual([])
      expect(buildDeskItems(emptyInputs)).toEqual([])
    })
  })

  describe('project-attention (each source alone)', () => {
    it('includes attention projects with lastNote as detail', () => {
      const inputs: DeskInputs = {
        ...emptyInputs,
        projects: [makeProject({ id: 'p1', name: 'stalled-app', status: 'attention', lastNote: 'run interrupted' })],
      }
      expect(buildDeskItems(inputs)).toEqual([
        { kind: 'project-attention', projectId: 'p1', title: 'stalled-app', detail: 'run interrupted' },
      ])
    })

    it('ignores non-attention projects', () => {
      const inputs: DeskInputs = { ...emptyInputs, projects: [makeProject({ status: 'done' })] }
      expect(buildDeskItems(inputs)).toEqual([])
    })
  })

  describe('connectivity gating (4 combos)', () => {
    it('anyDown=false, bannerDismissed=false -> absent', () => {
      expect(buildDeskItems({ ...emptyInputs, anyDown: false, bannerDismissed: false })).toEqual([])
    })
    it('anyDown=false, bannerDismissed=true -> absent', () => {
      expect(buildDeskItems({ ...emptyInputs, anyDown: false, bannerDismissed: true })).toEqual([])
    })
    it('anyDown=true, bannerDismissed=false -> absent (the banner covers this case)', () => {
      expect(buildDeskItems({ ...emptyInputs, anyDown: true, bannerDismissed: false })).toEqual([])
    })
    it('anyDown=true, bannerDismissed=true -> present, detail = downSummary', () => {
      const items = buildDeskItems({
        ...emptyInputs,
        anyDown: true,
        bannerDismissed: true,
        downSummary: 'Local model — unreachable',
      })
      expect(items).toEqual([
        { kind: 'connectivity', title: 'Connectivity issue', detail: 'Local model — unreachable' },
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// greeting
// ---------------------------------------------------------------------------

describe('greeting', () => {
  // Fixed local-time epochs. Constructed via new Date(y,m,d,h,m) which is
  // interpreted in the test runner's local timezone, matching the
  // implementation's own `new Date(now).getHours()`.
  const at = (h: number, m: number) => new Date(2026, 6, 13, h, m).getTime()

  it('morning just before noon (11:59) with no name', () => {
    expect(greeting(at(11, 59), '')).toBe('Good morning')
  })

  it('afternoon exactly at noon (12:00)', () => {
    expect(greeting(at(12, 0), '')).toBe('Good afternoon')
  })

  it('afternoon just before 17:00 (16:59)', () => {
    expect(greeting(at(16, 59), '')).toBe('Good afternoon')
  })

  it('evening exactly at 17:00', () => {
    expect(greeting(at(17, 0), '')).toBe('Good evening')
  })

  it('appends ", Name" when name is non-empty', () => {
    expect(greeting(at(9, 0), 'Sukh')).toBe('Good morning, Sukh')
  })

  it('no suffix when name is empty', () => {
    expect(greeting(at(20, 0), '')).toBe('Good evening')
  })
})

// ---------------------------------------------------------------------------
// statusLine
// ---------------------------------------------------------------------------

describe('statusLine', () => {
  it('is "" when no items and no running project', () => {
    expect(statusLine([], undefined)).toBe('')
  })

  it('singular: "1 thing needs your decision"', () => {
    const items: DeskItem[] = [{ kind: 'connectivity', title: 'Connectivity issue', detail: 'x' }]
    expect(statusLine(items, undefined)).toBe('1 thing needs your decision')
  })

  it('plural: "N things need your decision"', () => {
    const items: DeskItem[] = [
      { kind: 'connectivity', title: 'Connectivity issue', detail: 'x' },
      { kind: 'connectivity', title: 'Connectivity issue', detail: 'y' },
    ]
    expect(statusLine(items, undefined)).toBe('2 things need your decision')
  })

  it('running-only: "«name» is mid-build, step X of Y" with X = min(stepIndex+1, plan.length)', () => {
    const running = makeProject({ name: 'portfolio-site', stepIndex: 2, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(statusLine([], running)).toBe('portfolio-site is mid-build, step 3 of 5')
  })

  it('on the genuine last step (stepIndex == plan.length-1) still reads mid-build', () => {
    const running = makeProject({ name: 'portfolio-site', stepIndex: 4, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(statusLine([], running)).toBe('portfolio-site is mid-build, step 5 of 5')
  })

  // P8: past the last step is a TERMINAL state, not a stuck "step 5 of 5" forever.
  it('renders an honest finishing state once every step is consumed (no stuck counter)', () => {
    const running = makeProject({ name: 'portfolio-site', stepIndex: 5, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(statusLine([], running)).toBe('portfolio-site is finishing up · all 5 steps done')
  })

  it('renders an honest starting state for a running project with no plan yet (no "step 0 of 0")', () => {
    const running = makeProject({ name: 'portfolio-site', stepIndex: 0, plan: [] })
    expect(statusLine([], running)).toBe('portfolio-site is getting started')
  })

  it('joins both parts with " · " when items and running are both present', () => {
    const items: DeskItem[] = [{ kind: 'connectivity', title: 'Connectivity issue', detail: 'x' }]
    const running = makeProject({ name: 'portfolio-site', stepIndex: 2, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(statusLine(items, running)).toBe(
      '1 thing needs your decision · portfolio-site is mid-build, step 3 of 5',
    )
  })
})

// ---------------------------------------------------------------------------
// buildPhase / buildProgressMeta (P8): honest terminal/starting states
// ---------------------------------------------------------------------------
describe('buildPhase + buildProgressMeta', () => {
  it('classifies a running project with no plan as "starting"', () => {
    const p = makeProject({ stepIndex: 0, plan: [] })
    expect(buildPhase(p)).toBe('starting')
    expect(buildProgressMeta(p)).toBe('getting started')
  })

  it('classifies an in-range step as "building"', () => {
    const p = makeProject({ stepIndex: 2, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(buildPhase(p)).toBe('building')
    expect(buildProgressMeta(p)).toBe('step 3 of 5')
  })

  it('classifies a consumed plan (stepIndex >= plan.length) as "finishing", never a stuck counter', () => {
    const p = makeProject({ stepIndex: 5, plan: ['a', 'b', 'c', 'd', 'e'] })
    expect(buildPhase(p)).toBe('finishing')
    expect(buildProgressMeta(p)).toBe('all 5 steps done')
  })

  it('singularises a one-step plan', () => {
    expect(buildProgressMeta(makeProject({ stepIndex: 1, plan: ['only'] }))).toBe('all 1 step done')
  })
})

// ---------------------------------------------------------------------------
// passRate
// ---------------------------------------------------------------------------

describe('passRate', () => {
  it('is null when there are no verdicts', () => {
    expect(passRate([])).toBeNull()
  })

  it('short list: fewer than n verdicts uses all of them', () => {
    const verdicts = [makeVerdict({ passed: true }), makeVerdict({ passed: false })]
    expect(passRate(verdicts)).toMatchObject({ runs: 2, passes: 1, decided: 2, passRate: 0.5 })
  })

  it('exact window: 11 verdicts, only the last (newest) 10 count', () => {
    // Newest-first array (index 0 = newest, matching ADD_VERDICT's prepend).
    // The newest 10 (indices 0..9) are 8 passed + 2 failed = 0.8; the 11th
    // (oldest, index 10) is a fail that must NOT be counted.
    const newest10 = Array.from({ length: 10 }, (_, idx) => makeVerdict({ passed: idx < 8 }))
    const oldest = makeVerdict({ passed: false })
    const verdicts = [...newest10, oldest]
    expect(passRate(verdicts)).toMatchObject({ decided: 10, passRate: 0.8 })
  })

  it('respects an explicit n', () => {
    const verdicts = [makeVerdict({ passed: true }), makeVerdict({ passed: false }), makeVerdict({ passed: false })]
    expect(passRate(verdicts, 1)).toMatchObject({ runs: 1, passRate: 1 })
  })

  // The three-outcome rule (verdictOutcome.ts :: OutcomeTally): an ATTENTION
  // run — Tier-1 ran over real written files and PASSED, the Tier-2 reviewer
  // dissented — is neither a pass nor a failure. It leaves the denominator and
  // is counted on its own, so the Desk can print the rate WITH what it is a
  // rate of.
  it('holds ATTENTION runs out of the denominator and counts them separately', () => {
    const verdicts = [
      makeVerdict({ passed: true }),
      makeVerdict({ passed: false, outcome: 'attention' }),
      makeVerdict({ passed: false, outcome: 'failed' }),
    ]
    // 1 pass / 2 DECIDED = 50%. Not 1/3 (which would price the reviewer's
    // dissent as a failure) and not 2/3 (which would price it as a pass).
    expect(passRate(verdicts)).toMatchObject({
      runs: 3,
      passes: 1,
      attention: 1,
      decided: 2,
      passRate: 0.5,
    })
  })

  it('an OLD verdict with no `outcome` counts exactly as before — never guessed into attention', () => {
    const verdicts = [makeVerdict({ passed: true }), makeVerdict({ passed: false })]
    expect(passRate(verdicts)).toMatchObject({ attention: 0, decided: 2, passRate: 0.5 })
  })
})

// ---------------------------------------------------------------------------
// passRateChipClass (P7): colour the pass-rate by its REAL value, never gild it.
// ---------------------------------------------------------------------------
describe('passRateChipClass', () => {
  it('awards gold ONLY at a high rate (>=80%)', () => {
    expect(passRateChipClass(1)).toBe('desk__chip--gold')
    expect(passRateChipClass(0.8)).toBe('desk__chip--gold')
  })

  it('a middling rate reads amber (warn), not gold', () => {
    expect(passRateChipClass(0.79)).toBe('desk__chip--passmid')
    expect(passRateChipClass(0.5)).toBe('desk__chip--passmid')
  })

  it('a poor rate reads red (danger), never gold', () => {
    expect(passRateChipClass(0.49)).toBe('desk__chip--passbad')
    expect(passRateChipClass(0.3)).toBe('desk__chip--passbad')
    expect(passRateChipClass(0)).toBe('desk__chip--passbad')
  })
})

// ---------------------------------------------------------------------------
// recentManagerRuns
// ---------------------------------------------------------------------------

describe('recentManagerRuns', () => {
  it('returns [] when no jobs have runs', () => {
    const m = makeManagersState({ jobs: [makeJob({ runs: [] })] })
    expect(recentManagerRuns(m)).toEqual([])
  })

  it('skips jobs without runs and takes runs[0] (newest) from jobs that have them', () => {
    const m = makeManagersState({
      jobs: [
        makeJob({ id: 'j1', title: 'Job one', runs: [{ at: 300, ok: true, summary: 'newest for j1' }, { at: 100, ok: true, summary: 'older' }] }),
        makeJob({ id: 'j2', title: 'Job two', runs: [] }),
        makeJob({ id: 'j3', title: 'Job three', runs: [{ at: 200, ok: false, summary: 'newest for j3' }] }),
      ],
    })
    const result = recentManagerRuns(m)
    // `stale` added 2026-09-03: these fixtures use epoch-ish timestamps, so
    // every one of them is older than a week and correctly reports as stale.
    expect(result).toEqual([
      { title: 'Job one', summary: 'newest for j1', ok: true, at: 300, stale: true },
      { title: 'Job three', summary: 'newest for j3', ok: false, at: 200, stale: true },
    ])
  })

  it('sorts by at desc and caps at max (default 3)', () => {
    const m = makeManagersState({
      jobs: [
        makeJob({ id: 'j1', title: 'A', runs: [{ at: 100, ok: true, summary: 's-a' }] }),
        makeJob({ id: 'j2', title: 'B', runs: [{ at: 400, ok: true, summary: 's-b' }] }),
        makeJob({ id: 'j3', title: 'C', runs: [{ at: 300, ok: true, summary: 's-c' }] }),
        makeJob({ id: 'j4', title: 'D', runs: [{ at: 200, ok: true, summary: 's-d' }] }),
      ],
    })
    expect(recentManagerRuns(m).map((r) => r.title)).toEqual(['B', 'C', 'D'])
  })

  it('honors a custom max', () => {
    const m = makeManagersState({
      jobs: [
        makeJob({ id: 'j1', title: 'A', runs: [{ at: 100, ok: true, summary: 's' }] }),
        makeJob({ id: 'j2', title: 'B', runs: [{ at: 200, ok: true, summary: 's' }] }),
      ],
    })
    expect(recentManagerRuns(m, 1).map((r) => r.title)).toEqual(['B'])
  })
})

// ---------------------------------------------------------------------------
// recentProjects
// ---------------------------------------------------------------------------

describe('recentProjects', () => {
  it('returns [] for no projects', () => {
    expect(recentProjects([])).toEqual([])
  })

  it('sorts by createdAt desc and caps at max (default 3)', () => {
    const projects = [
      makeProject({ id: 'p1', createdAt: 100 }),
      makeProject({ id: 'p2', createdAt: 400 }),
      makeProject({ id: 'p3', createdAt: 300 }),
      makeProject({ id: 'p4', createdAt: 200 }),
    ]
    expect(recentProjects(projects).map((p) => p.id)).toEqual(['p2', 'p3', 'p4'])
  })

  it('honors a custom max', () => {
    const projects = [makeProject({ id: 'p1', createdAt: 100 }), makeProject({ id: 'p2', createdAt: 200 })]
    expect(recentProjects(projects, 1).map((p) => p.id)).toEqual(['p2'])
  })

  it('does not mutate the input array', () => {
    const projects = [makeProject({ id: 'p1', createdAt: 100 }), makeProject({ id: 'p2', createdAt: 200 })]
    const original = [...projects]
    recentProjects(projects)
    expect(projects).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// nextDueSchedule
// ---------------------------------------------------------------------------

describe('nextDueSchedule', () => {
  it('is null when there are no schedules', () => {
    expect(nextDueSchedule([], 10_000)).toBeNull()
  })

  it('skips disabled schedules', () => {
    const schedules = [makeSchedule({ enabled: false, lastRun: 0 })]
    expect(nextDueSchedule(schedules, 10_000)).toBeNull()
  })

  it('lastRun 0 means due now (dueInMs 0)', () => {
    const schedules = [makeSchedule({ task: 'fresh task', enabled: true, lastRun: 0, everyMinutes: 60 })]
    expect(nextDueSchedule(schedules, 10_000)).toEqual({ task: 'fresh task', dueInMs: 0 })
  })

  it('computes dueInMs from lastRun + everyMinutes * 60_000', () => {
    const now = 1_000_000
    const lastRun = now - 30_000 // ran 30s ago
    const everyMinutes = 1 // due at lastRun + 60_000
    const schedules = [makeSchedule({ task: 'minutely', enabled: true, lastRun, everyMinutes })]
    expect(nextDueSchedule(schedules, now)).toEqual({ task: 'minutely', dueInMs: 30_000 })
  })

  it('soonest-wins across multiple enabled schedules', () => {
    const now = 1_000_000
    const schedules = [
      makeSchedule({ id: 's1', task: 'far away', enabled: true, lastRun: now, everyMinutes: 60 }), // due in 3_600_000
      makeSchedule({ id: 's2', task: 'soonest', enabled: true, lastRun: now - 55_000, everyMinutes: 1 }), // due in 5_000
      makeSchedule({ id: 's3', task: 'disabled but sooner', enabled: false, lastRun: now, everyMinutes: 1 }),
    ]
    expect(nextDueSchedule(schedules, now)).toEqual({ task: 'soonest', dueInMs: 5_000 })
  })
})

// ---------------------------------------------------------------------------
// groupProjectSchedules / freeStandingSchedules (P2-4: Desk "Happening now"
// groups a project's build/test loops under it; free-standing task loops
// with no projectId render unchanged.)
// ---------------------------------------------------------------------------

describe('groupProjectSchedules', () => {
  it('returns [] when there are no schedules', () => {
    expect(groupProjectSchedules([], [makeProject({ id: 'p1' })])).toEqual([])
  })

  it('returns [] when no schedule has a projectId (today\'s free-standing-only world)', () => {
    const schedules = [makeSchedule({ id: 's1' }), makeSchedule({ id: 's2' })]
    expect(groupProjectSchedules(schedules, [makeProject({ id: 'p1' })])).toEqual([])
  })

  it('groups a project\'s build + test loops under it, in project order', () => {
    const projects = [
      makeProject({ id: 'p1', name: 'portfolio-site' }),
      makeProject({ id: 'p2', name: 'internal-tool' }),
    ]
    const build = makeSchedule({ id: 's-build', task: 'build portfolio-site', projectId: 'p1', kind: 'build' })
    const test = makeSchedule({ id: 's-test', task: 'test portfolio-site', projectId: 'p1', kind: 'test' })
    const other = makeSchedule({ id: 's-other', task: 'build internal-tool', projectId: 'p2', kind: 'build' })
    const freeStanding = makeSchedule({ id: 's-free', task: 'free task' })

    const groups = groupProjectSchedules([build, test, other, freeStanding], projects)
    expect(groups).toEqual([
      { projectId: 'p1', projectName: 'portfolio-site', schedules: [build, test] },
      { projectId: 'p2', projectName: 'internal-tool', schedules: [other] },
    ])
  })

  it('omits a project with zero schedules of its own (only projects that own a loop appear)', () => {
    const projects = [makeProject({ id: 'p1', name: 'has-loop' }), makeProject({ id: 'p2', name: 'no-loop' })]
    const build = makeSchedule({ id: 's-build', projectId: 'p1', kind: 'build' })
    expect(groupProjectSchedules([build], projects)).toEqual([
      { projectId: 'p1', projectName: 'has-loop', schedules: [build] },
    ])
  })

  it('ignores a schedule whose projectId matches no known project (orphaned/deleted project)', () => {
    const schedules = [makeSchedule({ id: 's1', projectId: 'ghost-project', kind: 'build' })]
    expect(groupProjectSchedules(schedules, [makeProject({ id: 'p1' })])).toEqual([])
  })
})

describe('freeStandingSchedules', () => {
  it('returns every schedule unchanged when none has a projectId (byte-identical, pre-P2-4 behavior)', () => {
    const schedules = [makeSchedule({ id: 's1' }), makeSchedule({ id: 's2' })]
    expect(freeStandingSchedules(schedules, [makeProject({ id: 'p1' })])).toEqual(schedules)
  })

  it('excludes a schedule bound to a known project', () => {
    const projects = [makeProject({ id: 'p1' })]
    const bound = makeSchedule({ id: 's-bound', projectId: 'p1', kind: 'build' })
    const free = makeSchedule({ id: 's-free' })
    expect(freeStandingSchedules([bound, free], projects)).toEqual([free])
  })

  it('treats a schedule whose projectId matches no known project as free-standing (orphaned/deleted project)', () => {
    const orphan = makeSchedule({ id: 's-orphan', projectId: 'ghost-project', kind: 'build' })
    expect(freeStandingSchedules([orphan], [makeProject({ id: 'p1' })])).toEqual([orphan])
  })
})

// ---------------------------------------------------------------------------
// Agent proposals (2026-08-11 spec) — a PROPOSED agent is not an agent. It
// exists on the desk and nowhere else until the user taps Create.
// ---------------------------------------------------------------------------

function makeProposal(over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    id: 'prop-1',
    name: 'compliance-checker',
    purpose: 'check each diff against our policy list',
    model: 'claude',
    modelWhy: 'the policy text is long and needs careful reading',
    skills: ['policy-diff', 'secret-scan'],
    evidence: { kind: 'runs', refs: ['run-aaa', 'run-bbb'], quote: 'three runs stalled on policy' },
    source: 'heartbeat',
    at: 1000,
    status: 'open',
    ...over,
  }
}

describe('buildDeskItems — agent proposals', () => {
  it('surfaces an OPEN proposal with the whole record attached, after the other decisions', () => {
    const items = buildDeskItems({
      ...emptyInputs,
      projects: [makeProject({ id: 'p-att', name: 'attn', status: 'attention', lastNote: 'stalled' })],
      proposals: [makeProposal()],
    })
    expect(items.map((i) => i.kind)).toEqual(['project-attention', 'agent-proposal'])
    const item = items[1]
    expect(item).toMatchObject({
      kind: 'agent-proposal',
      proposalId: 'prop-1',
      title: 'New agent proposed — compliance-checker',
      detail: 'check each diff against our policy list',
    })
  })

  it('a CREATED or DISMISSED proposal never returns to the desk', () => {
    const items = buildDeskItems({
      ...emptyInputs,
      proposals: [
        makeProposal({ id: 'p-created', status: 'created' }),
        makeProposal({ id: 'p-dismissed', status: 'dismissed' }),
      ],
    })
    expect(items).toEqual([])
  })

  it('no proposals passed at all → byte-identical to before the feature', () => {
    expect(buildDeskItems({ ...emptyInputs, proposals: [] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Business questions (2026-08-15 spec §4) — the companion asking to be told
// something. A question is never a claim, and it never outranks a real decision.
// ---------------------------------------------------------------------------

function makeQuestionSet(over: Partial<QuestionSet> = {}): QuestionSet {
  return {
    id: 'ask-1',
    at: 1000,
    questions: ['Who are your biggest clients?', 'What do you charge?'],
    status: 'open',
    ...over,
  }
}

describe('buildDeskItems — business questions', () => {
  it('surfaces the OPEN set LAST among the decisions, with the questions attached', () => {
    const items = buildDeskItems({
      ...emptyInputs,
      projects: [makeProject({ id: 'p-att', name: 'attn', status: 'attention', lastNote: 'stalled' })],
      proposals: [makeProposal()],
      questionSets: [makeQuestionSet()],
    })
    // A question waits behind every real decision the user owes.
    expect(items.map((i) => i.kind)).toEqual([
      'project-attention',
      'agent-proposal',
      'business-question',
    ])
    expect(items[2]).toMatchObject({
      kind: 'business-question',
      setId: 'ask-1',
      title: 'A few questions about your business',
    })
    expect(items[2]).toHaveProperty('detail', expect.stringContaining('2 questions'))
  })

  it('an ANSWERED or DISMISSED set never returns to the desk', () => {
    expect(
      buildDeskItems({
        ...emptyInputs,
        questionSets: [
          makeQuestionSet({ id: 'a', status: 'answered' }),
          makeQuestionSet({ id: 'd', status: 'dismissed' }),
        ],
      }),
    ).toEqual([])
  })

  it('no question sets passed at all → byte-identical to before the feature', () => {
    expect(buildDeskItems({ ...emptyInputs, questionSets: [] })).toEqual([])
  })
})

// The evidence a proposal row shows must be the RUNS THEMSELVES, read out of
// this app's own verdict log — not the model's prose about them. Real ids glued
// to a model-authored narrative ("three runs needed a compliance check nobody
// owns") read as a citation while proving nothing about what those runs were.
describe('proposal evidence — the runs themselves, resolved from the verdict log', () => {
  const cited = [
    makeVerdict({ taskId: 'run-aaa', task: 'hi', passed: false, at: '2026-08-11T09:31:00.000Z' }),
    makeVerdict({ taskId: 'run-bbb', task: 'check the uploader diff', passed: true, at: '2026-08-11T10:02:00.000Z' }),
  ]

  it('renders one line per ref: the real task text, pass/fail and when it ran', () => {
    const lines = proposalEvidenceRuns(makeProposal(), cited)
    expect(lines).toHaveLength(2)
    expect(lines[0].found).toBe(true)
    expect(lines[0].text).toContain('run-aaa')
    expect(lines[0].text).toContain('failed')
    expect(lines[0].text).toContain('“hi”') // the user typing "hi" is what it really was
    expect(lines[0].text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(lines[1].text).toContain('passed')
    expect(lines[1].text).toContain('“check the uploader diff”')
  })

  it('says so when a cited ref no longer resolves — never dropped in silence', () => {
    const lines = proposalEvidenceRuns(makeProposal(), [cited[0]])
    expect(lines[1]).toMatchObject({ ref: 'run-bbb', found: false })
    expect(lines[1].text).toContain('no longer in your run history')
  })

  it('resolves a ref whatever its casing (the pool spelling is what got stored)', () => {
    const p = makeProposal({ evidence: { kind: 'runs', refs: ['RUN-AAA'], quote: '' } })
    expect(proposalEvidenceRuns(p, cited)[0].found).toBe(true)
  })

  it('the head counts only the refs that RESOLVED', () => {
    expect(proposalEvidenceHead(makeProposal(), 2)).toBe('evidence — 2 runs from your history:')
    expect(proposalEvidenceHead(makeProposal(), 1)).toBe('evidence — 1 run from your history:')
    expect(proposalEvidenceHead(makeProposal(), 0)).toBe(
      'evidence — none of the runs it cited are in your history any more',
    )
  })

  it("the model's note is demoted to a labelled READING, never a citation", () => {
    expect(proposalReadingLine(makeProposal())).toBe(
      'the manager’s reading: three runs stalled on policy',
    )
    // no note recorded → no line at all (nothing invented)
    expect(proposalReadingLine(makeProposal({ evidence: { kind: 'runs', refs: [], quote: '' } }))).toBe('')
  })

  it("quotes the user's own words verbatim when they asked for it, and cites no runs", () => {
    const p = makeProposal({
      source: 'asked',
      evidence: { kind: 'asked', refs: [], quote: 'we need someone for compliance' },
    })
    expect(proposalEvidenceHead(p, 0)).toBe('you asked: “we need someone for compliance”')
    expect(proposalEvidenceRuns(p, cited)).toEqual([])
    expect(proposalReadingLine(p)).toBe('')
  })

  it('names the model AND why, and what it may touch', () => {
    expect(proposalModelLine(makeProposal())).toBe(
      'would run on claude — the policy text is long and needs careful reading',
    )
    expect(proposalTouchLine(makeProposal())).toBe('may touch: policy-diff, secret-scan')
    expect(proposalTouchLine(makeProposal({ skills: [] }))).toBe(
      'may touch: nothing yet — it would carry no skills',
    )
  })
})

// ---------------------------------------------------------------------------
// Sukhdeep's desk showed two automation failures from 29 JULY as though they
// had just happened — under a heading that says "happening now". The local
// model they blamed had been working again for weeks.
//
// `recentManagerRuns` took each job's latest run with no age check: a run is
// "recent" whenever nothing newer exists, which is exactly wrong for a job
// that stopped running. A five-week-old failure presented as current is the
// same class of defect as a tick that wasn't earned.
// ---------------------------------------------------------------------------
describe('recentManagerRuns — a run carries its age', () => {
  const now = Date.UTC(2026, 8, 3)
  const day = 86_400_000
  const job = (title: string, at: number, ok = false) => ({
    id: title,
    title,
    prompt: '',
    schedule: 'daily' as const,
    enabled: true,
    runs: [{ at, ok, summary: 'no real reply (provider offline?)' }],
  })

  it('marks a run older than a week as stale', () => {
    const out = recentManagerRuns(
      { jobs: [job('vault health', now - 36 * day)] } as never,
      3,
      now,
    )
    expect(out[0].stale).toBe(true)
  })

  it('does not mark a run from today as stale', () => {
    const out = recentManagerRuns({ jobs: [job('vault health', now - 3600_000)] } as never, 3, now)
    expect(out[0].stale).toBe(false)
  })

  it('still returns the run — hiding it would lose information', () => {
    // The failure is real and worth seeing. What was wrong was presenting it
    // as current, not showing it at all.
    const out = recentManagerRuns({ jobs: [job('vault health', now - 36 * day)] } as never, 3, now)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('vault health')
  })

  it('keeps newest-first ordering', () => {
    const out = recentManagerRuns(
      { jobs: [job('old', now - 40 * day), job('new', now - day)] } as never,
      3,
      now,
    )
    expect(out.map((r) => r.title)).toEqual(['new', 'old'])
  })
})
