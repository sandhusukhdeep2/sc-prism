import { describe, expect, it } from 'vitest'
import {
  WORKLOAD_STOPS,
  applyWorkload,
  effectiveWorkload,
  seatKind,
  suggestWorkload,
  workloadCopy,
  workloadTable,
} from './workload'

// THE WORKLOAD SLIDER (2026-11-12). The owner: "one slider that changes the
// dependency… primary AI just gives the instruction and checks the work, and
// all the workload is on local… fix by your measurement first, but give the
// slider to the user. If the user wants to go all in with local, he can."
//
// A stop is a rule about SEATS — who plans, who does, who checks — applied by
// code to the default team. No model picks anything.
const ai = { primary: 'claude-cli', local: 'local', second: 'gemini' }
const team = 'lead:claude-cli,researcher:local,critic:gemini'
const build = 'planner:claude,implementer:local,reviewer-verifier:claude,test-writer:gemini,retrieval:local'

describe('seatKind — what a seat is for, read from its name', () => {
  it('a seat that leads or plans, plans', () => {
    for (const role of ['lead', 'planner', 'manager', 'architect', 'tech-lead']) {
      expect(seatKind(role), role).toBe('plan')
    }
  })
  it('a seat that reviews or verifies, checks', () => {
    for (const role of ['critic', 'reviewer', 'reviewer-verifier', 'verifier', 'qa', 'judge']) {
      expect(seatKind(role), role).toBe('check')
    }
  })
  it('every other seat does the work', () => {
    for (const role of ['implementer', 'developer', 'researcher', 'retrieval', 'test-writer', 'writer']) {
      expect(seatKind(role), role).toBe('do')
    }
  })
})

describe('applyWorkload — the stop decides which AI takes which seat', () => {
  it('the slider runs from all-primary to all-local', () => {
    expect(WORKLOAD_STOPS).toEqual(['primary-all', 'primary-leads', 'primary-checks', 'local-all'])
  })

  it('"each agent’s own AI" changes nothing', () => {
    expect(applyWorkload(team, 'agents', ai)).toBe(team)
    expect(applyWorkload(build, 'agents', ai)).toBe(build)
  })

  it('all primary: every seat on the primary', () => {
    expect(applyWorkload(team, 'primary-all', ai)).toBe(
      'lead:claude-cli,researcher:claude-cli,critic:claude-cli',
    )
  })

  it('primary leads and checks: it plans and checks, local does the work', () => {
    expect(applyWorkload(build, 'primary-leads', ai)).toBe(
      'planner:claude-cli,implementer:local,reviewer-verifier:claude-cli,test-writer:local,retrieval:local',
    )
  })

  it('primary checks only: local plans and does, the primary checks', () => {
    expect(applyWorkload(build, 'primary-checks', ai)).toBe(
      'planner:local,implementer:local,reviewer-verifier:claude-cli,test-writer:local,retrieval:local',
    )
  })

  it('all local: nothing is seated on a cloud AI', () => {
    expect(applyWorkload(team, 'local-all', ai)).toBe('lead:local,researcher:local,critic:local')
  })

  it('a second opinion goes to the other AI wherever the primary would have checked', () => {
    const opts = { secondOpinion: true }
    expect(applyWorkload(team, 'primary-leads', ai, opts)).toBe('lead:claude-cli,researcher:local,critic:gemini')
    expect(applyWorkload(team, 'primary-all', ai, opts)).toBe('lead:claude-cli,researcher:claude-cli,critic:gemini')
    // All local means all local — a second opinion would leave the Mac.
    expect(applyWorkload(team, 'local-all', ai, opts)).toBe('lead:local,researcher:local,critic:local')
    // No second AI connected: the primary still checks.
    expect(applyWorkload(team, 'primary-leads', { ...ai, second: '' }, opts)).toBe(
      'lead:claude-cli,researcher:local,critic:claude-cli',
    )
  })

  it('an AI that is not there is never seated — the seat keeps the AI it had', () => {
    // No local model: "local does the work" has nobody to give the work to.
    expect(applyWorkload(build, 'primary-leads', { ...ai, local: '' })).toBe(
      'planner:claude-cli,implementer:local,reviewer-verifier:claude-cli,test-writer:gemini,retrieval:local',
    )
    // No primary at all: nothing is moved onto nothing.
    expect(applyWorkload(team, 'primary-all', { ...ai, primary: '' })).toBe(team)
  })

  it('an empty roster stays empty', () => {
    expect(applyWorkload('', 'primary-all', ai)).toBe('')
  })
})

