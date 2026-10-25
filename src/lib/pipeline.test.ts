// The seven honesty rules of the v2 Work board (spec 2026-08-18), at the level
// they are DERIVED. The rendered counterparts live in CrewBoard.test.tsx,
// RunLedger.test.tsx and Workspace.pipeline.test.tsx.
import { describe, expect, it } from 'vitest'
import {
  agentTint,
  arcFraction,
  crewCountLabel,
  crewCounts,
  memberIsLive,
  monogram,
  pendingDecisions,
  pipelineStages,
  runDuration,
  stageLabel,
  vaultBadge,
  vaultReads,
  weekArcs,
  weekEmptyLine,
  todaySpend,
} from './pipeline'
import { IDLE_HUE, modelColor } from './modelColor'
import { agentOrbs } from './orbs'
import type { EngineSpan } from './nativeEngine'
import type { FinishedRun, LiveRun } from './liveRuns'
import type { Verdict } from '../engine/types'

const call = (attrs: Record<string, unknown>, extra: Partial<EngineSpan> = {}): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'ok',
  start: 100,
  attrs,
  ...extra,
})

const tool = (attrs: Record<string, unknown>, extra: Partial<EngineSpan> = {}): EngineSpan => ({
  name: 'tool_exec',
  type: 'tool_exec',
  status: 'ok',
  start: 100,
  attrs,
  ...extra,
})

// ── Rule 3 — stages/steps map 1:1 to real spans; no crew, no pipeline ───────
describe('rule 3 — the pipeline is the engine’s own rounds, or it is nothing', () => {
  it('no spans at all → no stages (there is no crew, so there is no pipeline)', () => {
    expect(pipelineStages([], true)).toEqual([])
  })

  it('a solo run (model_call with NO agent attr) is not dressed up as a pipeline', () => {
    expect(pipelineStages([call({ provider: 'local', model: 'q', is_real: true })], true)).toEqual([])
  })

  it('one column per DISTINCT round the engine reported, in the order they happened', () => {
    const stages = pipelineStages(
      [
        call({ agent: 'Scout', provider: 'local', model: 'q', round: '1' }, { start: 10 }),
        call({ agent: 'Scribe', provider: 'claude', model: 'opus', round: '1' }, { start: 11 }),
        call({ agent: 'Scribe', provider: 'claude', model: 'opus', round: 'synthesis' }, { start: 20 }),
      ],
      true,
    )
    expect(stages.map((s) => s.key)).toEqual(['1', 'synthesis'])
    expect(stages.map((s) => s.label)).toEqual(['Round 1', 'Pulling together'])
    expect(stages[0].members.map((m) => m.step.agent)).toEqual(['Scout', 'Scribe'])
    expect(stages[1].members).toHaveLength(1)
  })

  it('a span with NO round attr is one honest "Working" column, not a guessed phase', () => {
    const stages = pipelineStages([call({ agent: 'Scout', provider: 'local', model: 'q' })], true)
    expect(stages).toHaveLength(1)
    expect(stages[0].key).toBe('')
    expect(stages[0].label).toBe('Working')
  })

  it('an engine-refused tool call gets its own column, named for what it was', () => {
    const stages = pipelineStages(
      [tool({ agent: 'Scout', refused: true, tool: 'web_search', reason: 'web is off' })],
      false,
    )
    expect(stages.map((s) => s.label)).toEqual(['Refused by the engine'])
    expect(stages[0].members[0].step.state).toBe('refused')
  })

  it('every member IS a real step — one member per span, never more', () => {
    const spans = [
      call({ agent: 'A', provider: 'local', model: 'q', round: '1' }, { start: 1 }),
      call({ agent: 'B', provider: 'local', model: 'q', round: '1' }, { start: 2 }),
    ]
    const members = pipelineStages(spans, true).flatMap((s) => s.members)
    expect(members).toHaveLength(2)
  })

  it('stageLabel names only what the attr said', () => {
    expect(stageLabel('')).toBe('Working')
    expect(stageLabel('2')).toBe('Round 2')
    expect(stageLabel('synthesis')).toBe('Pulling together')
    expect(stageLabel('refused')).toBe('Refused by the engine')
  })
})

