// Who may take a seat on a team — and what is SAID about anyone who may not.
//
// The bug these pin (2026-08-12): a team gave every enabled agent a seat and
// never asked whether that agent's model mapped to a provider the app could
// reach. A live run recorded 'gemini-cli · opus' with is_real false and 13
// tokens out, an hour AFTER that provider was switched off in Settings. The
// same hole, one layer down: a CLI that is installed but can no longer answer.
import { describe, expect, it } from 'vitest'
import {
  emptyRosterRefusal,
  filterRoster,
  resolveProviderToken,
  rosterGate,
  seatReason,
  splitRoster,
  reassignLine,
} from './roster'
import type { CliProbe, ProviderConfig, Settings } from './settings'

function settingsWith(providers: Partial<ProviderConfig>[]): Settings {
  return {
    providers: providers.map((p) => ({
      id: 'local',
      name: 'Local model',
      baseUrl: '',
      apiKey: '',
      enabled: false,
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

/** The user's real setup at the time of the bug, minus the broken half. */
const connected = () =>
  settingsWith([
    { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', enabled: true },
    { id: 'claude', name: 'Claude', apiKey: 'sk-real', enabled: true, primary: true },
    { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)' },
    { id: 'gemini', name: 'Gemini', apiKey: 'g-real', enabled: true },
    { id: 'gemini-cli', name: 'Gemini CLI (Google login)' },
  ])

describe('seatReason — enabled is not connected', () => {
  it('a switched-OFF provider cannot take a seat, and says so', () => {
    const s = settingsWith([
      { id: 'local', baseUrl: 'http://localhost:1234', enabled: true },
      { id: 'gemini', name: 'Gemini', apiKey: 'g', enabled: false },
      { id: 'gemini-cli', name: 'Gemini CLI (Google login)', enabled: false },
    ])
    expect(seatReason(s, 'gemini')).toBe('Gemini is switched off in Settings')
    expect(seatReason(s, 'local')).toBe('')
  })

  it('a cloud provider with no key, and a local server with no URL, are not connected', () => {
    const s = settingsWith([
      { id: 'local', name: 'Local model', baseUrl: '', enabled: true },
      { id: 'claude', name: 'Claude', apiKey: '   ', enabled: true },
    ])
    expect(seatReason(s, 'local')).toBe('Local model has no server URL')
    expect(seatReason(s, 'claude')).toBe('Claude has no API key')
  })

  it('a token no provider answers to is named, not silently dropped', () => {
    expect(seatReason(connected(), 'mistral')).toBe('no “mistral” provider is set up')
  })

  it('everything connected → every seat is free (no reasons invented)', () => {
    const s = connected()
    expect(seatReason(s, 'claude')).toBe('')
    expect(seatReason(s, 'gemini')).toBe('')
    expect(seatReason(s, 'local')).toBe('')
  })
})

describe('seatReason — a CLI that is installed but cannot answer', () => {
  const withGeminiCli = () =>
    settingsWith([
      { id: 'local', baseUrl: 'http://localhost:1234', enabled: true },
      { id: 'gemini', name: 'Gemini', enabled: false },
      { id: 'gemini-cli', name: 'Gemini CLI (Google login)', enabled: true },
    ])
  const probeOf = (p: CliProbe | undefined) => () => p

  it('is excluded exactly like a disconnected provider — with the CLI’s own words', () => {
    const detail =
      'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals'
    const reason = seatReason(withGeminiCli(), 'gemini-cli', {
      probe: probeOf({ status: 'auth', detail, at: 1 }),
    })
    expect(reason).toContain("can't answer")
    expect(reason).toContain(detail)
  })

  it('not installed reads differently from installed-but-broken', () => {
    expect(
      seatReason(withGeminiCli(), 'gemini-cli', {
        probe: probeOf({ status: 'unreachable', detail: 'gemini is not installed', at: 1 }),
      }),
    ).toBe("Gemini CLI (Google login) isn't installed on this Mac")
  })

  it('a CLI that answered keeps its seat', () => {
    expect(
      seatReason(withGeminiCli(), 'gemini-cli', {
        probe: probeOf({ status: 'ok', detail: '', at: 1 }),
      }),
    ).toBe('')
  })

  it('NOT YET PROBED is not a reason — nobody is excluded on a guess', () => {
    expect(seatReason(withGeminiCli(), 'gemini-cli', { probe: () => undefined })).toBe('')
  })

  it('a probe still in flight is not a reason either', () => {
    const s = connected()
    expect(seatReason(s, 'claude', { health: { claude: { status: 'checking' } } })).toBe('')
  })
})

describe('the brand pairing — a token means the brand, not one half of it', () => {
  it('“claude” resolves to the subscription CLI when that is the half in use', () => {
    const s = settingsWith([
      { id: 'claude', name: 'Claude', enabled: false },
      { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)', enabled: true },
    ])
    expect(resolveProviderToken(s, 'claude')?.id).toBe('claude-cli')
    // …so the agent on 'claude' is NOT thrown off a team its user is signed in to.
    expect(seatReason(s, 'claude')).toBe('')
    expect(filterRoster('lead:claude', rosterGate(s), s).roster).toBe('lead:claude-cli')
  })
})

describe('filterRoster — drop the seat, KEEP the reason', () => {
  it('is byte-identical when every provider is connected', () => {
    const s = connected()
    const roster = 'lead:claude,researcher:local,critic:gemini'
    const out = filterRoster(roster, rosterGate(s), s)
    expect(out.roster).toBe(roster)
    expect(out.sitOut).toEqual([])
  })

  it('a disconnected seat is REASSIGNED to a provider that can answer — with the reason carried', () => {
    // The 2026-08-29 rule change: this used to DROP the critic. Sukhdeep:
    // "if we don't have Gemini set up, let the manager choose another way."
    const s = settingsWith([
      { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', enabled: true },
      { id: 'claude', name: 'Claude', apiKey: 'sk', enabled: true, primary: true },
      { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)' },
      { id: 'gemini', name: 'Gemini' },
      { id: 'gemini-cli', name: 'Gemini CLI (Google login)' },
    ])
    const out = filterRoster('lead:claude,researcher:local,critic:gemini-cli', rosterGate(s), s)
    expect(out.roster).toBe('lead:claude,researcher:local,critic:claude')
    expect(out.sitOut).toEqual([])
    expect(out.reassigned).toHaveLength(1)
    expect(out.reassigned[0]).toMatchObject({
      role: 'critic',
      from: 'gemini-cli',
      to: 'claude',
      reason: 'Gemini CLI (Google login) is switched off in Settings',
    })
  })

  it('refuses honestly when NOTHING is left, naming every reason', () => {
    const s = settingsWith([
      { id: 'local', name: 'Local model', baseUrl: '', enabled: true },
      { id: 'gemini', name: 'Gemini', enabled: false },
      { id: 'gemini-cli', name: 'Gemini CLI (Google login)', enabled: false },
    ])
    const out = filterRoster('lead:gemini,researcher:local', rosterGate(s), s)
    expect(out.roster).toBe('')
    const refusal = emptyRosterRefusal(out.sitOut)
    expect(refusal).toContain('No agent could run')
    expect(refusal).toContain('Gemini is switched off in Settings')
    expect(refusal).toContain('Local model has no server URL')
    // It says what to do, and never claims a run happened.
    expect(refusal).toContain('Connect one in Settings')
    expect(refusal).not.toMatch(/failed/i)
  })
})

describe('an empty roster is a refusal, never a silent "use the defaults"', () => {
  it('no seats at all reads as "no provider is connected"', () => {
    const refusal = emptyRosterRefusal([])
    expect(refusal).toContain('no AI provider is connected')
    expect(refusal).toContain('Connect one in Settings')
    expect(refusal).not.toMatch(/failed/i)
  })
})

describe('splitRoster', () => {
  it('parses role:token pairs and ignores rubbish', () => {
    expect(splitRoster(' lead:claude , ,researcher:local ')).toEqual([
      { role: 'lead', token: 'claude' },
      { role: 'researcher', token: 'local' },
    ])
  })

  it('a bare role defaults to local — the same default the engine parser uses', () => {
    expect(splitRoster('solo')).toEqual([{ role: 'solo', token: 'local' }])
  })
})

// NO SEAT DIES WITH ITS BRAND (Sukhdeep, 2026-08-29: "if we don't have Gemini
// set up, ask me or let the manager choose another way — use the cloud for
// research"). A seat whose preferred provider cannot answer is REASSIGNED to
// the best provider that can — visibly, with the reason carried, and the
// approve-team gate showing the resolved crew is exactly the "ask me". A seat
// only sits out when NOTHING on this install can answer.
describe('filterRoster — a gated seat falls back instead of sitting out', () => {
  const settings = {
    providers: [
      { id: 'local', name: 'Local model', enabled: true, primary: false, baseUrl: 'http://x', apiKey: 'k', model: 'q' },
      { id: 'claude-cli', name: 'Claude Code (Pro/Max plan)', enabled: true, primary: true, model: 'opus', baseUrl: '' },
      { id: 'gemini', name: 'Gemini', enabled: false, primary: false, model: 'g', baseUrl: 'http://g' },
    ],
  } as unknown as Parameters<typeof filterRoster>[2]

  const gate = (token: string) =>
    token === 'gemini' ? 'Gemini is switched off in Settings' : ''

  it('the researcher moves to the usable primary, named and reasoned', () => {
    const out = filterRoster('researcher:gemini,lead:claude-cli', gate, settings)
    expect(out.sitOut).toEqual([])
    expect(out.roster).toContain('researcher:claude-cli')
    expect(out.reassigned).toEqual([
      {
        role: 'researcher',
        from: 'gemini',
        to: 'claude-cli',
        reason: 'Gemini is switched off in Settings',
      },
    ])
  })

  it('with NOTHING usable the seat still sits out honestly', () => {
    const allDown = () => 'nothing is connected'
    const out = filterRoster('researcher:gemini', allDown, settings)
    expect(out.roster).toBe('')
    expect(out.sitOut).toHaveLength(1)
  })

  it('reassignLine says who moved where, and why', () => {
    expect(
      reassignLine([
        { role: 'researcher', from: 'gemini', to: 'claude-cli', reason: 'Gemini is switched off in Settings' },
      ]),
    ).toBe('researcher reassigned gemini → claude-cli (Gemini is switched off in Settings)')
    expect(reassignLine([])).toBe('')
  })
})
