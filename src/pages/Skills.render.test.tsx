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
})
