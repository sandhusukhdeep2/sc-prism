import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { SettingsProvider, useSettings } from './settings'
import { ConnectivityProvider, useConnectivity, isDown, isEffectivelyDown } from './connectivity'

const LOCAL_PROVIDER = {
  id: 'local',
  name: 'Local model',
  baseUrl: 'http://localhost:1234',
  apiKey: '',
  enabled: true,
  primary: true,
  connected: true,
}

// A second connected service. Uses the default 'openai' id because the
// settings loader drops unknown non-custom ids when merging with defaults.
const SECOND_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test',
  enabled: true,
  primary: false,
  connected: true,
}

// Seed connected providers so the cold-start sweep has targets.
const seedProviders = (providers: object[] = [LOCAL_PROVIDER]) => {
  localStorage.setItem('scprism.settings', JSON.stringify({ providers }))
}

const stubFetchStatus = (status: number) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ status, ok: status >= 200 && status < 300 } as Response)),
  )
}

function Probe() {
  const conn = useConnectivity()
  const { updateProvider } = useSettings()
  return (
    <div>
      <span data-testid="local-status">{conn.health['local']?.status ?? 'none'}</span>
      <span data-testid="openai-status">{conn.health['openai']?.status ?? 'none'}</span>
      <span data-testid="any-down">{conn.anyDown ? 'yes' : 'no'}</span>
      <span data-testid="dismissed">{conn.bannerDismissed ? 'yes' : 'no'}</span>
      <button onClick={() => void conn.probeAll()}>probe</button>
      <button onClick={() => conn.dismissBanner()}>dismiss</button>
      <button onClick={() => conn.markUnreachable('local')}>mark-down</button>
      <button onClick={() => updateProvider('openai', { enabled: false, connected: false })}>
        disable-openai
      </button>
    </div>
  )
}

// StrictMode double-invokes state updaters and effects in dev, so any updater
// impurity (side effects inside setState callbacks) surfaces as a failure here.
const renderProbe = () =>
  render(
    <StrictMode>
      <SettingsProvider>
        <ConnectivityProvider>
          <Probe />
        </ConnectivityProvider>
      </SettingsProvider>
    </StrictMode>,
  )

describe('isDown', () => {
  it("counts 'auth' and 'unreachable' as down, but not 'checking' (no red flash at boot)", () => {
    expect(isDown('auth')).toBe(true)
    expect(isDown('unreachable')).toBe(true)
    expect(isDown('checking')).toBe(false)
    expect(isDown('ok')).toBe(false)
    expect(isDown(undefined)).toBe(false)
  })
})

describe('isEffectivelyDown', () => {
  it('is false with no health entry', () => {
    expect(isEffectivelyDown(undefined)).toBe(false)
  })
  it('is false while checking with no prior settled status (cold start stays flash-free)', () => {
    expect(isEffectivelyDown({ status: 'checking', lastChecked: 0 })).toBe(false)
  })
  it('is true while checking if the last settled status was down', () => {
    expect(
      isEffectivelyDown({ status: 'checking', lastChecked: 1, prev: 'unreachable' }),
    ).toBe(true)
  })
  it('is false once settled healthy', () => {
    expect(isEffectivelyDown({ status: 'ok', lastChecked: 1 })).toBe(false)
  })
})

describe('ConnectivityProvider', () => {
  beforeEach(() => seedProviders())
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('cold-start sweep marks a dead server unreachable (default fetch rejects)', async () => {
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('unreachable'))
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')
  })

  it('cold-start sweep marks a live server ok and anyDown stays false', async () => {
    stubFetchStatus(200)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('ok'))
    expect(screen.getByTestId('any-down')).toHaveTextContent('no')
  })

  it('a 401 marks the service auth and auth counts as down', async () => {
    stubFetchStatus(401)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('auth'))
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')
  })

  it('a dismissal survives a still-down re-probe but resets on a healthy→down transition', async () => {
    stubFetchStatus(200)
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('ok'))

    // healthy → down (via markUnreachable): banner must be un-dismissed
    act(() => screen.getByText('dismiss').click())
    expect(screen.getByTestId('dismissed')).toHaveTextContent('yes')
    act(() => screen.getByText('mark-down').click())
    expect(screen.getByTestId('dismissed')).toHaveTextContent('no')

    // dismiss while down, re-probe still down: dismissal sticks
    act(() => screen.getByText('dismiss').click())
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('still down'))))
    act(() => screen.getByText('probe').click())
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('unreachable'))
    expect(screen.getByTestId('dismissed')).toHaveTextContent('yes')
  })

  it('a stale entry for a provider that is no longer a target does not keep anyDown true', async () => {
    seedProviders([LOCAL_PROVIDER, SECOND_PROVIDER])
    renderProbe()

    // Cold start with the default rejecting fetch: both targets go down.
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('unreachable'))
    await waitFor(() =>
      expect(screen.getByTestId('openai-status')).toHaveTextContent('unreachable'),
    )
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')

    // Drop openai from the target set: its health entry is pruned outright
    // (not just excluded from the aggregate) so a later re-enable starts
    // unknown rather than instantly "down" with no re-probe.
    act(() => screen.getByText('disable-openai').click())
    expect(screen.getByTestId('openai-status')).toHaveTextContent('none')
    // The remaining target (local) is still down, so anyDown stays yes.
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')

    // Bring local back up: anyDown must clear even though openai was pruned.
    stubFetchStatus(200)
    act(() => screen.getByText('probe').click())
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('ok'))
    expect(screen.getByTestId('openai-status')).toHaveTextContent('none')
    expect(screen.getByTestId('any-down')).toHaveTextContent('no')
  })

  it('a Retry sweep keeps anyDown true and the dot/banner "on" while checking, instead of blinking healthy', async () => {
    // Explicit reject (rather than relying on the setup-file default) since
    // vi.stubGlobal from a prior test in this file isn't unstubbed by
    // afterEach's vi.restoreAllMocks().
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))))
    renderProbe()
    await waitFor(() =>
      expect(screen.getByTestId('local-status')).toHaveTextContent('unreachable'),
    )
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')

    // A slow/never-resolving re-probe: while it's in flight the status is
    // 'checking', but anyDown must stay true (carried via `prev`).
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    act(() => screen.getByText('probe').click())
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('checking'))
    expect(screen.getByTestId('any-down')).toHaveTextContent('yes')
  })

  it('coalesces concurrent Retry clicks into a single sweep (one fetch per target)', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderProbe()
    // The cold-start sweep is now in flight (one fetch issued, unresolved).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // Two synchronous Retry clicks while that sweep is still in flight must
    // not issue any additional fetch calls — they share the one sweep.
    act(() => {
      screen.getByText('probe').click()
      screen.getByText('probe').click()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    act(() => resolveFetch({ status: 200, ok: true } as Response))
    await waitFor(() => expect(screen.getByTestId('local-status')).toHaveTextContent('ok'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