// ── Rule 1 — a monogram pulses ONLY while its run is genuinely live ─────────
describe('rule 1 — liveness comes from the run, never from the span alone', () => {
  it('an OPEN span under a live run may pulse', () => {
    const [stage] = pipelineStages([call({ agent: 'Scout', provider: 'local', model: 'q' })], true)
    expect(stage.members[0].live).toBe(true)
  })

  it('the SAME open span pulses nothing once the run is not live (a paused run)', () => {
    const [stage] = pipelineStages([call({ agent: 'Scout', provider: 'local', model: 'q' })], false)
    expect(stage.members[0].live).toBe(false)
  })

  it('a CLOSED span never pulses, live or not', () => {
    const done = call({ agent: 'Scout', provider: 'local', model: 'q', is_real: true })
    for (const live of [true, false]) {
      const [stage] = pipelineStages([done], live)
      expect(stage.members[0].live).toBe(false)
    }
  })

  it('memberIsLive needs BOTH the live flag and an open span', () => {
    const open = { state: 'working' } as never
    const closed = { state: 'done' } as never
    expect(memberIsLive(open, true)).toBe(true)
    expect(memberIsLive(open, false)).toBe(false)
    expect(memberIsLive(closed, true)).toBe(false)
  })
})

// ── Rule 2 — name + model from REAL attrs; missing → honest generic ─────────
describe('rule 2 — nothing about who or which AI is guessed', () => {
  it('the name and the provider · model come straight off the span', () => {
    const [stage] = pipelineStages([call({ agent: 'Scout', provider: 'local', model: 'qwen3' })], true)
    expect(stage.members[0].step.agent).toBe('Scout')
    expect(stage.members[0].step.ai).toBe('local · qwen3')
  })

  it('a span with NO provider/model reads the honest generic and goes GREY', () => {
    const [stage] = pipelineStages([call({ agent: 'Scout' })], true)
    expect(stage.members[0].step.ai).toBe('an AI')
    expect(stage.members[0].color).toBe(IDLE_HUE)
  })

  it('a known provider is tinted by ITS model, matching the app-wide hue', () => {
    const [stage] = pipelineStages([call({ agent: 'W', provider: 'claude-cli', model: 'opus' })], true)
    expect(stage.members[0].color).toBe(modelColor('claude'))
  })

  it('agentTint greys an unnamed provider instead of hashing one out of nothing', () => {
    expect(agentTint('')).toBe(IDLE_HUE)
    expect(agentTint('   ')).toBe(IDLE_HUE)
    expect(agentTint('local', 'qwen')).toBe(modelColor('local'))
  })

  it('a monogram is a letter, never a face — and never blank', () => {
    expect(monogram('Scout')).toBe('S')
    expect(monogram('researcher')).toBe('R')
    expect(monogram('')).toBe('·')
  })
})

// ── Rule 5 — counts are real states, never a plan ───────────────────────────
describe('rule 5 — "N working" is a count of real span states', () => {
  const orbs = (spans: EngineSpan[]) => agentOrbs(spans)

  it('counts what the spans actually say', () => {
    const c = crewCounts(
      orbs([
        call({ agent: 'A', provider: 'local', model: 'q' }, { status: 'running' }),
        call({ agent: 'B', provider: 'local', model: 'q' }, { status: 'ok' }),
        call({ agent: 'C', provider: 'local', model: 'q' }, { status: 'error' }),
      ]),
      true,
    )
    expect(c).toEqual({ total: 3, working: 1, passed: 1, failed: 1, unfinished: 0 })
    expect(crewCountLabel(c)).toBe('1 working · 1 answered · 1 failed')
  })

  it('with NOTHING live an open span is "unfinished", never "working"', () => {
    const c = crewCounts(orbs([call({ agent: 'A', provider: 'local', model: 'q' }, { status: 'running' })]), false)
    expect(c.working).toBe(0)
    expect(c.unfinished).toBe(1)
    expect(crewCountLabel(c)).toBe('1 unfinished')
  })

  it('no crew says nothing at all — never "0 working"', () => {
    expect(crewCountLabel(crewCounts([], true))).toBe('')
    expect(crewCountLabel(crewCounts([], false))).toBe('')
  })
})

