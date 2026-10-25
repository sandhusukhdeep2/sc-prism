import { describe, expect, it } from 'vitest'
import { projectActivity } from './activity'
import type { StoredAgent } from './agents'
import type { NativeVerdictExtra, Verdict } from '../engine/types'
import type { Project, ProjectStatus } from './projects'

// Local fixture builders — mirror agents.test.ts's makeAgent/makeVerdict style
// (self-contained per-file fixtures, no shared test-util import in this repo).

function makeAgent(over: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: 'a-1',
    name: 'Test Agent',
    role: 'does the thing',
    model: 'claude',
    skills: [],
    enabled: true,
    usage: 0,
    evalScore: 0,
    system: false,
    orb: '',
    assignedTo: '',
    ...over,
  }
}

function makeNative(over: Partial<NativeVerdictExtra> = {}): NativeVerdictExtra {
  return {
    hooksFired: [],
    hookDecisions: [],
    blocks: 0,
    approvals: 0,
    memoryInjected: 0,
    disclosed: [],
    rejectedWrites: 0,
    cacheHits: 0,
    cacheMisses: 0,
    spansPath: '',
    ...over,
  }
}

function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 't-1',
    task: 'do the thing',
    route: {
      target: 'local',
      model: 'x',
      via: 'via gateway',
      reason: 'routine',
      routeLabel: 'local · x',
    },
    tier1: { tests: '1/1', lint: true, build: true, pass: true },
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

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    path: '/tmp/test-project',
    goal: 'ship it',
    verifyCommand: '',
    createdAt: 0,
    status: 'new' as ProjectStatus,
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// team resolution — mirrors the build roster (agentsForProject, else the
// enabled system agents)
// ---------------------------------------------------------------------------

describe('projectActivity — team resolution', () => {
  it('uses the project-assigned agents as the team when any are assigned', () => {
    const agents = [
      makeAgent({ id: 'assigned-1', assignedTo: 'proj-1', enabled: true }),
      makeAgent({ id: 'assigned-2', assignedTo: 'proj-1', enabled: true }),
      makeAgent({ id: 'sys-1', assignedTo: 'system', enabled: true }),
    ]
    const project = makeProject({ id: 'proj-1' })
    const { team } = projectActivity(project, agents, [])
    expect(team.map((t) => t.agent.id)).toEqual(['assigned-1', 'assigned-2'])
  })

  it('falls back to the enabled system agents when none are assigned', () => {
    const agents = [
      makeAgent({ id: 'sys-1', assignedTo: 'system', enabled: true }),
      makeAgent({ id: 'sys-2', assignedTo: 'system', enabled: false }), // disabled — excluded
      makeAgent({ id: 'lib-1', assignedTo: '', enabled: true }), // unassigned library agent — excluded
    ]
    const project = makeProject({ id: 'proj-1' })
    const { team } = projectActivity(project, agents, [])
    expect(team.map((t) => t.agent.id)).toEqual(['sys-1'])
  })

  it('pairs each team agent with its real agentActivity (working when the project is running)', () => {
    const agents = [makeAgent({ id: 'assigned-1', assignedTo: 'proj-1', enabled: true, model: 'local' })]
    const project = makeProject({ id: 'proj-1' })
    const { team } = projectActivity(project, agents, [], 'proj-1')
    expect(team[0].activity.state).toBe('working')
    expect(team[0].activity.label).toBe('working…')
  })
})

// ---------------------------------------------------------------------------
// events — real verdict data only, never fabricated
// ---------------------------------------------------------------------------

