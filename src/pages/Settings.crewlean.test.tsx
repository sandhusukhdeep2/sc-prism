import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// Sukhdeep, 2026-08-31: "What about the dependency? If user want to run all the
// agent on local only. And if he want to depend a little bit on a cloud more in
// a Gemini and local. And what about if he want to do something that totally on
// a cloud?" — the dial only biases ROUTING for a chat send. This card is the
// other half: it moves every SEAT in the crew, in one click, and never promises
// a brand the user has not actually connected.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function seedCrew() {
  localStorage.setItem(
    'scprism.agents',
    JSON.stringify([
      { id: 'a1', name: 'Researcher', model: 'claude', enabled: true, charter: '' },
      { id: 'a2', name: 'Archivist', model: 'claude', enabled: true, charter: '' },
    ]),
  )
}

describe('crew lean presets — all local / balanced / all cloud', () => {
  beforeEach(() => {
    localStorage.clear()
    seedCrew()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('says so plainly when no AI is connected at all', () => {
    // Replaced 2026-09-03: the row used to offer a generic "All cloud" button
    // that silently meant whichever cloud it found first, so Gemini could
    // never be chosen. There is now one button per AI the user actually has —
    // see Settings.ais.test.tsx — and with none connected there is nothing to
    // offer, so the card says that instead of showing dead controls.
    renderSettings()
    expect(screen.getByText(/no ai connected yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^all cloud$/i })).not.toBeInTheDocument()
  })

  it('moves every seat to local when a local model is connected', () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        providers: [
          { id: 'local', name: 'Local', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        ],
      }),
    )
    renderSettings()
    const btn = screen.getByRole('button', { name: /all local/i })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    // Every ENABLED seat moves; a seat the user switched off is left alone.
    const agents = JSON.parse(localStorage.getItem('scprism.agents') ?? '[]') as {
      name: string
      model: string
      enabled: boolean
    }[]
    const on = agents.filter((a) => a.enabled)
    expect(on.length).toBeGreaterThan(1)
    expect(on.every((a) => a.model === 'local')).toBe(true)
  })
})
