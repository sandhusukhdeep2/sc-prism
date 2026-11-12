import { describe, expect, it } from 'vitest'
import { seatByWorkload, settingsStop, workloadAIs } from './workloadSeats'
import type { Settings } from './settings'

// The slider, read from Settings: which AIs there are to seat, which stop is
// in force, and a roster re-seated for it.
function settings(over: Partial<Settings> = {}, providers?: Partial<Settings['providers'][number]>[]): Settings {
  const list = providers ?? [
    { id: 'claude-cli', enabled: true, primary: true },
    { id: 'local', enabled: true, baseUrl: 'http://localhost:1234' },
    { id: 'gemini', enabled: true, apiKey: 'g-real' },
    { id: 'openai', enabled: false, apiKey: 'o-real' },
  ]
  return {
    providers: list.map((p) => ({ id: 'local', name: '', baseUrl: '', apiKey: '', enabled: true, primary: false, ...p })),
    workload: 'measured',
    workloadMeasured: '',
    workloadSecondOpinion: false,
    ...over,
  } as unknown as Settings
}

const team = 'lead:claude-cli,researcher:local,critic:gemini'

describe('workloadAIs — the AIs there are to seat', () => {
  it('names the primary, the local model and a second connected cloud AI', () => {
    expect(workloadAIs(settings())).toEqual({ primary: 'claude-cli', local: 'local', second: 'gemini' })
  })

  it('an AI that is switched off or has no credential is not there', () => {
    const s = settings({}, [
      { id: 'claude', enabled: true, primary: true, apiKey: 'sk-real' },
      { id: 'local', enabled: true, baseUrl: '' },
      { id: 'gemini', enabled: true, apiKey: '' },
    ])
    expect(workloadAIs(s)).toEqual({ primary: 'claude', local: '', second: '' })
  })

  it('with no primary marked there is no primary to lean on', () => {
    const s = settings({}, [{ id: 'local', enabled: true, baseUrl: 'http://localhost:1234' }])
    expect(workloadAIs(s).primary).toBe('')
  })
})

describe('settingsStop — the stop in force', () => {
  it('a chosen stop is in force', () => {
    expect(settingsStop(settings({ workload: 'local-all' }))).toBe('local-all')
  })
  it('"measured" follows the cached measurement', () => {
    expect(settingsStop(settings({ workload: 'measured', workloadMeasured: 'primary-leads' }))).toBe('primary-leads')
  })
  it('with nothing measured, and for a store that predates the slider, nothing changes', () => {
    expect(settingsStop(settings())).toBe('agents')
    expect(settingsStop({ providers: [] } as unknown as Settings)).toBe('agents')
  })
})

describe('seatByWorkload — a roster, re-seated for the stop in force', () => {
  it('leaves the roster alone until a stop is in force', () => {
    expect(seatByWorkload(settings(), team)).toBe(team)
  })
  it('re-seats it for a chosen stop', () => {
    expect(seatByWorkload(settings({ workload: 'local-all' }), team)).toBe('lead:local,researcher:local,critic:local')
    expect(seatByWorkload(settings({ workload: 'primary-leads' }), team)).toBe(
      'lead:claude-cli,researcher:local,critic:claude-cli',
    )
  })
  it('honours the second opinion', () => {
    expect(seatByWorkload(settings({ workload: 'primary-leads', workloadSecondOpinion: true }), team)).toBe(team)
  })
})
