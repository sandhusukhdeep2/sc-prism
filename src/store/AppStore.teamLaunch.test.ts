import { describe, expect, it } from 'vitest'
import { teamNoticeText, teamRosterFromSettings } from './AppStore'
import type { Settings } from '../lib/settings'
import type { TeamResult } from '../lib/nativeEngine'

// Mission Control §Give a task from Work (2026-08-06). The team launch now has
// TWO callers (the Agents page and the Work composer), so the pieces they both
// show — the default roles and the ending line — live once, here, and are
// pinned here. Same minimal fixture shape as AppStore.webResearch.test.ts.
function makeSettings(providers: Partial<Settings['providers'][number]>[]): Settings {
  return {
    providers: providers.map((p) => ({
      id: 'local',
      name: 'Local model',
      baseUrl: '',
      apiKey: '',
      enabled: true,
      primary: false,
      ...p,
    })),
    companionName: '',
    engineFlags: { deepeval: false, lightrag: false, bifrost: false },
    vaultPath: '~/vault',
    vaultMode: 'local',
    webResearch: false,
  } as unknown as Settings
}

// CONNECTED, not merely switched on (2026-08-12). These fixtures used to give
// every provider `enabled: true` and NO credential — a cloud provider with no
// API key, a local server with no base URL — and expected them on the default
// team anyway. That is precisely the state that produced the bug: the roster
// named a provider that could only ever return an offline stub, and the board
// rendered that stub as a real seat. So the fixtures now carry the credential
// that makes a provider genuinely able to answer, and the uncredentialled case
// is pinned as an EXCLUSION rather than a seat.
describe('teamRosterFromSettings — the shared default roles', () => {
  it('builds lead/researcher/critic from what is actually connected', () => {
    const settings = makeSettings([
      { id: 'local', enabled: true, primary: false, baseUrl: 'http://localhost:1234' },
      { id: 'claude', enabled: true, primary: true, apiKey: 'sk-real' },
      { id: 'gemini', enabled: true, primary: false, apiKey: 'g-real' },
    ])
    expect(teamRosterFromSettings(settings)).toBe('lead:claude,researcher:local,critic:gemini')
  })

  it('offers NO critic when nothing else is connected — it never invents one', () => {
    const settings = makeSettings([
      { id: 'local', enabled: true, primary: true, baseUrl: 'http://localhost:1234' },
      { id: 'claude', enabled: false, primary: false }, // not enabled — not offered
    ])
    // It used to hand back `critic:gemini` here regardless, naming a provider
    // the user had never connected; that seat could only ever stub.
    expect(teamRosterFromSettings(settings)).toBe('lead:local,researcher:local')
  })

  it('falls back to a local lead when no provider is marked primary', () => {
    expect(
      teamRosterFromSettings(
        makeSettings([{ id: 'local', enabled: true, primary: false, baseUrl: 'http://localhost:1234' }]),
      ),
    ).toBe('lead:local,researcher:local')
  })

  it('EXCLUDES a provider that is switched on but has no credential — it would stub', () => {
    const settings = makeSettings([
      { id: 'local', enabled: true, primary: false, baseUrl: 'http://localhost:1234' },
      // Enabled, and unable to answer a single call: no key.
      { id: 'claude', enabled: true, primary: true, apiKey: '' },
    ])
    expect(teamRosterFromSettings(settings)).toBe('lead:local,researcher:local')
  })

  it('a subscription CLI needs no key — its sign-in IS its credential', () => {
    const settings = makeSettings([
      { id: 'local', enabled: false, primary: false },
      { id: 'claude-cli', enabled: true, primary: true, apiKey: '', baseUrl: '' },
    ])
    expect(teamRosterFromSettings(settings)).toBe('lead:claude-cli')
  })

  it('returns "" when NOTHING is connected — the launch refuses on that, never runs a stub team', () => {
    const settings = makeSettings([
      { id: 'local', enabled: true, primary: true, baseUrl: '' },
      { id: 'gemini', enabled: false },
    ])
    expect(teamRosterFromSettings(settings)).toBe('')
  })
})

const result = (over: Partial<TeamResult>): TeamResult =>
  ({
    run_id: 'r1',
    board: [],
    synthesis: 's',
    board_path: '/vault/agents/board-r1.jsonl',
    tokens: 1200,
    passed: true,
    overBudget: false,
    tokenBudget: 100000,
    reason: '',
    taskId: 'r1',
    spansPath: '',
    verdictPath: '',
    ...over,
  }) as unknown as TeamResult

describe('teamNoticeText — the ending the chat reports', () => {
  it('reports the run’s REAL verdict, token sum and board path', () => {
    expect(teamNoticeText(result({}))).toBe(
      'team run passed · 1,200/100,000 tok · board saved: /vault/agents/board-r1.jsonl',
    )
  })

  it('says a failure did not pass, and carries the engine’s own reason', () => {
    expect(teamNoticeText(result({ passed: false, reason: 'the critic rejected it' }))).toBe(
      'team run did not pass — the critic rejected it · 1,200/100,000 tok · board saved: /vault/agents/board-r1.jsonl',
    )
  })

  it('flags a real budget breach, and omits a reason the engine did not give', () => {
    expect(teamNoticeText(result({ passed: false, overBudget: true, reason: '' }))).toBe(
      'team run did not pass · 1,200/100,000 tok (over budget) · board saved: /vault/agents/board-r1.jsonl',
    )
  })

  it('omits the board line when the run wrote no board — never a made-up path', () => {
    expect(teamNoticeText(result({ board_path: '' }))).toBe('team run passed · 1,200/100,000 tok')
  })
})
