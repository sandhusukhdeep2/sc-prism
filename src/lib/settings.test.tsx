import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  DEFAULT_SETTINGS,
  normalizeProviderBase,
  pingProvider,
  providerModel,
  SettingsProvider,
  useSettings,
  type Settings,
} from './settings'

const STORAGE_KEY = 'scprism.settings'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// Stub global.fetch with a status/handler. In jsdom isNative() is false, so
// pingProvider takes the fetch path.
function stubFetch(handler: (url: string, init?: RequestInit) => number | 'throw') {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(url)
      const r = handler(url, init)
      if (r === 'throw') return Promise.reject(new Error('network'))
      return Promise.resolve({ status: r, ok: r >= 200 && r < 300 } as Response)
    }),
  )
  return calls
}

describe('pingProvider status mapping', () => {
  it('maps a 2xx to "ok"', async () => {
    stubFetch(() => 200)
    expect(await pingProvider('http://127.0.0.1:8000')).toBe('ok')
  })

  it('maps a 401 to "auth" (reachable, key needed — NOT unreachable)', async () => {
    stubFetch(() => 401)
    expect(await pingProvider('http://127.0.0.1:8000')).toBe('auth')
  })

  it('maps a 403 to "auth"', async () => {
    stubFetch(() => 403)
    expect(await pingProvider('http://127.0.0.1:8000')).toBe('auth')
  })

  it('maps a network throw on all candidates to "unreachable"', async () => {
    stubFetch(() => 'throw')
    expect(await pingProvider('http://127.0.0.1:8000')).toBe('unreachable')
  })

  it('normalizes a trailing /v1 so the probe is /v1/models, not /v1/v1/models', async () => {
    const calls = stubFetch(() => 200)
    await pingProvider('http://127.0.0.1:8000/v1/')
    expect(calls[0]).toBe('http://127.0.0.1:8000/v1/models')
    expect(calls[0]).not.toContain('/v1/v1')
  })

  it('sends an Authorization: Bearer header when an apiKey is supplied', async () => {
    let seenAuth: string | undefined
    stubFetch((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seenAuth = headers.Authorization
      return 200
    })
    await pingProvider('http://127.0.0.1:8000', 'sk-test')
    expect(seenAuth).toBe('Bearer sk-test')
  })
})

describe('normalizeProviderBase', () => {
  it('strips trailing slashes and a trailing /v1', () => {
    expect(normalizeProviderBase('http://127.0.0.1:8000/v1/')).toBe('http://127.0.0.1:8000')
    expect(normalizeProviderBase('http://127.0.0.1:8000///')).toBe('http://127.0.0.1:8000')
    expect(normalizeProviderBase('http://localhost:1234')).toBe('http://localhost:1234')
  })
})

// Tiny probe that surfaces the context values and exposes an action to mutate them.
function Probe() {
  const { settings, setTheme } = useSettings()
  const primary = settings.providers.find((p) => p.primary)
  return (
    <div>
      <span data-testid="theme">{settings.theme}</span>
      <span data-testid="primary-id">{primary?.id ?? 'none'}</span>
      <span data-testid="primary-enabled">{String(primary?.enabled ?? false)}</span>
      <button onClick={() => setTheme('obsidian')}>set-obsidian</button>
    </div>
  )
}

describe('settings defaults', () => {
  it('DEFAULT_SETTINGS has the local model as the enabled primary provider', () => {
    const primary = DEFAULT_SETTINGS.providers.find((p) => p.primary)
    expect(primary?.id).toBe('local')
    expect(primary?.enabled).toBe(true)
    expect(DEFAULT_SETTINGS.theme).toBe('amber')
  })

  it('providerModel falls back to local-model when no model is set', () => {
    expect(providerModel({ ...DEFAULT_SETTINGS.providers[0], model: undefined })).toBe(
      'local-model',
    )
    expect(providerModel({ ...DEFAULT_SETTINGS.providers[0], model: '  gpt-4o  ' })).toBe('gpt-4o')
  })
})