describe('projectActivity — events', () => {
  it('empty verdicts -> events []', () => {
    const project = makeProject({ id: 'proj-1', verdictIds: [] })
    const { events } = projectActivity(project, [], [])
    expect(events).toEqual([])
  })

  it('one run item per project verdict, with pass/fail label and models_used', () => {
    const verdict = makeVerdict({
      taskId: 't-1',
      passed: true,
      at: '2024-01-01T00:00:00.000Z',
      native: makeNative({ models_used: ['gemini · gemini-2.0-flash'] }),
    })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1'] })
    const { events } = projectActivity(project, [], [verdict])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'run',
      label: 'run passed · gemini · gemini-2.0-flash',
      ok: true,
      when: Date.parse('2024-01-01T00:00:00.000Z'),
    })
  })

  it('a failing run item omits the models_used suffix when there is none', () => {
    const verdict = makeVerdict({ taskId: 't-1', passed: false, at: '2024-01-01T00:00:00.000Z' })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1'] })
    const { events } = projectActivity(project, [], [verdict])
    expect(events[0].label).toBe('run failed')
    expect(events[0].ok).toBe(false)
  })

  // The engine's third outcome in the project feed: "run failed" over a run
  // whose deterministic checks passed is the same false report the badge work
  // fixes, one surface further down.
  it('an ATTENTION run says the checks passed and the reviewer dissented — not "run failed"', () => {
    const verdict = makeVerdict({
      taskId: 't-1',
      passed: false,
      outcome: 'attention',
      at: '2024-01-01T00:00:00.000Z',
    })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1'] })
    const { events } = projectActivity(project, [], [verdict])
    expect(events[0].label).toBe('run needs a look — checks passed, reviewer dissented')
    // Still not a pass...
    expect(events[0].ok).toBe(false)
    // ...but flagged so a renderer can draw it as neither green nor red.
    expect(events[0].attention).toBe(true)
  })

  it('a run with NO recorded outcome keeps its original label and carries no attention flag', () => {
    const verdict = makeVerdict({ taskId: 't-1', passed: false, at: '2024-01-01T00:00:00.000Z' })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1'] })
    const { events } = projectActivity(project, [], [verdict])
    expect(events[0].label).toBe('run failed')
    expect(events[0].attention).toBeUndefined()
  })

  it('a verdict with no `at` (or an unparseable `at`) yields when: 0, never NaN', () => {
    const noAt = makeVerdict({ taskId: 't-1', at: undefined })
    const badAt = makeVerdict({ taskId: 't-2', at: 'not-a-date' })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1', 't-2'] })
    const { events } = projectActivity(project, [], [noAt, badAt])
    for (const e of events) {
      expect(e.when).toBe(0)
      expect(Number.isNaN(e.when)).toBe(false)
    }
  })

  it('one deduped skill item per distinct disclosed skill name, timestamped by the newest verdict that disclosed it', () => {
    const older = makeVerdict({
      taskId: 't-1',
      at: '2024-01-01T00:00:00.000Z',
      native: makeNative({ disclosed: ['task-contract'] }),
    })
    const newer = makeVerdict({
      taskId: 't-2',
      at: '2024-06-01T00:00:00.000Z',
      native: makeNative({ disclosed: ['task-contract', 'decompose'] }),
    })
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1', 't-2'] })
    const { events } = projectActivity(project, [], [older, newer])
    const skillEvents = events.filter((e) => e.kind === 'skill')
    expect(skillEvents).toHaveLength(2)
    const taskContract = skillEvents.find((e) => e.label === 'skill used: task-contract')
    expect(taskContract?.when).toBe(Date.parse('2024-06-01T00:00:00.000Z'))
    const decompose = skillEvents.find((e) => e.label === 'skill used: decompose')
    expect(decompose?.when).toBe(Date.parse('2024-06-01T00:00:00.000Z'))
  })

  it('one created item per team agent that has createdAt, never for agents without one', () => {
    const agents = [
      makeAgent({ id: 'assigned-1', name: 'Fresh Agent', assignedTo: 'proj-1', createdAt: 12345 }),
      makeAgent({ id: 'assigned-2', name: 'Old Agent', assignedTo: 'proj-1', createdAt: undefined }),
    ]
    const project = makeProject({ id: 'proj-1', verdictIds: [] })
    const { events } = projectActivity(project, agents, [])
    expect(events).toEqual([{ kind: 'created', label: 'created agent: Fresh Agent', when: 12345 }])
  })

  it('sorts all events newest-first by `when`', () => {
    const v1 = makeVerdict({ taskId: 't-1', at: '2024-01-01T00:00:00.000Z' })
    const v2 = makeVerdict({ taskId: 't-2', at: '2024-06-01T00:00:00.000Z' })
    const agents = [makeAgent({ id: 'a-1', name: 'Mid Agent', assignedTo: 'proj-1', createdAt: Date.parse('2024-03-01T00:00:00.000Z') })]
    const project = makeProject({ id: 'proj-1', verdictIds: ['t-1', 't-2'] })
    const { events } = projectActivity(project, agents, [v1, v2])
    const whens = events.map((e) => e.when)
    const sorted = [...whens].sort((a, b) => b - a)
    expect(whens).toEqual(sorted)
    // newest run (v2, June) first, then the created agent (March), then the
    // oldest run (v1, January) last.
    expect(events[0]).toMatchObject({ kind: 'run', when: Date.parse('2024-06-01T00:00:00.000Z') })
    expect(events[1]).toMatchObject({ kind: 'created', when: Date.parse('2024-03-01T00:00:00.000Z') })
    expect(events[2]).toMatchObject({ kind: 'run', when: Date.parse('2024-01-01T00:00:00.000Z') })
  })

  it('never fabricates a row for a verdict id that has no matching verdict in the store', () => {
    const project = makeProject({ id: 'proj-1', verdictIds: ['ghost-id'] })
    const { events } = projectActivity(project, [], [])
    expect(events).toEqual([])
  })
})
