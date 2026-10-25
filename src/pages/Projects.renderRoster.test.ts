import { describe, expect, it } from 'vitest'
import { renderRoster, rosterSummary } from './Projects'

// MV5 (Manager View §5, approval modes): the build-proposal panel's pure
// team renderer. `rosterSummary` already renders "role → model" pairs for
// the existing team-roster line (TeamRosterControl) — reused here, not
// duplicated. `renderRoster` adds the one thing the proposal needs that the
// existing callers don't: an honest phrase for an empty roster.
describe('rosterSummary (exported, reused by renderRoster)', () => {
  it('renders "role → model" pairs joined by " · "', () => {
    expect(rosterSummary('lead:claude,planner:gemini,developer:local')).toBe(
      'lead → claude · planner → gemini · developer → local',
    )
  })

  it('returns an empty string for an empty roster', () => {
    expect(rosterSummary('')).toBe('')
  })
})

describe('renderRoster', () => {
  it('renders each role → model pair readably', () => {
    const out = renderRoster('lead:claude,planner:gemini,developer:local')
    expect(out).toContain('lead → claude')
    expect(out).toContain('planner → gemini')
    expect(out).toContain('developer → local')
  })

  it('tolerates whitespace around pairs', () => {
    const out = renderRoster(' lead:claude , planner:gemini ')
    expect(out).toContain('lead → claude')
    expect(out).toContain('planner → gemini')
  })

  it('renders the default-team phrase for an empty roster', () => {
    expect(renderRoster('')).toBe('your default team')
  })

  it('renders the default-team phrase for a blank/whitespace-only roster', () => {
    expect(renderRoster('   ')).toBe('your default team')
  })
})
