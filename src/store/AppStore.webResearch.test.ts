import { describe, expect, it } from 'vitest'
import { buildEngineProviders } from './AppStore'
import type { Settings } from '../lib/settings'

// Web research (web design, 2026-07-23) launch wiring. `buildEngineProviders`
// is the single seam that turns Settings into the EngineProviders bundle the
// native run forwards; `providers.webResearch` is exactly what `runNativeTask`/
// `runNativeProject`/`runNativeTeam` map to the invoke `web` field, which the
// Rust bridge turns into the `--web` argv flag. So asserting the flag here is
// asserting "--web is passed iff settings.webResearch is on". Same minimal
// fixture shape as AppStore.projectContext.test.ts.
function makeSettings(over: Partial<Settings>): Settings {
  return {
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
    vaultPath: '~/vault',
    vaultMode: 'local',
    webResearch: false,
    searchApiKey: '',
    searchEndpoint: '',
    ...over,
  } as unknown as Settings
}

describe('buildEngineProviders — web research launch flag', () => {
  it('forwards webResearch=false by default (no --web, no key)', () => {
    const { providers } = buildEngineProviders(makeSettings({ webResearch: false }))
    expect(providers.webResearch).toBe(false)
    expect(providers.searchApiKey).toBe('')
    expect(providers.searchEndpoint).toBe('')
  })

  it('forwards webResearch=true + the search key/endpoint when web research is on', () => {
    const { providers } = buildEngineProviders(
      makeSettings({
        webResearch: true,
        searchApiKey: 'sk-search-abc',
        searchEndpoint: 'https://search.example/api',
      }),
    )
    expect(providers.webResearch).toBe(true)
    expect(providers.searchApiKey).toBe('sk-search-abc')
    expect(providers.searchEndpoint).toBe('https://search.example/api')
  })

  it('is the exact seam runNativeTask maps to the invoke `web` field (iff on)', () => {
    // off → the ?? false in runNativeTask/Team/Project resolves to false;
    // on → true. This mirrors the "byte-identical without --web" guarantee.
    expect(buildEngineProviders(makeSettings({ webResearch: false })).providers.webResearch).toBe(
      false,
    )
    expect(buildEngineProviders(makeSettings({ webResearch: true })).providers.webResearch).toBe(
      true,
    )
  })
})

// 2026-11-11: registered plugin (MCP) servers reach a run. `settings.mcpServers`
// is the cached list of registered names; `providers.mcpServers` is what the
// run functions map to the invoke `mcpServers` field, which the bridge turns
// into `--mcp-server`. Empty stays empty: no flag, byte-identical.
describe('buildEngineProviders — registered plugin servers', () => {
  it('forwards nothing when no server is registered', () => {
    expect(buildEngineProviders(makeSettings({})).providers.mcpServers ?? '').toBe('')
    expect(buildEngineProviders(makeSettings({ mcpServers: [] })).providers.mcpServers ?? '').toBe('')
  })
  it('forwards the registered names as one comma list', () => {
    const { providers } = buildEngineProviders(makeSettings({ mcpServers: ['files', 'github'] }))
    expect(providers.mcpServers).toBe('files,github')
  })
  it('never forwards a name that is not a safe single token', () => {
    const { providers } = buildEngineProviders(
      makeSettings({ mcpServers: ['files', '--flag', 'a b'] as unknown as string[] }),
    )
    expect(providers.mcpServers).toBe('files')
  })
})

// 2026-11-11: who may be shown the screen. Both ride the provider bundle to the
// bridge, which turns them into SCPRISM_LOCAL_VISION / SCPRISM_SCREEN_TO_CLOUD.
describe('buildEngineProviders — the screen switches', () => {
  it('are off unless the setting is on', () => {
    const { providers } = buildEngineProviders(makeSettings({}))
    expect(providers.localVision ?? false).toBe(false)
    expect(providers.screenToCloud ?? false).toBe(false)
  })
  it('forward each setting as it is', () => {
    const { providers } = buildEngineProviders(makeSettings({ localVision: true, screenToCloud: false }))
    expect(providers.localVision).toBe(true)
    expect(providers.screenToCloud).toBe(false)
  })
  it('never forward the cloud switch when computer control itself is off', () => {
    const { providers } = buildEngineProviders(
      makeSettings({ screenToCloud: true, computerControl: false }),
    )
    expect(providers.screenToCloud).toBe(false)
  })
})
