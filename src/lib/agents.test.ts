import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crewModelPlan,
  agentActivity,
  charterFromCompanionFile,
  companionFileBody,
  parseAgentMd,
  agentModelToken,
  agentNamed,
  agentRoster,
  agentRosterSeats,
  rosterSitOuts,
  agentSlug,
  uniqueAgentName,
  agentTaskBrief,
  agentTaskDisplay,
  agentsForProject,
  create,
  list,
  systemAgents,
  update,
  type StoredAgent,
  defaultLibraryRoster,
} from './agents'
import { allowAllProviders } from './roster'
import { MAX_CHARTER, OLD_STARTER_CHARTER, STARTER_CHARTER } from './managers'
import type { NativeVerdictExtra, Verdict } from '../engine/types'

// jsdom provides a real localStorage; the store keeps a module-level
// in-memory `state` that persists across tests in this file (mirrors
// vault.test.ts). Back-compat/load tests isolate themselves via
// vi.resetModules() + a fresh dynamic import (mirrors managers.test.ts).
afterEach(() => {
  localStorage.clear()
})

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

// ---------------------------------------------------------------------------
// assignedTo default / back-compat
// ---------------------------------------------------------------------------

describe('assignedTo back-compat', () => {
  it('an agent object stored without assignedTo still loads and reads as ""', async () => {
    localStorage.setItem(
      'scprism.agents',
      JSON.stringify([
        {
          id: 'biz-legacy',
          name: 'legacy-agent',
          role: 'old business agent',
          model: 'local',
          skills: [],
          enabled: true,
          usage: 5,
          evalScore: 0.5,
          system: false,
          orb: 'gradient',
          // no assignedTo field at all
        },
      ]),
    )
    vi.resetModules()
    const fresh = await import('./agents')
    const agent = fresh.list().find((a) => a.id === 'biz-legacy')
    expect(agent).toBeDefined()
    expect(agent?.assignedTo).toBe('')
  })

  it('rejects the stored array (and reseeds) when an entry is missing a required field', async () => {
    localStorage.setItem(
      'scprism.agents',
      JSON.stringify([{ id: 'broken', name: 'x' /* missing role/model/etc */ }]),
    )
    vi.resetModules()
    const fresh = await import('./agents')
    // Falls back to the SEED, which includes the built-in Planner.
    expect(fresh.list().some((a) => a.id === 'sys-planner')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// create / update carry assignedTo
// ---------------------------------------------------------------------------

describe('create / update carry assignedTo', () => {
  it('create defaults assignedTo to "" when omitted', () => {
    const agent = create({ name: 'no-assignment', role: 'r', model: 'local' })
    expect(agent.assignedTo).toBe('')
  })

  it('create stores an explicit assignedTo (a project id)', () => {
    const agent = create({ name: 'proj-agent', role: 'r', model: 'gemini', assignedTo: 'proj-42' })
    expect(agent.assignedTo).toBe('proj-42')
  })

  it('update changes a business agent\'s assignedTo', () => {
    const agent = create({ name: 'movable', role: 'r', model: 'local' })
    update(agent.id, { assignedTo: 'proj-7' })
    const updated = list().find((a) => a.id === agent.id)
    expect(updated?.assignedTo).toBe('proj-7')
  })

  it("a system agent's assignedTo is not editable via update", () => {
    const before = list().find((a) => a.system)
    expect(before).toBeDefined()
    const beforeAssignedTo = before?.assignedTo
    update(before!.id, { assignedTo: 'proj-should-not-stick', enabled: before!.enabled })
    const after = list().find((a) => a.id === before!.id)
    expect(after?.assignedTo).toBe(beforeAssignedTo)
  })

  it('system agents seed as assignedTo "system"', () => {
    const sysAgent = list().find((a) => a.id === 'sys-planner')
    expect(sysAgent?.assignedTo).toBe('system')
  })

  it('business agents seed as assignedTo ""', () => {
    const bizAgent = list().find((a) => a.id === 'biz-compliance-checker')
    expect(bizAgent?.assignedTo).toBe('')
  })
})

// ---------------------------------------------------------------------------
// agentsForProject / systemAgents
// ---------------------------------------------------------------------------

describe('agentsForProject', () => {
  it('returns only enabled agents assigned to the given project', () => {
    const agents = [
      makeAgent({ id: 'a', assignedTo: 'proj-1', enabled: true }),
      makeAgent({ id: 'b', assignedTo: 'proj-1', enabled: false }), // disabled — excluded
      makeAgent({ id: 'c', assignedTo: 'proj-2', enabled: true }), // different project
      makeAgent({ id: 'd', assignedTo: 'system', enabled: true }), // system — excluded
      makeAgent({ id: 'e', assignedTo: '', enabled: true }), // library — excluded
    ]
    expect(agentsForProject(agents, 'proj-1').map((a) => a.id)).toEqual(['a'])
  })

  it('returns [] when no agents are assigned to the project', () => {
    expect(agentsForProject([makeAgent({ assignedTo: '' })], 'proj-1')).toEqual([])
  })
})

describe('systemAgents', () => {
  it('returns agents assignedTo === "system"', () => {
    const agents = [
      makeAgent({ id: 'a', assignedTo: 'system' }),
      makeAgent({ id: 'b', assignedTo: '' }),
      makeAgent({ id: 'c', assignedTo: 'proj-1' }),
    ]
    expect(systemAgents(agents).map((a) => a.id)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// agentSlug / agentModelToken
// ---------------------------------------------------------------------------

describe('agentSlug', () => {
  it('lowercases and collapses non [a-z0-9] runs to a single dash', () => {
    expect(agentSlug('Compliance Checker!')).toBe('compliance-checker')
  })

  it('trims leading/trailing dashes', () => {
    expect(agentSlug('  --Weird__Name--  ')).toBe('weird-name')
  })

  it('falls back to "agent" for empty/unusable input', () => {
    expect(agentSlug('')).toBe('agent')
    expect(agentSlug('!!!')).toBe('agent')
  })
})

describe('agentModelToken', () => {
  it('maps each AgentModel to the engine provider token defaultProjectRoster uses', () => {
    expect(agentModelToken('claude')).toBe('claude')
    expect(agentModelToken('gemini')).toBe('gemini')
    expect(agentModelToken('local')).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// agentRoster
// ---------------------------------------------------------------------------

describe('agentRoster', () => {
  it('builds <slug>:<token> pairs for enabled agents, comma-joined', () => {
    const agents = [
      makeAgent({ id: 'a', name: 'Compliance Checker', model: 'claude' }),
      makeAgent({ id: 'b', name: 'Test Writer', model: 'local' }),
    ]
    expect(agentRoster(agents, allowAllProviders)).toBe(
      'compliance-checker:claude,test-writer:local',
    )
  })

  it('skips disabled agents', () => {
    const agents = [
      makeAgent({ id: 'a', name: 'Enabled One', model: 'gemini', enabled: true }),
      makeAgent({ id: 'b', name: 'Disabled One', model: 'local', enabled: false }),
    ]
    expect(agentRoster(agents, allowAllProviders)).toBe('enabled-one:gemini')
  })

  it('returns "" for an empty list', () => {
    expect(agentRoster([], allowAllProviders)).toBe('')
  })

  it('drops a DUPLICATE role token — two agents slugging the same is one role, not two', () => {
    const agents = [
      makeAgent({ id: 'a', name: 'Test Writer', model: 'claude' }),
      makeAgent({ id: 'b', name: 'test-writer', model: 'local' }),
    ]
    expect(agentRoster(agents, allowAllProviders)).toBe('test-writer:claude')
  })
})

// ---------------------------------------------------------------------------
// The provider gate (2026-08-12). An agent whose model maps to a provider that
// isn't connected used to keep its seat on every team run and contribute an
// offline stub — a live run recorded 'gemini-cli · opus', is_real false,
// 13 tokens, an hour after that provider was switched off in Settings.
// Agent-enabled and provider-connected are DIFFERENT facts.
// ---------------------------------------------------------------------------

describe('agentRoster — the provider gate', () => {
  const team = () => [
    makeAgent({ id: 'a', name: 'Lead', model: 'claude' }),
    makeAgent({ id: 'b', name: 'Critic', model: 'gemini' }),
    makeAgent({ id: 'c', name: 'Researcher', model: 'local' }),
  ]
  /** Gemini is off; everything else is fine. */
  const geminiOff = (token: string) =>
    token === 'gemini' ? "Gemini CLI (Google login) isn't connected" : ''

  it('excludes an agent whose model maps to a disabled provider', () => {
    expect(agentRoster(team(), geminiOff)).toBe('lead:claude,researcher:local')
  })

  it('SURFACES that exclusion with its reason — the seat is dropped, never hidden', () => {
    const sitOuts = rosterSitOuts(agentRosterSeats(team(), geminiOff))
    expect(sitOuts).toHaveLength(1)
    expect(sitOuts[0].agent.name).toBe('Critic')
    expect(sitOuts[0].sitsOut).toBe("Gemini CLI (Google login) isn't connected")
  })

  it('yields an EMPTY roster when nothing is connected — for the launch to refuse', () => {
    const nothing = () => 'no AI is connected'
    expect(agentRoster(team(), nothing)).toBe('')
    expect(rosterSitOuts(agentRosterSeats(team(), nothing))).toHaveLength(3)
  })

  it('leaves a fully connected team BYTE-IDENTICAL', () => {
    expect(agentRoster(team(), () => '')).toBe(agentRoster(team(), allowAllProviders))
    expect(agentRoster(team(), () => '')).toBe('lead:claude,critic:gemini,researcher:local')
    expect(rosterSitOuts(agentRosterSeats(team(), allowAllProviders))).toEqual([])
  })

  it('an agent the USER switched off is not reported as a provider problem', () => {
    const agents = [...team(), makeAgent({ id: 'd', name: 'Off', enabled: false })]
    const seats = agentRosterSeats(agents, allowAllProviders)
    expect(seats.find((s) => s.agent.id === 'd')?.sitsOut).toBe('switched off')
    expect(rosterSitOuts(seats)).toEqual([])
  })

  it('a seat lost to a duplicate role says THAT, not a provider reason', () => {
    const agents = [
      makeAgent({ id: 'a', name: 'Test Writer', model: 'claude' }),
      makeAgent({ id: 'b', name: 'test-writer', model: 'local' }),
    ]
    const seats = agentRosterSeats(agents, allowAllProviders)
    expect(seats[1].sitsOut).toMatch(/already fills/)
  })
})

// ---------------------------------------------------------------------------
// Name collisions — Create must never mint a second agent under a name the
// library already holds (the seeded 'compliance-checker' is exactly such a name).
// ---------------------------------------------------------------------------

describe('uniqueAgentName / agentNamed', () => {
  const agents = [makeAgent({ id: 'a', name: 'Researcher' }), makeAgent({ id: 'b', name: 'Researcher 2' })]

  it('finds a taken name case-insensitively', () => {
    expect(agentNamed(agents, 'researcher')?.id).toBe('a')
    expect(agentNamed(agents, '  RESEARCHER  ')?.id).toBe('a')
    expect(agentNamed(agents, 'nobody')).toBeUndefined()
  })

  it('leaves a free name alone and suffixes a taken one past every collision', () => {
    expect(uniqueAgentName(agents, 'Auditor')).toBe('Auditor')
    expect(uniqueAgentName(agents, 'Researcher')).toBe('Researcher 3')
    expect(uniqueAgentName([], 'Researcher')).toBe('Researcher')
  })
})

// ---------------------------------------------------------------------------
// agentActivity
// ---------------------------------------------------------------------------

describe('agentActivity', () => {
  it('no verdicts -> idle / "no runs yet" / 0 runs / 0 passRate', () => {
    const agent = makeAgent({ model: 'claude' })
    expect(agentActivity(agent, [])).toEqual({
      state: 'idle',
      label: 'no runs yet',
      runs: 0,
      attention: 0,
      decided: 0,
      passRate: 0,
    })
  })

  it('a passing verdict whose models_used matches the agent model -> ok, real passRate', () => {
    const agent = makeAgent({ model: 'gemini' })
    const verdicts = [
      makeVerdict({ passed: true, native: makeNative({ models_used: ['gemini · gemini-2.0-flash'] }) }),
    ]
    const result = agentActivity(agent, verdicts)
    expect(result.state).toBe('ok')
    expect(result.runs).toBe(1)
    expect(result.passRate).toBe(1)
    // The label names what is really counted — runs on the MODEL, not "this
    // agent's runs" (there is no per-agent runner to make that true).
    // The label names what the rate is OF, because the denominator is no
    // longer just `runs` (attention runs are held out of it).
    expect(result.label).toBe('1 run on gemini · last passed · 100% pass of 1 decided run')
  })

  it('a failing verdict whose models_used matches the agent model -> failed', () => {
    const agent = makeAgent({ model: 'local' })
    const verdicts = [
      makeVerdict({ passed: false, native: makeNative({ models_used: ['local · local-model'] }) }),
    ]
    const result = agentActivity(agent, verdicts)
    expect(result.state).toBe('failed')
    expect(result.label).toBe('1 run on local · last failed · 0% pass of 1 decided run')
  })

  // The team-card recovery: 32 chat turns on one model used to read "3% pass"
  // because every reply was judged (and failed) as a write task. A replied
  // turn is conversation — held out of the pass-rate denominator exactly the
  // way attention is, and named as what it was.
  describe('a replied chat turn on the card', () => {
    it('leaves the pass-rate denominator and is named "last replied"', () => {
      const agent = makeAgent({ model: 'claude' })
      const verdicts = [
        // Newest-first, matching the store's prepend order.
        makeVerdict({
          taskId: 't-chat',
          passed: true,
          outcome: 'replied',
          native: makeNative({ models_used: ['claude-cli · claude-opus'] }),
        }),
        makeVerdict({
          taskId: 't-work',
          passed: true,
          outcome: 'passed',
          native: makeNative({ models_used: ['claude-cli · claude-opus'] }),
        }),
      ]
      const result = agentActivity(agent, verdicts)
      // A good reply is fine — never the amber/red states.
      expect(result.state).toBe('ok')
      expect(result.decided).toBe(1)
      expect(result.passRate).toBe(1)
      expect(result.label).toBe(
        '2 runs on claude · last replied · 100% pass of 1 decided run · 1 reply (chat, not counted)',
      )
    })

    it('a card of only replies claims no task-work rate at all', () => {
      const agent = makeAgent({ model: 'claude' })
      const verdicts = [
        makeVerdict({
          taskId: 't-chat-only',
          passed: true,
          outcome: 'replied',
          native: makeNative({ models_used: ['claude-cli · claude-opus'] }),
        }),
      ]
      const result = agentActivity(agent, verdicts)
      expect(result.decided).toBe(0)
      expect(result.label).toBe('1 run on claude · last replied · no task runs · 1 reply')
    })
  })

  // The bug this pins (audit, 2026-08-11): a JUST-CREATED agent used to inherit
  // every run the app had ever made on that model family. A brand-new agent
  // said "last failed · 18 runs · 0% pass" thirty seconds after the toast
  // promised "no runs yet". An agent can only own runs that happened AFTER it
  // existed.
  describe('an agent never inherits history that predates it', () => {
    const older = makeVerdict({
      taskId: 't-old',
      passed: false,
      at: '2026-08-01T10:00:00.000Z',
      native: makeNative({ models_used: ['claude-cli · claude-opus'] }),
    })
    const newer = makeVerdict({
      taskId: 't-new',
      passed: true,
      at: '2026-08-11T10:00:00.000Z',
      native: makeNative({ models_used: ['claude-cli · claude-opus'] }),
    })

    it('a created agent with only OLDER runs on its model reads "no runs yet"', () => {
      const agent = makeAgent({ model: 'claude', createdAt: Date.parse('2026-08-10T00:00:00.000Z') })
      expect(agentActivity(agent, [older])).toEqual({
        state: 'idle',
        label: 'no runs yet',
        runs: 0,
        attention: 0,
        decided: 0,
        passRate: 0,
      })
    })

    it('a run AFTER creation does count, and is the only one counted', () => {
      const agent = makeAgent({ model: 'claude', createdAt: Date.parse('2026-08-10T00:00:00.000Z') })
      const result = agentActivity(agent, [newer, older])
      expect(result.runs).toBe(1)
      expect(result.label).toBe('1 run on claude · last passed · 100% pass of 1 decided run')
    })

    it('a run with NO timestamp cannot be placed in time, so a created agent does not claim it', () => {
      const agent = makeAgent({ model: 'claude', createdAt: Date.parse('2026-08-10T00:00:00.000Z') })
      const undated = makeVerdict({
        passed: true,
        at: undefined,
        native: makeNative({ models_used: ['claude-cli · x'] }),
      })
      expect(agentActivity(agent, [undated]).runs).toBe(0)
    })

    it('a legacy/system agent with no createdAt is not gated (nothing to compare against)', () => {
      const agent = makeAgent({ model: 'claude', createdAt: undefined })
      expect(agentActivity(agent, [older]).runs).toBe(1)
    })
  })

  it('matches a "claude-cli · ..." label for a claude agent (substring, case-insensitive)', () => {
    const agent = makeAgent({ model: 'claude' })
    const verdicts = [
      makeVerdict({ passed: true, native: makeNative({ models_used: ['Claude-CLI · claude-opus'] }) }),
    ]
    expect(agentActivity(agent, verdicts).runs).toBe(1)
  })

  it('does not attribute a verdict whose models_used is a different provider', () => {
    const agent = makeAgent({ model: 'claude' })
    const verdicts = [
      makeVerdict({ passed: true, native: makeNative({ models_used: ['gemini · gemini-2.0-flash'] }) }),
    ]
    expect(agentActivity(agent, verdicts)).toEqual({
      state: 'idle',
      label: 'no runs yet',
      runs: 0,
      attention: 0,
      decided: 0,
      passRate: 0,
    })
  })

  it('never fabricates activity for a sim verdict (no native field at all)', () => {
    const agent = makeAgent({ model: 'claude' })
    const verdicts = [makeVerdict({ passed: true, native: undefined })]
    expect(agentActivity(agent, verdicts).runs).toBe(0)
  })

  it('computes real passRate across multiple attributable verdicts (newest-first input)', () => {
    const agent = makeAgent({ model: 'local' })
    const verdicts = [
      makeVerdict({ taskId: 't-2', passed: false, native: makeNative({ models_used: ['local · x'] }) }), // newest
      makeVerdict({ taskId: 't-1', passed: true, native: makeNative({ models_used: ['local · x'] }) }), // oldest
    ]
    const result = agentActivity(agent, verdicts)
    expect(result.runs).toBe(2)
    expect(result.passRate).toBe(0.5)
    // newest (index 0) failed -> state reflects the newest, not an average
    expect(result.state).toBe('failed')
  })

  it('state is "working" when the agent\'s project is the currently running project', () => {
    const agent = makeAgent({ model: 'local', assignedTo: 'proj-1' })
    const verdicts = [
      makeVerdict({ passed: true, native: makeNative({ models_used: ['local · x'] }) }),
    ]
    const result = agentActivity(agent, verdicts, 'proj-1')
    expect(result.state).toBe('working')
    expect(result.label).toBe('working…')
    // runs/passRate still reflect real history even while working
    expect(result.runs).toBe(1)
  })

  it('does not report "working" when runningProjectId is falsy/undefined', () => {
    const agent = makeAgent({ model: 'local', assignedTo: '' })
    expect(agentActivity(agent, [], undefined).state).toBe('idle')
    expect(agentActivity(agent, [], '').state).toBe('idle')
  })

  it('does not report "working" for a different project than the one running', () => {
    const agent = makeAgent({ model: 'local', assignedTo: 'proj-1' })
    expect(agentActivity(agent, [], 'proj-2').state).toBe('idle')
  })

  // The three-outcome counting rule (owed follow-up #2 to dc4124e). An
  // ATTENTION run — the deterministic Tier-1 gate ran the project's checks over
  // real written files and PASSED, and only the Tier-2 LLM reviewer dissented —
  // is not a pass. Counting it as a FAILURE, which is what this function did,
  // let an opinion mark down an agent whose measured work was green. The rule:
  // hold it out of the pass-rate denominator and state its count in the label.
  describe('an attention run is neither a pass nor a failure', () => {
    const onLocal = (over: Partial<Verdict>) =>
      makeVerdict({ native: makeNative({ models_used: ['local · x'] }), ...over })

    it('leaves the denominator, is counted on its own, and is named in the label', () => {
      const agent = makeAgent({ model: 'local' })
      const result = agentActivity(agent, [
        onLocal({ taskId: 't-3', passed: false, outcome: 'attention' }), // newest
        onLocal({ taskId: 't-2', passed: false, outcome: 'failed' }),
        onLocal({ taskId: 't-1', passed: true, outcome: 'passed' }),
      ])
      expect(result.runs).toBe(3)
      expect(result.attention).toBe(1)
      expect(result.decided).toBe(2)
      // 1 of 2 DECIDED = 50%. Not 1/3 (the old, dishonest number).
      expect(result.passRate).toBe(0.5)
      expect(result.label).toBe(
        '3 runs on local · last needed a look — checks passed, reviewer dissented · ' +
          '50% pass of 2 decided runs · 1 needed a look (not counted)',
      )
    })

    it('gets its own state — not "failed" — when it is the newest run', () => {
      const agent = makeAgent({ model: 'local' })
      const result = agentActivity(agent, [onLocal({ passed: false, outcome: 'attention' })])
      expect(result.state).toBe('attention')
    })

    it('an all-attention history says it has no decided runs rather than "0% pass"', () => {
      const agent = makeAgent({ model: 'local' })
      const result = agentActivity(agent, [
        onLocal({ taskId: 't-2', passed: false, outcome: 'attention' }),
        onLocal({ taskId: 't-1', passed: false, outcome: 'attention' }),
      ])
      expect(result.decided).toBe(0)
      expect(result.label).toContain('no decided runs · 2 needed a look')
      expect(result.label).not.toMatch(/0% pass/)
    })

    it('a real failure still reads as failed', () => {
      const agent = makeAgent({ model: 'local' })
      const result = agentActivity(agent, [onLocal({ passed: false, outcome: 'failed' })])
      expect(result.state).toBe('failed')
      expect(result.label).toBe('1 run on local · last failed · 0% pass of 1 decided run')
    })

    it('an OLD verdict with no `outcome` is counted exactly as before', () => {
      const agent = makeAgent({ model: 'local' })
      const result = agentActivity(agent, [
        onLocal({ taskId: 't-2', passed: false }),
        onLocal({ taskId: 't-1', passed: true }),
      ])
      expect(result.attention).toBe(0)
      expect(result.decided).toBe(2)
      expect(result.passRate).toBe(0.5)
      expect(result.state).toBe('failed')
    })
  })
})

// Mission Control §Give a task from Work (2026-08-06) — giving ONE agent a task
// from the composer. The app has NO per-agent runner: the library holds
// definitions, not processes. Both strings therefore have to carry the agent's
// REAL identity without implying it ran on its own model.
describe('agentTaskBrief / agentTaskDisplay', () => {
  it('puts the agent’s real role + library model in the brief, marked as a definition', () => {
    const agent = makeAgent({ name: 'compliance-checker', role: 'scans diffs vs policies', model: 'claude' })
    expect(agentTaskBrief(agent, 'check the uploader diff')).toBe(
      '[AGENT · compliance-checker · scans diffs vs policies · library model: claude — a definition,' +
        ' not a routing instruction; this run goes through the normal gateway]\ncheck the uploader diff',
    )
  })

  it('omits a missing role rather than inventing one', () => {
    const agent = makeAgent({ name: 'nameless', role: '   ', model: 'local' })
    expect(agentTaskBrief(agent, 'do it')).toBe(
      '[AGENT · nameless · library model: local — a definition, not a routing instruction;' +
        ' this run goes through the normal gateway]\ndo it',
    )
  })

  it('labels the task with WHO was asked and WHERE it actually goes', () => {
    const agent = makeAgent({ name: 'test-writer' })
    expect(agentTaskDisplay(agent, 'add goldens for the parser')).toBe(
      '→ test-writer (briefed on your primary AI): add goldens for the parser',
    )
    // No model claim anywhere in the label — that is the gateway's to report.
    expect(agentTaskDisplay(agent, 'x')).not.toMatch(/claude|gemini|local/)
  })
})

// THE LAUNCHER THAT ARGUED WITH ITS OWN DEFAULT (2026-08-28): "Launch a team"
// seeded its roster with the provider-generic preset (lead:claude-cli,
// researcher:local) and handed it to a picker whose vocabulary is the LIBRARY
// — so the app's own default tripped the "no agent named 'lead'" typo warning,
// and 'researcher:local' half-matched the library's Researcher, pre-checking a
// seat whose own binding (gemini) sat out. The launcher now seeds from the
// library's PLAYABLE seats — the same crew its picker shows.
describe('defaultLibraryRoster — the launcher may only preset a crew that can play', () => {
  const lib = (over: Partial<StoredAgent>[], gateBlocked: string[] = []) => {
    const agents = over.map(
      (o, i) =>
        ({
          id: `a${i}`,
          name: `Agent ${i}`,
          role: 'does things',
          model: 'local',
          skills: [],
          enabled: true,
          usage: 0,
          evalScore: 0,
          orb: '',
          ...o,
        }) as StoredAgent,
    )
    const gate = (token: string) => (gateBlocked.includes(token) ? `${token} is switched off in Settings` : '')
    return { agents, gate }
  }

  it('presets the playable seats, capped at three, in library order', () => {
    const { agents, gate } = lib([
      { name: 'Planner', model: 'claude' },
      { name: 'Implementer', model: 'local' },
      { name: 'Researcher', model: 'gemini' },
      { name: 'Retrieval', model: 'local' },
    ], ['gemini'])
    // Researcher sits out (gemini blocked) — the preset skips it, no
    // checked-but-sitting-out seat, no unknown-name warning possible.
    expect(defaultLibraryRoster(agents, gate)).toBe('planner:claude,implementer:local,retrieval:local')
  })

  it('an empty library (or nobody playable) presets an honest empty roster', () => {
    const none = lib([], [])
    expect(defaultLibraryRoster(none.agents, none.gate)).toBe('')
    const blocked = lib([{ name: 'Solo', model: 'gemini' }], ['gemini'])
    expect(defaultLibraryRoster(blocked.agents, blocked.gate)).toBe('')
  })
})

// Slice D, cycle 1 (2026-08-29): the Companion becomes a portable agent file.
// Pure codec here — no I/O: the file body the migration writes, and the
// charter an edited file yields back. The fingerprint rule rides along:
// a never-edited default charter serializes as the CURRENT default (stays
// upgradeable); user text moves verbatim. An emptied file body is the
// reset-to-default, not an empty charter (a wake cannot run charterless).
describe('companion as an agent file', () => {
  it('serializes the companion with slug-stable name and the charter as body', () => {
    const md = companionFileBody('Watch the vault. Rest honestly.', { model: 'claude' })
    expect(md).toContain('name: companion')
    expect(md).toContain('model: claude')
    expect(md.endsWith('Watch the vault. Rest honestly.\n')).toBe(true)
  })

  it('a never-edited old default serializes as the CURRENT default ladder', () => {
    const md = companionFileBody(OLD_STARTER_CHARTER, { model: 'local' })
    expect(md).toContain(STARTER_CHARTER.slice(0, 40))
    expect(md).not.toContain('prepare ONE small useful piece of work')
  })

  it('round-trips a user charter verbatim and caps an oversize edit', () => {
    const md = companionFileBody('My own words.', { model: 'claude' })
    expect(charterFromCompanionFile(parseAgentMd('agents/companion.md', md))).toBe('My own words.')
    const big = 'x'.repeat(MAX_CHARTER + 500)
    const edited = parseAgentMd('agents/companion.md', companionFileBody(big, { model: 'claude' }))
    expect(charterFromCompanionFile(edited).length).toBe(MAX_CHARTER)
  })

  it('an emptied body resets to the default ladder, never a blank charter', () => {
    const parsed = parseAgentMd('agents/companion.md', '---\nname: companion\nmodel: claude\n---\n')
    expect(charterFromCompanionFile(parsed)).toBe(STARTER_CHARTER)
  })
})

// Crew-wide model presets (Sukhdeep, 2026-08-31: "what if the user wants to
// run all the agents on local only? or a bit on Gemini and local? or totally
// on cloud?"). One call moves the whole crew; per-agent choice still wins
// afterwards, and a preset never invents a provider the user hasn't got.
describe('crewModelPlan — one move for the whole crew', () => {
  const crew = [
    { id: 'a', name: 'Planner', model: 'claude' as const },
    { id: 'b', name: 'Researcher', model: 'gemini' as const },
    { id: 'c', name: 'Retrieval', model: 'local' as const },
  ]

  it('all-local puts every seat on the local model', () => {
    const plan = crewModelPlan(crew, 'local', ['local', 'gemini', 'claude'])
    expect(plan.every((p) => p.model === 'local')).toBe(true)
    expect(plan).toHaveLength(3)
  })

  it('all-cloud moves every seat to a connected cloud brand, never local', () => {
    const plan = crewModelPlan(crew, 'cloud', ['local', 'gemini'])
    expect(plan.every((p) => p.model === 'gemini')).toBe(true)
  })

  it('balanced keeps private seats local and research on the cloud', () => {
    const plan = crewModelPlan(crew, 'balanced', ['local', 'gemini', 'claude'])
    const by = Object.fromEntries(plan.map((p) => [p.id, p.model]))
    expect(by['c']).toBe('local') // Retrieval reads the vault → stays local
    expect(by['b']).not.toBe('local') // Researcher needs fresh web knowledge
  })

  it('refuses to move a seat to a brand the user has not connected', () => {
    const plan = crewModelPlan(crew, 'cloud', ['local'])
    expect(plan).toEqual([]) // no cloud connected → nothing is promised
  })
})

// Found 2026-08-31 while wiring the crew-lean presets: EVERY seat in the
// default crew is a `system` agent, and `update` ignored every field but
// `enabled` on those — so "run all my agents locally" was a no-op on exactly
// the agents that matter. Which BRAIN runs a seat is the user's choice, not
// part of the seat's identity; charter/name/tools stay read-only.
describe('system seats accept a model change', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('changes the model of a system seat but not its charter or name', () => {
    const seat = list().find((a) => a.system)
    if (!seat) throw new Error('no system seat in the seed')
    const before = { name: seat.name, charter: seat.charter }
    update(seat.id, { model: 'local', name: 'HACKED', charter: 'HACKED' })
    const after = list().find((a) => a.id === seat.id)!
    expect(after.model).toBe('local')
    expect(after.name).toBe(before.name)
    expect(after.charter).toBe(before.charter)
  })
})

// ---------------------------------------------------------------------------
// Sukhdeep, 2026-09-03: "I can see the option all local / balanced / all
// Claude, but I have more than two AIs."
//
// `crewModelPlan` picked its cloud with `.find()` over a fixed order, so with
// both Claude and Gemini connected, Gemini could NEVER be chosen — the button
// said "All cloud" and silently meant "all Claude". The cloud must be named by
// the caller, so the UI can offer one button per AI the user actually has.
// ---------------------------------------------------------------------------
describe('crewModelPlan names its cloud explicitly', () => {
  const crew = [
    { id: 'a', name: 'Planner', model: 'local' as const },
    { id: 'b', name: 'Retrieval', model: 'local' as const },
  ]
  const both = ['local', 'claude', 'gemini']

  it('moves the crew to the cloud the caller asked for — including Gemini', () => {
    expect(crewModelPlan(crew, 'cloud', both, 'gemini').every((r) => r.model === 'gemini')).toBe(true)
    expect(crewModelPlan(crew, 'cloud', both, 'claude').every((r) => r.model === 'claude')).toBe(true)
  })

  it('uses the named cloud for the balanced lean too, keeping private seats local', () => {
    const plan = crewModelPlan(crew, 'balanced', both, 'gemini')
    expect(plan.find((r) => r.id === 'a')?.model).toBe('gemini')
    // 'Retrieval' reads the user's own notes, so it stays on the machine.
    expect(plan.find((r) => r.id === 'b')?.model).toBe('local')
  })

  it('refuses a cloud the user has not connected rather than substituting one', () => {
    // Silently swapping in a different AI is how "All cloud" came to mean
    // "all Claude" in the first place.
    expect(crewModelPlan(crew, 'cloud', ['local', 'claude'], 'gemini')).toEqual([])
  })

  it('still works without a named cloud, for the single-cloud case', () => {
    expect(crewModelPlan(crew, 'cloud', ['local', 'claude']).every((r) => r.model === 'claude')).toBe(true)
  })

  it('local needs no cloud at all', () => {
    expect(crewModelPlan(crew, 'local', ['local']).every((r) => r.model === 'local')).toBe(true)
  })
})