// ── Rule 4 — the 🔒 badge only when a vault read really happened ────────────
describe('rule 4 — the lock badge is earned by a real vault read', () => {
  it('counts a real read/search/list', () => {
    expect(
      vaultReads([
        tool({ provider: 'vault', tool: 'vault_read', path: 'notes/a.md' }),
        tool({ provider: 'vault', tool: 'vault_search' }),
        tool({ provider: 'vault', tool: 'vault_list' }),
      ]),
    ).toBe(3)
  })

  it('a run that touched no vault earns no badge', () => {
    expect(vaultReads([call({ agent: 'A', provider: 'local', model: 'q' })])).toBe(0)
    expect(vaultBadge([call({ agent: 'A', provider: 'local', model: 'q' })])).toBe('')
  })

  it('a BLOCKED, HELD-but-unanswered, ERRORED or non-read vault call is not a read', () => {
    expect(vaultReads([tool({ provider: 'vault', tool: 'vault_read', blocked: true })])).toBe(0)
    expect(vaultReads([tool({ provider: 'vault', tool: 'vault_read', held: true })])).toBe(0)
    expect(
      vaultReads([tool({ provider: 'vault', tool: 'vault_read' }, { status: 'error' })]),
    ).toBe(0)
    expect(vaultReads([tool({ provider: 'vault', tool: 'vault_write' })])).toBe(0)
    // a web call is not a vault read, however many there are
    expect(vaultReads([tool({ provider: 'web', tool: 'web_search' })])).toBe(0)
  })

  it('a held call that the user ANSWERED and that then ran does count', () => {
    expect(vaultReads([tool({ provider: 'vault', tool: 'vault_read', held: true, resolved: 'allow' })])).toBe(1)
  })

  it('the badge names the measured number, singular and plural', () => {
    expect(vaultBadge([tool({ provider: 'vault', tool: 'vault_read' })])).toBe(
      'read 1 vault note — stayed on this Mac',
    )
    expect(
      vaultBadge([
        tool({ provider: 'vault', tool: 'vault_read' }),
        tool({ provider: 'vault', tool: 'vault_read' }),
      ]),
    ).toBe('read 2 vault notes — stayed on this Mac')
  })
})

// ── "Your call" — only real parked decisions ────────────────────────────────
describe('the "Your call" column exists only when something really waits on you', () => {
  const run = (over: Partial<LiveRun> = {}): LiveRun => ({
    id: 'r1',
    kind: 'project',
    intent: 'build the dashboard',
    startedAt: 1,
    models: [],
    ...over,
  })

  it('nothing parked → no decisions', () => {
    expect(pendingDecisions([call({ agent: 'A', provider: 'local', model: 'q' })], [run()])).toEqual([])
  })

  it('a held tool call with no answer yet is a real decision', () => {
    const d = pendingDecisions([tool({ held: true, tool: 'file_write', agent: 'writer' })], [])
    expect(d).toHaveLength(1)
    expect(d[0].label).toBe('Needs your OK')
    expect(d[0].detail).toBe('writer wants to use file_write')
  })

  it('an ALREADY-ANSWERED hold is not still waiting on you', () => {
    expect(pendingDecisions([tool({ held: true, tool: 'file_write', resolved: 'allow' })], [])).toEqual([])
  })

  it('a paused run is a real decision; a running one is not', () => {
    expect(pendingDecisions([], [run({ paused: true })])).toHaveLength(1)
    expect(pendingDecisions([], [run({ paused: false })])).toEqual([])
  })
})

// ── Rule 7 — every number in recent runs / the arcs is measured ─────────────
describe('rule 7 — the ledger and the arcs count only measured things', () => {
  const NOW = Date.parse('2026-08-18T12:00:00Z')
  const v = (over: Partial<Verdict>): Verdict => ({ passed: true, ...over }) as Verdict

  it('a finished run’s duration is its own two clocks, nothing else', () => {
    const run: FinishedRun = {
      id: 'x',
      kind: 'chat',
      intent: 'ask',
      startedAt: 1_000,
      endedAt: 65_000,
      outcome: 'passed',
      detail: '',
    }
    expect(runDuration(run)).toBe('1:04')
  })

  it('counts the verdicts inside the window, by the outcome the ENGINE recorded', () => {
    const a = weekArcs(
      [
        v({ at: '2026-08-17T12:00:00Z', passed: true, outcome: 'passed' }),
        v({ at: '2026-08-16T12:00:00Z', passed: false, outcome: 'attention' }),
        v({ at: '2026-08-15T12:00:00Z', passed: false, outcome: 'failed' }),
      ],
      NOW,
    )
    expect(a).toEqual({ dated: 3, passed: 1, attention: 1, failed: 1, replied: 0, undated: 0 })
    expect(weekEmptyLine(a)).toBe('')
  })

  it('drops what is OUTSIDE the week rather than padding the arc with it', () => {
    const a = weekArcs([v({ at: '2026-08-01T12:00:00Z', passed: true, outcome: 'passed' })], NOW)
    expect(a.dated).toBe(0)
    expect(a.undated).toBe(0)
  })

  it('a verdict with NO timestamp cannot be placed in a week — reported, never counted', () => {
    const a = weekArcs([v({ passed: true, outcome: 'passed' }), v({ at: 'not-a-date' })], NOW)
    expect(a).toEqual({ dated: 0, passed: 0, attention: 0, failed: 0, replied: 0, undated: 2 })
    expect(weekEmptyLine(a)).toMatch(/2 earlier runs carry no timestamp/)
    expect(
      weekEmptyLine({ dated: 0, passed: 0, attention: 0, failed: 0, replied: 0, undated: 1 }),
    ).toMatch(/1 earlier run carries no timestamp/)
  })

  it('an EMPTY week says so instead of drawing an empty arc', () => {
    const a = weekArcs([], NOW)
    expect(a.dated).toBe(0)
    expect(weekEmptyLine(a)).toBe('no runs recorded this week yet')
    // and there is no sweep to draw
    expect(arcFraction(a.passed, a.dated)).toBe(0)
  })

  it('an arc sweep is a real ratio, clamped, and 0 when nothing was measured', () => {
    expect(arcFraction(3, 4)).toBe(0.75)
    expect(arcFraction(5, 4)).toBe(1)
    expect(arcFraction(1, 0)).toBe(0)
  })
})