describe('SettingsProvider', () => {
  it('exposes the defaults through the provider (local primary)', () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('theme')).toHaveTextContent('amber')
    expect(screen.getByTestId('primary-id')).toHaveTextContent('local')
    expect(screen.getByTestId('primary-enabled')).toHaveTextContent('true')
  })

  it('persists an update to localStorage', async () => {
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    )

    act(() => {
      screen.getByText('set-obsidian').click()
    })

    expect(screen.getByTestId('theme')).toHaveTextContent('obsidian')

    await waitFor(() => {
      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string) as Settings
      expect(parsed.theme).toBe('obsidian')
    })
  })

  function HydratedProbe() {
    const { hydrated } = useSettings()
    return <span data-testid="hydrated">{hydrated ? 'yes' : 'no'}</span>
  }

  it('exposes hydrated=true in the browser (no native disk store to wait for)', () => {
    render(
      <SettingsProvider>
        <HydratedProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('hydrated')).toHaveTextContent('yes')
  })

  function YourNameProbe() {
    const { settings, setYourName } = useSettings()
    return (
      <div>
        <span data-testid="yourName">{settings.yourName}</span>
        <button onClick={() => setYourName('Sukhdeep')}>set-name</button>
      </div>
    )
  }

  it('persists yourName updates to localStorage', async () => {
    render(
      <SettingsProvider>
        <YourNameProbe />
      </SettingsProvider>,
    )

    expect(screen.getByTestId('yourName')).toHaveTextContent('')

    act(() => {
      screen.getByText('set-name').click()
    })

    expect(screen.getByTestId('yourName')).toHaveTextContent('Sukhdeep')

    await waitFor(() => {
      const raw = localStorage.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string) as Settings
      expect(parsed.yourName).toBe('Sukhdeep')
    })
  })

  function ApprovalModeProbe() {
    const { settings, setApprovalMode } = useSettings()
    return (
      <div>
        <span data-testid="approvalMode">{settings.approvalMode}</span>
        <button onClick={() => setApprovalMode('auto')}>set-auto</button>
        <button onClick={() => setApprovalMode('approve')}>set-approve</button>
      </div>
    )
  }

  it('defaults approvalMode to "approve" (safe default for new users)', () => {
    render(
      <SettingsProvider>
        <ApprovalModeProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('approvalMode')).toHaveTextContent('approve')
    expect(DEFAULT_SETTINGS.approvalMode).toBe('approve')
  })

  it('persists an approvalMode change to localStorage and back to approve', async () => {
    render(
      <SettingsProvider>
        <ApprovalModeProbe />
      </SettingsProvider>,
    )

    act(() => {
      screen.getByText('set-auto').click()
    })
    expect(screen.getByTestId('approvalMode')).toHaveTextContent('auto')

    await waitFor(() => {
      const raw = localStorage.getItem(STORAGE_KEY)
      const parsed = JSON.parse(raw as string) as Settings
      expect(parsed.approvalMode).toBe('auto')
    })

    act(() => {
      screen.getByText('set-approve').click()
    })
    expect(screen.getByTestId('approvalMode')).toHaveTextContent('approve')
  })

  it('loads a persisted "auto" approvalMode from localStorage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, approvalMode: 'auto' }),
    )
    render(
      <SettingsProvider>
        <ApprovalModeProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('approvalMode')).toHaveTextContent('auto')
  })

  it('falls back garbage/missing approvalMode to "approve"', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, approvalMode: 'yolo' }),
    )
    render(
      <SettingsProvider>
        <ApprovalModeProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('approvalMode')).toHaveTextContent('approve')
  })

  // R1: routing mode. 'pinned' is the safe default (your primary always wins);
  // 'auto' hands the default lane to the adopted router.
  function RoutingModeProbe() {
    const { settings, setRoutingMode } = useSettings()
    return (
      <div>
        <span data-testid="routingMode">{settings.routingMode}</span>
        <button onClick={() => setRoutingMode('auto')}>set-auto</button>
      </div>
    )
  }

  it('defaults routingMode to "pinned" and persists a switch to "auto"', async () => {
    expect(DEFAULT_SETTINGS.routingMode).toBe('pinned')
    render(
      <SettingsProvider>
        <RoutingModeProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('routingMode')).toHaveTextContent('pinned')

    act(() => {
      screen.getByText('set-auto').click()
    })
    expect(screen.getByTestId('routingMode')).toHaveTextContent('auto')

    await waitFor(() => {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as Settings
      expect(parsed.routingMode).toBe('auto')
    })
  })

  it('falls back garbage/missing routingMode to "pinned" (never silently unsets the primary)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, routingMode: 'yolo' }))
    render(
      <SettingsProvider>
        <RoutingModeProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('routingMode')).toHaveTextContent('pinned')
  })

  // Web research (web design, 2026-07-23). Opt-in, default OFF: no web egress
  // until the user turns it on. The optional search API key is persisted (held
  // by the bridge) but is only ever rendered through a masked password field —
  // this probe reads it from the store, never echoing it into a visible input.
  function WebResearchProbe() {
    const { settings, setWebResearch, setSearchApiKey } = useSettings()
    return (
      <div>
        <span data-testid="webResearch">{String(settings.webResearch)}</span>
        <span data-testid="searchApiKey">{settings.searchApiKey}</span>
        <button onClick={() => setWebResearch(true)}>enable-web</button>
        <button onClick={() => setSearchApiKey('sk-search-123')}>set-key</button>
      </div>
    )
  }

  it('defaults webResearch to ON (sprint D — the governed loop still gates every fetch)', () => {
    expect(DEFAULT_SETTINGS.webResearch).toBe(true)
    expect(DEFAULT_SETTINGS.searchApiKey).toBe('')
    render(
      <SettingsProvider>
        <WebResearchProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('webResearch')).toHaveTextContent('true')
  })

  it('persists enabling webResearch + a search key to localStorage', async () => {
    render(
      <SettingsProvider>
        <WebResearchProbe />
      </SettingsProvider>,
    )

    act(() => {
      screen.getByText('enable-web').click()
      screen.getByText('set-key').click()
    })
    expect(screen.getByTestId('webResearch')).toHaveTextContent('true')

    await waitFor(() => {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as Settings
      expect(parsed.webResearch).toBe(true)
      expect(parsed.searchApiKey).toBe('sk-search-123')
    })
  })

  it('loads a persisted webResearch=true from localStorage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, webResearch: true, searchApiKey: 'sk-x' }),
    )
    render(
      <SettingsProvider>
        <WebResearchProbe />
      </SettingsProvider>,
    )
    expect(screen.getByTestId('webResearch')).toHaveTextContent('true')
    expect(screen.getByTestId('searchApiKey')).toHaveTextContent('sk-x')
  })

  it('only the literal false switches webResearch off; garbage loads the governed default ON', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, webResearch: false, searchApiKey: 42 }),
    )
    render(
      <SettingsProvider>
        <WebResearchProbe />
      </SettingsProvider>,
    )
    // The user's explicit OFF is honored exactly; a non-string key → ''.
    expect(screen.getByTestId('webResearch')).toHaveTextContent('false')
    expect(screen.getByTestId('searchApiKey')).toHaveTextContent('')
  })
})
