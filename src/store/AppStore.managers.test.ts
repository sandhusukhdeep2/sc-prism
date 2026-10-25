import { describe, expect, it } from 'vitest'
import { buildEngineProviders, buildManagerProviders, teamReportBody } from './AppStore'
import { setInterview } from '../lib/interview'
import type { Settings } from '../lib/settings'
import type { TeamResult } from '../lib/nativeEngine'

// buildEngineProviders/buildManagerProviders touch settings.companionName and
// settings.engineFlags.* (via buildCompanionContext), so the fixture needs
// them even though this suite only cares about tier1. Not in the brief's
// literal snippet — added because the bare `{ providers: [...] }` mock throws
// (`Cannot read properties of undefined (reading 'trim')`) before reaching
// the tier1 line. See task-2-report.md for detail.
const settings = {
  providers: [
    {
      id: 'local',
      name: 'Local model',
      baseUrl: 'http://localhost:1234',
      apiKey: '',
      enabled: true,
      primary: true,
      connected: true,
    },
  ],
  companionName: '',
  engineFlags: { deepeval: false, lightrag: false, bifrost: false },
} as unknown as Settings

describe('buildManagerProviders tier1 handling', () => {
  it('blanks tier1 by default (reports do not run the code gate)', () => {
    const { providers } = buildManagerProviders(settings, 'local')
    expect(providers.tier1).toBe('')
  })
  it('keepTier1 preserves whatever buildEngineProviders produced (dispatch runs real checks)', () => {
    // A non-empty verify command makes this assertion actually discriminate:
    // with the default '' verify command, both the old (always-blank) and new
    // (keepTier1) code produce '', so the assertion would pass either way.
    setInterview({ verifyCommand: 'npm test' })
    const baseline = buildEngineProviders(settings).providers.tier1
    const { providers } = buildManagerProviders(settings, 'local', { keepTier1: true })
    expect(providers.tier1).toBe(baseline)
    expect(providers.tier1).toBe('npm test')
  })
})

// --- Part C2: team run report body (pure) ---

const teamResult = (over: Partial<TeamResult> = {}): TeamResult => ({
  run_id: 'run-1',
  board: [],
  synthesis: '',
  board_path: 'board/run-1.json',
  tokens: 0,
  passed: false,
  overBudget: false,
  tokenBudget: 0,
  reason: '',
  taskId: 'run-1',
  spansPath: 'spans/run-1.jsonl',
  verdictPath: '',
  ...over,
})

describe('teamReportBody', () => {
  it('a passed run: synthesis text, budget line, and verdict path', () => {
    const res = teamResult({
      passed: true,
      synthesis: 'All good',
      tokens: 500,
      tokenBudget: 1000,
      overBudget: false,
      verdictPath: 'verdicts/abc.json',
    })
    expect(teamReportBody(res)).toEqual({
      ok: true,
      label: 'team · passed',
      text: 'All good\n\n500 / 1,000 tok\nverdict: verdicts/abc.json',
      summary: 'All good',
    })
  })

  it('a failed run falls back to the reason when synthesis is empty', () => {
    const res = teamResult({
      passed: false,
      synthesis: '',
      reason: 'Tier-2 judge rejected: missing tests',
      tokens: 300,
      tokenBudget: 1000,
      overBudget: false,
      verdictPath: '',
    })
    expect(teamReportBody(res)).toEqual({
      ok: false,
      label: 'team · failed',
      text: 'Tier-2 judge rejected: missing tests\n\n300 / 1,000 tok',
      summary: 'Tier-2 judge rejected: missing tests',
    })
  })

  it('an over-budget run flags OVER BUDGET in the token line', () => {
    const res = teamResult({
      passed: false,
      synthesis: 'partial synthesis',
      reason: 'budget exceeded',
      tokens: 120_000,
      tokenBudget: 100_000,
      overBudget: true,
      verdictPath: 'verdicts/xyz.json',
    })
    expect(teamReportBody(res)).toEqual({
      ok: false,
      label: 'team · failed',
      text: 'partial synthesis\n\n120,000 / 100,000 tok · OVER BUDGET\nverdict: verdicts/xyz.json',
      summary: 'partial synthesis',
    })
  })

  it('a null result (offline/timeout) reports the honest placeholder, no extra body', () => {
    expect(teamReportBody(null)).toEqual({
      ok: false,
      label: 'team · failed',
      text: '(no team result — provider offline or timed out?)',
      summary: '(no team result — provider offline or timed out?)',
    })
  })

  it('summary replaces newlines with · and caps at 160 chars', () => {
    const longSynthesis = 'First line\nSecond line\nThird line with a very long continuation that goes way beyond 160 characters when we start counting all of these words and everything else that might be in the synthesis so that we can test the slicing behavior accurately without other content'
    const res = teamResult({
      passed: true,
      synthesis: longSynthesis,
      tokens: 100,
      tokenBudget: 1000,
    })
    const result = teamReportBody(res)
    // Newlines are replaced with ' · ', then sliced to 160 chars
    expect(result.summary).toBe('First line · Second line · Third line with a very long continuation that goes way beyond 160 characters when we start counting all of these words and everything')
    expect(result.summary.length).toBe(160)
  })
})
