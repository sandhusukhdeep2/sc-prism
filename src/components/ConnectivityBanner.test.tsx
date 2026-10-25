import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../lib/settings'
import type { ConnectivityValue, ServiceHealth } from '../lib/connectivity'
import ConnectivityBanner from './ConnectivityBanner'

const seedProviders = () => {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
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
    }),
  )
}

const makeConn = (
  health: Record<string, ServiceHealth>,
  over: Partial<ConnectivityValue> = {},
): ConnectivityValue => ({
  health,
  anyDown: Object.values(health).some((h) => h.status === 'auth' || h.status === 'unreachable'),
  primaryDown: false,
  bannerDismissed: false,
  dismissBanner: vi.fn(),
  probeAll: vi.fn(async () => {}),
  probeOne: vi.fn(async () => 'ok' as const),
  markUnreachable: vi.fn(),
  ...over,
})

const renderBanner = (conn: ConnectivityValue) =>
  render(
    <MemoryRouter>
      <SettingsProvider>
        <ConnectivityBanner conn={conn} />
      </SettingsProvider>
    </MemoryRouter>,
  )

describe('ConnectivityBanner', () => {
  beforeEach(() => seedProviders())
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('renders nothing when everything is healthy', () => {
    renderBanner(makeConn({ local: { status: 'ok', lastChecked: 1 } }))
    expect(screen.queryByTestId('conn-banner')).not.toBeInTheDocument()
  })

  it('renders nothing when dismissed, even while down', () => {
    renderBanner(
      makeConn({ local: { status: 'unreachable', lastChecked: 1 } }, { bannerDismissed: true }),
    )
    expect(screen.queryByTestId('conn-banner')).not.toBeInTheDocument()
  })

  it('names the dead server and asks if it is running', () => {
    renderBanner(makeConn({ local: { status: 'unreachable', lastChecked: 1 } }))
    expect(screen.getByTestId('conn-banner')).toHaveTextContent(
      'Local model is unreachable — is the server running?',
    )
  })

  it('uses the rejected-key copy for auth failures', () => {
    renderBanner(makeConn({ local: { status: 'auth', lastChecked: 1 } }))
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('Local model rejected your API key.')
  })

  it('keeps rendering the unreachable copy while a Retry sweep is in flight', () => {
    renderBanner(
      makeConn(
        { local: { status: 'checking', prev: 'unreachable', lastChecked: 1 } },
        { anyDown: true },
      ),
    )
    expect(screen.getByTestId('conn-banner')).toHaveTextContent(
      'Local model is unreachable — is the server running?',
    )
  })

  it('names the first down service and tallies the rest (multi-down: +N more)', () => {
    // Two probe targets, both down — exercises the `down.length > 1` suffix
    // branch (the only multi-down path), which the single-provider cases above
    // never reach. The banner names the FIRST down service and counts the rest.
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
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
          {
            id: 'openai',
            name: 'OpenAI',
            baseUrl: '',
            apiKey: '',
            enabled: true,
            primary: false,
            connected: true,
          },
        ],
      }),
    )
    renderBanner(
      makeConn({
        local: { status: 'unreachable', lastChecked: 1 },
        openai: { status: 'auth', lastChecked: 1 },
      }),
    )
    expect(screen.getByTestId('conn-banner')).toHaveTextContent(
      'Local model is unreachable — is the server running? (+1 more)',
    )
  })

  it('Retry sweeps and Dismiss dismisses', () => {
    const conn = makeConn({ local: { status: 'unreachable', lastChecked: 1 } })
    renderBanner(conn)
    act(() => screen.getByText('Retry').click())
    expect(conn.probeAll).toHaveBeenCalledOnce()
    act(() => screen.getByLabelText('Dismiss').click())
    expect(conn.dismissBanner).toHaveBeenCalledOnce()
  })
})

// The most expensive lie this product can tell: sending you to fix something
// that is not broken. Sukhdeep had Claude Code 2.1.220 installed and answering
// a probe in 7 seconds while the banner told him it was not installed — which
// also made his whole crew read as dead, since every Claude agent then sat out.
describe('a CLI banner claims "not installed" ONLY when the binary was not found', () => {
  // A CLI provider must be in settings for `probeTargets` to surface it.
  const seedCli = () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        providers: [
          {
            id: 'claude-cli',
            name: 'Claude Code (Pro/Max plan)',
            baseUrl: '',
            apiKey: '',
            enabled: true,
            connected: true,
          },
        ],
      }),
    )
  }
  beforeEach(() => seedCli())
  afterEach(() => localStorage.clear())

  it('an installed CLI that could not answer says exactly that', () => {
    renderBanner(makeConn({ 'claude-cli': { status: 'auth', lastChecked: Date.now() } }))
    expect(screen.getByTestId('conn-banner').textContent).toMatch(
      /installed but couldn.t answer/i,
    )
    expect(screen.getByTestId('conn-banner').textContent).not.toMatch(/isn.t installed/i)
  })

  it('only a genuinely missing binary is reported as missing', () => {
    renderBanner(makeConn({ 'claude-cli': { status: 'unreachable', lastChecked: Date.now() } }))
    expect(screen.getByTestId('conn-banner').textContent).toMatch(/isn.t installed on this Mac/i)
  })

  it('a CLI is never told it rejected an API key — it does not use one', () => {
    renderBanner(makeConn({ 'claude-cli': { status: 'auth', lastChecked: Date.now() } }))
    expect(screen.getByTestId('conn-banner').textContent).not.toMatch(/API key/i)
  })
})
