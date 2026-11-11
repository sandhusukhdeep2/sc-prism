import { describe, expect, it } from 'vitest'
import { filesSummary, loopsSummary, planSummary, teamSummary, verdictsSummary } from './drawerSummary'

// THE SIDEBAR'S ONE-LINERS (2026-11-11 — "the sidebar is totally cluttered").
// Every block of the project sidebar folds to one line; the line says what is
// inside in counts and states read from the stores, so a folded section never
// hides a problem (a seat that sits out shows in the summary itself).
describe('teamSummary', () => {
  it('names whose team it is and how many seats will really run', () => {
    expect(teamSummary({ assigned: 0, override: '', seats: 5, sitOut: 0, refused: false })).toEqual({ text: 'default team · 5 seats', warn: false })
    expect(teamSummary({ assigned: 2, override: '', seats: 2, sitOut: 0, refused: false }).text).toBe('this project’s agents · 2 seats')
    expect(teamSummary({ assigned: 0, override: 'lead:local', seats: 1, sitOut: 0, refused: false }).text).toBe('manual override · 1 seat')
  })
  it('a seat that sits out, or a team nobody can staff, shows in the folded line and warns', () => {
    expect(teamSummary({ assigned: 0, override: '', seats: 4, sitOut: 1, refused: false })).toEqual({ text: 'default team · 4 seats · 1 sits out', warn: true })
    expect(teamSummary({ assigned: 0, override: 'ghost:local', seats: 0, sitOut: 0, refused: true })).toEqual({ text: 'nobody could be staffed', warn: true })
  })
  it('no team at all is a single model, said plainly', () => {
    expect(teamSummary({ assigned: 0, override: '', seats: 0, sitOut: 0, refused: false }).text).toBe('single model')
  })
})

describe('loopsSummary / filesSummary / verdictsSummary', () => {
  it('counts loops and how many are on', () => {
    expect(loopsSummary([])).toBe('none')
    expect(loopsSummary([{ enabled: false }])).toBe('1 loop · off')
    expect(loopsSummary([{ enabled: true }, { enabled: false }])).toBe('2 loops · 1 on')
  })
  it('counts files and verdicts', () => {
    expect(filesSummary(1)).toBe('1 file')
    expect(filesSummary(12)).toBe('12 files')
    expect(verdictsSummary(1)).toBe('1 recorded')
    expect(verdictsSummary(3)).toBe('3 recorded')
  })
})

describe('planSummary', () => {
  const p = (status: string, stepIndex = 0, n = 3) => ({ status, stepIndex, plan: Array.from({ length: n }, (_, i) => `s${i}`) })
  it('says where the plan is, in the project’s own state', () => {
    expect(planSummary(p('planned'))).toBe('3 steps · not started')
    expect(planSummary(p('running', 1))).toBe('step 2 of 3')
    expect(planSummary(p('done', 3))).toBe('3 steps · done')
    expect(planSummary(p('attention', 1))).toBe('3 steps · needs a look')
    expect(planSummary(p('awaiting', 1))).toBe('3 steps · waiting for you')
    expect(planSummary(p('done', 1, 1))).toBe('1 step · done')
  })
})