describe('a seat that reads your notes stays on this Mac', () => {
  const crew = 'planner:claude,retrieval:local,vault-keeper:gemini,implementer:local'

  it('is never moved onto a cloud AI by a stop', () => {
    expect(applyWorkload(crew, 'primary-all', ai)).toBe(
      'planner:claude-cli,retrieval:local,vault-keeper:local,implementer:claude-cli',
    )
  })

  it('with no local model it keeps the AI it had — nothing is invented', () => {
    expect(applyWorkload(crew, 'primary-all', { ...ai, local: '' })).toBe(
      'planner:claude-cli,retrieval:local,vault-keeper:gemini,implementer:claude-cli',
    )
  })

  it('the table says why it did not move', () => {
    const row = workloadTable(crew, 'primary-all', ai).find((r) => r.role === 'retrieval')!
    expect(row.now).toBe('local')
    expect(row.private).toBe(true)
  })
})

describe('workloadTable — the seats, as the slider shows them', () => {
  it('lists each seat with what it is for and where it moved', () => {
    expect(workloadTable(team, 'primary-checks', ai)).toEqual([
      { role: 'lead', kind: 'plan', was: 'claude-cli', now: 'local', moved: true, private: false },
      { role: 'researcher', kind: 'do', was: 'local', now: 'local', moved: false, private: false },
      { role: 'critic', kind: 'check', was: 'gemini', now: 'claude-cli', moved: true, private: false },
    ])
  })
})

describe('suggestWorkload — the stop the measurements point to', () => {
  const both = { hasLocal: true, hasCloud: true }

  it('with too few judged local runs there is nothing to suggest', () => {
    const s = suggestWorkload({ ...both, quality: { runs: 4, mean: 0.9 } })
    expect(s.stop).toBeNull()
    expect(s.why).toBe('only 4 judged runs on your local model so far — 10 are needed before the app suggests a stop')
    expect(suggestWorkload({ ...both, quality: null }).stop).toBeNull()
  })

  it('a local model that scores well is trusted to plan as well as do', () => {
    const s = suggestWorkload({ ...both, quality: { runs: 40, mean: 0.82 } })
    expect(s.stop).toBe('primary-checks')
    expect(s.why).toBe('your local model averaged 0.82 over 40 judged runs')
  })

  it('a middling one does the work under a primary that plans and checks', () => {
    expect(suggestWorkload({ ...both, quality: { runs: 12, mean: 0.61 } }).stop).toBe('primary-leads')
  })

  it('a weak one is not given the work', () => {
    expect(suggestWorkload({ ...both, quality: { runs: 30, mean: 0.31 } }).stop).toBe('primary-all')
  })

  it('all-local is never SUGGESTED — only chosen', () => {
    expect(suggestWorkload({ ...both, quality: { runs: 500, mean: 0.99 } }).stop).toBe('primary-checks')
  })

  it('with one kind of AI connected there is no split to suggest', () => {
    expect(suggestWorkload({ hasLocal: false, hasCloud: true, quality: null }).why).toBe(
      'no local model is connected — every seat runs on your primary',
    )
    expect(suggestWorkload({ hasLocal: true, hasCloud: false, quality: null }).why).toBe(
      'no cloud AI is connected — every seat runs on this Mac',
    )
  })
})

describe('effectiveWorkload — what the runs actually use', () => {
  it('a stop the user chose is the stop', () => {
    expect(effectiveWorkload('local-all', 'primary-leads')).toBe('local-all')
    expect(effectiveWorkload('agents', 'primary-leads')).toBe('agents')
  })
  it('"measured" follows the measurement, and without one changes nothing', () => {
    expect(effectiveWorkload('measured', 'primary-leads')).toBe('primary-leads')
    expect(effectiveWorkload('measured', '')).toBe('agents')
  })
})

describe('workloadCopy — each stop in one plain sentence', () => {
  it('names who plans, who does and who checks', () => {
    expect(workloadCopy('primary-leads', 'Claude').desc).toBe(
      'Claude plans and checks; your local model does the work',
    )
    expect(workloadCopy('local-all', 'Claude').desc).toBe(
      'everything runs on this Mac; your own tests are the independent check',
    )
  })
})
