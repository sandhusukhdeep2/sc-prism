import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../lib/settings'
import type { ConnectivityValue, ServiceHealth } from '../lib/connectivity'
import ConnectivityDot from './ConnectivityDot'

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

const conn = (health: Record<string, ServiceHealth>): ConnectivityValue => ({
  health,
  anyDown: Object.values(health).some((h) => h.status === 'auth' || h.status === 'unreachable'),
  primaryDown: false,
  bannerDismissed: false,
  dismissBanner: vi.fn(),
  probeAll: vi.fn(async () => {}),
  probeOne: vi.fn(async () => 'ok' as const),
  markUnreachable: vi.fn(),
})

const renderDot = (health: Record<string, ServiceHealth>) =>
  render(
    <MemoryRouter>
      <SettingsProvider>
        <ConnectivityDot conn={conn(health)} />
      </SettingsProvider>
    </MemoryRouter>,
  )

describe('ConnectivityDot', () => {
  beforeEach(() => seedProviders())
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('renders nothing when everything is healthy', () => {
    renderDot({ local: { status: 'ok', lastChecked: 1 } })
    expect(screen.queryByTestId('conn-dot')).not.toBeInTheDocument()
  })

  it('shows a danger dot named after the unreachable service', () => {
    renderDot({ local: { status: 'unreachable', lastChecked: 1 } })
    const dot = screen.getByTestId('conn-dot')
    expect(dot).toHaveTextContent('Local model')
    expect(dot.querySelector('.dot--danger')).not.toBeNull()
  })

  it('shows a warn dot when the worst state is auth', () => {
    renderDot({ local: { status: 'auth', lastChecked: 1 } })
    expect(screen.getByTestId('conn-dot').querySelector('.dot--warn')).not.toBeNull()
  })

  it('ignores stale health entries for services that are no longer probe targets', () => {
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
            baseUrl: 'https://api.openai.com',
            apiKey: '',
            enabled: false,
            primary: false,
            connected: false,
          },
        ],
      }),
    )
    // Both ids are down in health — but 'openai' is a stale entry for a service
    // the user has since turned off (the fixture's anyDown derives from health,
    // so it is still true). Only the current probe target should be named.
    renderDot({
      local: { status: 'unreachable', lastChecked: 1 },
      openai: { status: 'unreachable', lastChecked: 1 },
    })
    const dot = screen.getByTestId('conn-dot')
    expect(dot).toHaveTextContent('Local model')
    expect(dot).not.toHaveTextContent('2 AIs down')
    expect(dot.getAttribute('title')).not.toContain('OpenAI')
  })
})
