import { describe, expect, it } from 'vitest'
import { connectivityErrorText, guardedPrimary } from './AppStore'
import type { ProviderConfig, Settings } from '../lib/settings'

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'local',
  name: 'Local model',
  baseUrl: 'http://localhost:1234',
  apiKey: '',
  enabled: true,
  primary: true,
  connected: true,
  ...over,
})

const settingsWith = (p: ProviderConfig): Settings =>
  ({ providers: [p] }) as unknown as Settings

describe('guardedPrimary', () => {
  it('returns a connected, enabled primary', () => {
    expect(guardedPrimary(settingsWith(provider({})))?.id).toBe('local')
  })
  it('returns the primary even when never connected — the banner names it, so the guard must cover it too', () => {
    expect(guardedPrimary(settingsWith(provider({ connected: false })))?.id).toBe('local')
  })
  it('returns null when the primary is disabled or absent', () => {
    expect(guardedPrimary(settingsWith(provider({ enabled: false })))).toBeNull()
    expect(guardedPrimary(settingsWith(provider({ primary: false })))).toBeNull()
  })
})

describe('connectivityErrorText', () => {
  it('says nothing was sent for an unreachable primary', () => {
    expect(connectivityErrorText('Local model', 'unreachable')).toBe(
      'Local model is unreachable — nothing was sent. Start the server and retry.',
    )
  })
  it('names the key problem for auth failures', () => {
    expect(connectivityErrorText('OpenAI', 'auth')).toBe(
      'OpenAI rejected your API key — nothing was sent. Fix the key and retry.',
    )
  })
})
