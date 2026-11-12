// ONE SIDEBAR (2026-11-12). The owner, comparing the app with the coworker app
// he uses: "very well organized compared to my software, including the
// sidebar." His reference has ONE sidebar — the places, then the sessions.
// Here Work drew a second 186-point column of rooms beside the app's rail.
// The rooms now live IN the rail on the Work page, and the room itself gets
// that width back for the chat and the pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppShell from '../components/AppShell'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => [],
    listProjectFiles: async () => [],
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderApp(withShell = true) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Routes>
                {withShell ? (
                  <Route element={<AppShell />}>
                    <Route index element={<Workspace />} />
                    <Route path="agents" element={<div>agents page</div>} />
                  </Route>
                ) : (
                  <Route index element={<Workspace />} />
                )}
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function clean() {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
}

describe('Work — the rooms live in the app’s one sidebar', () => {
  const realMatchMedia = window.matchMedia
  beforeEach(() => {
    clean()
    localStorage.setItem(
      'scprism.onboarding',
      JSON.stringify({ completedSteps: ['welcome', 'providers', 'companion', 'vault', 'interview', 'review'], done: true }),
    )
    const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
    updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 1, status: 'done' })
  })
  afterEach(() => {
    window.matchMedia = realMatchMedia
    clean()
  })

  it('on the Work page the rail lists the rooms, under the places', async () => {
    renderApp()
    await settle()
    const rail = document.querySelector('nav.rail') as HTMLElement
    const rooms = within(rail).getByRole('navigation', { name: 'Chats and projects' })
    expect(within(rooms).getByRole('button', { name: /Manager/ })).toBeInTheDocument()
    expect(within(rooms).getByRole('button', { name: /hello crew/ })).toBeInTheDocument()
    // …and the room itself no longer draws a second column of them.
    expect(document.querySelector('.ws__main .ws__nav')).toBeNull()
  })

  it('a room in the rail still says its state in words, not by colour alone', async () => {
    renderApp()
    await settle()
    const rail = document.querySelector('nav.rail') as HTMLElement
    const room = within(rail).getByRole('button', { name: /hello crew/ })
    // The rail draws the state as a small mark so the NAME has the width —
    // but the word is still there to be read, and on hover.
    expect(room).toHaveAccessibleName(/done/i)
    expect(room.querySelector('.proj__status')).toHaveAttribute('title', 'done')
  })

  it('picking a room from the rail opens it', async () => {
    renderApp()
    await settle()
    const rail = document.querySelector('nav.rail') as HTMLElement
    fireEvent.click(within(rail).getByRole('button', { name: /hello crew/ }))
    await settle()
    expect(screen.getByRole('heading', { level: 1, name: 'hello crew' })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: /hello crew/ })).toHaveClass('is-active')
  })

  it('leaving Work takes the rooms out of the rail — they belong to Work', async () => {
    renderApp()
    await settle()
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }))
    await settle()
    const rail = document.querySelector('nav.rail') as HTMLElement
    expect(within(rail).queryByRole('navigation', { name: 'Chats and projects' })).toBeNull()
    expect(within(rail).queryByRole('button', { name: /hello crew/ })).toBeNull()
  })

  it('in the icon rail there is no room for them: the Rooms menu stays', async () => {
    window.matchMedia = ((q: string) =>
      ({
        matches: /max-width:\s*(820|1180)px/.test(q),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    renderApp()
    await settle()
    const rail = document.querySelector('nav.rail') as HTMLElement
    expect(within(rail).queryByRole('button', { name: /hello crew/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Rooms/ })).toBeInTheDocument()
  })

  it('without the app shell the room list still renders in the room', async () => {
    renderApp(false)
    await settle()
    expect(document.querySelector('.ws__main .ws__nav')).not.toBeNull()
  })
})
