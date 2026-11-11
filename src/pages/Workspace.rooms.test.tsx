import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// BELOW 820px THE ROOM LIST IS A MENU (clear-room spec 2026-11-09 §C). The app
// rail is icons there and the Work page's own list of chats and projects took
// a fixed column out of a window that has none to spare. Narrow, the list
// folds into a "Rooms" button beside the room's name and opens over the page;
// picking a room closes it. Wider, nothing changes.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    listProjectFiles: async () => [],
    expandUserPath: async (p: string) => p,
    resolveVaultDir: async () => '',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    listVaultTree: async () => [],
    readVaultFile: async () => null,
    writeVaultNote: async () => null,
  }
})
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { addProject, updateProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

const realMatchMedia = window.matchMedia
function pretendWidth(px: number) {
  window.matchMedia = ((q: string) => {
    const m = /max-width:\s*(\d+)px/.exec(q)
    return {
      matches: m ? px <= Number(m[1]) : false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
}

function seed() {
  const a = addProject('Room Alpha', 'first', '', '/tmp/room-alpha')
  const b = addProject('Room Beta', 'second', '', '/tmp/room-beta')
  updateProject(a.id, { status: 'planned', plan: ['one'] })
  updateProject(b.id, { status: 'planned', plan: ['one'] })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [a.id]: [], [b.id]: [] },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      activeProjectId: a.id,
    }),
  )
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('the room list in a narrow window', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.matchMedia = realMatchMedia
    localStorage.clear()
  })

  it('at 800px the list folds into a Rooms button, opens over the page, and closes when a room is picked', async () => {
    pretendWidth(800)
    seed()
    renderWorkspace()
    const rooms = await screen.findByRole('button', { name: /^Rooms/ })
    expect(rooms).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('navigation', { name: /chats and projects/i })).toBeNull()

    fireEvent.click(rooms)
    const nav = screen.getByRole('navigation', { name: /chats and projects/i })
    expect(nav.className).toMatch(/ws__nav--menu/)
    fireEvent.click(within(nav).getByRole('button', { name: /room beta/i }))

    // Picked: the menu is gone and the page is Room Beta's.
    expect(screen.queryByRole('navigation', { name: /chats and projects/i })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Room Beta')
  })

  it('at 1000px the list is the column it always was, with no Rooms button', async () => {
    pretendWidth(1000)
    seed()
    renderWorkspace()
    expect(await screen.findByRole('navigation', { name: /chats and projects/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Rooms/ })).toBeNull()
  })
})
