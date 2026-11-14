import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Skills from './Skills'
import { SettingsProvider } from '../lib/settings'
import { AppProvider } from '../store/AppStore'
import { ConnectivityProvider } from '../lib/connectivity'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '', isNative: () => false }
})

// A page that throws on render navigates to nothing — the router changes the
// URL and React keeps the last good tree, so the app looks frozen rather than
// broken. That is exactly what a background click on "Skills" looked like
// after the Tools section landed, so this test exists to catch it directly.
describe('the Skills page renders', () => {
  it('mounts without throwing', () => {
    render(
      <MemoryRouter initialEntries={['/skills']}>
        <SettingsProvider>
          <ConnectivityProvider>
            <AppProvider>
            <Skills />
          </AppProvider>
          </ConnectivityProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText(/library/i)).toBeInTheDocument()
  })

  it('shows the tools section even with no tools', () => {
    render(
      <MemoryRouter initialEntries={['/skills']}>
        <SettingsProvider>
          <ConnectivityProvider>
            <AppProvider>
            <Skills />
          </AppProvider>
          </ConnectivityProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText(/tools your crew built/i)).toBeInTheDocument()
    expect(screen.getByText(/none yet/i)).toBeInTheDocument()
  })

  // Seen in the installed app, 2026-11-14 (the once-only pass): every skill
  // card carried the chip "portable markdown — usable by any agent runtime" —
  // one sentence, four times over, on a page whose detail panel says the same
  // thing again. The chip is a word; the sentence is its hover.
  it('a portable skill says "portable" once per card, and the sentence is its hover', () => {
    render(
      <MemoryRouter initialEntries={['/skills']}>
        <SettingsProvider>
          <ConnectivityProvider>
            <AppProvider>
              <Skills />
            </AppProvider>
          </ConnectivityProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    const chips = [...document.querySelectorAll('.skill-card .portable')]
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(['portable', 'this app only']).toContain(chip.textContent)
      expect(chip.getAttribute('title') ?? '').toMatch(/any agent runtime|only this app/)
    }
    expect(document.querySelectorAll('.skill-card').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/portable markdown — usable by any agent runtime.*portable markdown — usable by any agent runtime/s)
  })
})