// ONE CARD PER AGENT. A real run of Sukhdeep's had the researcher take seven
// model turns in a single round (a vault read between each), and every turn was
// drawn as its own card — seven identical "researcher · local · Qwen…" cards
// stacked in one column, reading as seven researchers and burying the lead.
describe('an agent’s turns are ONE card, counted — not N cards', () => {
  const turn = (agent: string, provider: string, at: number, round = '1'): EngineSpan =>
    ({
      name: 'model_call',
      type: 'model_call',
      status: 'ok',
      start: at,
      attrs: { agent, provider, model: 'm', round, is_real: true, tokens_out: 10 },
    }) as EngineSpan

  it('folds repeated turns into one member and counts them', () => {
    const stages = pipelineStages(
      [
        turn('lead', 'claude-cli', 1),
        turn('researcher', 'local', 2),
        turn('researcher', 'local', 3),
        turn('researcher', 'local', 4),
      ],
      false,
    )
    expect(stages).toHaveLength(1)
    const names = stages[0].members.map((m) => m.step.agent)
    expect(names).toEqual(['lead', 'researcher'])
    expect(stages[0].members.find((m) => m.step.agent === 'researcher')!.turns).toBe(3)
    expect(stages[0].members.find((m) => m.step.agent === 'lead')!.turns).toBe(1)
  })

  it('the card carries the LATEST turn, so it shows what the agent is doing now', () => {
    const stages = pipelineStages([turn('r', 'local', 2), turn('r', 'local', 9)], false)
    expect(stages[0].members[0].step.at).toBe(9)
  })

  it('the same agent in a DIFFERENT stage is a different card', () => {
    const stages = pipelineStages([turn('lead', 'claude-cli', 1, '1'), turn('lead', 'local', 5, 'synthesis')], false)
    expect(stages).toHaveLength(2)
    expect(stages.every((s) => s.members.length === 1)).toBe(true)
  })

  it('a single-turn agent is not labelled with a count', () => {
    const stages = pipelineStages([turn('solo', 'local', 1)], false)
    expect(stages[0].members[0].turns).toBe(1)
  })
})

// The footer's "spent on cloud today" must come from the SAME verdicts the
// panels read — the 2026-08-28 screenshot showed an empty week above "$0.45
// spent on cloud today", read from an accumulator nothing ever reset.
describe('todaySpend — spend claims derive from dated verdicts only', () => {
  const NOW = Date.parse('2026-08-18T12:00:00Z')
  it("sums only the local day's verdicts", () => {
    const vs = [
      { at: '2026-08-18T10:00:00Z', cost: 0.3 },
      { at: '2026-08-17T10:00:00Z', cost: 0.5 }, // yesterday — not today's spend
      { at: undefined, cost: 0.7 }, // undated — cannot claim a day
    ] as unknown as Parameters<typeof todaySpend>[0]
    expect(todaySpend(vs, NOW)).toBe(0.3)
  })
  it('an empty day is exactly zero', () => {
    expect(todaySpend([], NOW)).toBe(0)
  })
})
