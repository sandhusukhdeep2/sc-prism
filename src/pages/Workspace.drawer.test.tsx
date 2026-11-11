import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE DETAILS DRAWER READS (clear-room spec, 2026-11-09 §A5). His screenshot
// of the right-hand panel: the description, the team line, the loops, the
// plan and the last result were one wall of monospace, with two large black
// buttons in the middle and the raw markdown of the last result at the end.
// Prose is body type; mono is for paths and numbers; the last result renders
// as markdown and is clamped; one delete, small, at the very end.
const native = vi.hoisted(() => ({
  revealPath: vi.fn(async () => true),
  pickFolder: vi.fn(async () => null),
  listProjectFiles: vi.fn(async () => []),
}))
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    revealPath: native.revealPath,
    pickFolder: native.pickFolder,
    listProjectFiles: native.listProjectFiles,
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

const LONG_NOTE = [
  '# Hello crew',
  '',
  'The file on disk is already the corrected version.',
  '- Operations keeps the work moving.',
  '- Sales brings the work in.',
  '- Finance keeps the numbers honest.',
  'Line six of the result.',
  'Line seven of the result.',
].join('\n')

function seed() {
  const project = addProject('Drawer Target', 'A one-file demo: hello.md greeting the crew. Capability check only.', '', '/tmp/drawer-target')
  updateProject(project.id, { status: 'done', plan: ['step one'], lastNote: LONG_NOTE })
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [], [project.id]: [] },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      activeProjectId: project.id,
    }),
  )
  return project
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

const drawer = () => document.querySelector('.ws__side--project') as HTMLElement

describe('the Details drawer reads', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('sets the description and the team line in body type, not monospace', async () => {
    seed()
    renderWorkspace()
    const goal = await screen.findByText(/A one-file demo: hello\.md greeting the crew/)
    expect(goal.className).not.toMatch(/\bmono\b/)
    const team = await screen.findByText(/Default team/)
    expect(team.className).not.toMatch(/\bmono\b/)
  })

  it('renders the last result as markdown, clamped, with a way to see all of it', async () => {
    seed()
    renderWorkspace()
    const d = drawer()
    expect(d).toBeTruthy()
    // A heading, not a '# Hello crew' literal.
    expect(within(d).getByText('Hello crew').className).toMatch(/md__h/)
    expect(within(d).queryByText(/^# Hello crew/)).toBeNull()
    const more = within(d).getByRole('button', { name: /show all/i })
    const body = more.closest('.proj__lastresult') as HTMLElement
    expect(body.className).toMatch(/is-clamped/)
    fireEvent.click(more)
    expect(body.className).not.toMatch(/is-clamped/)
    expect(within(d).getByRole('button', { name: /show less/i })).toBeInTheDocument()
  })

  it('offers Reveal folder as a quiet action and exactly one Delete, small, at the end', async () => {
    seed()
    renderWorkspace()
    const d = drawer()
    const reveal = await within(d).findByRole('button', { name: /reveal folder/i })
    expect(reveal.className).not.toMatch(/proj__startbtn/)
    const deletes = within(d).queryAllByRole('button', { name: /delete/i })
    expect(deletes).toHaveLength(1)
    const buttons = within(d).getAllByRole('button')
    expect(buttons[buttons.length - 1]).toBe(deletes[0])
  })
})

// BELOW 1180px THE DRAWER STARTS CLOSED (clear-room spec 2026-11-09 §A5/§C).
// Seen at 1000×760 idle: the 340px drawer stayed open and the chat was a
// 280px column with its tabs wrapping. Narrow, the room gives the chat the
// width and `details ▸` opens the drawer over it on demand.
describe('the drawer and the window width', () => {
  const realMatchMedia = window.matchMedia
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.matchMedia = realMatchMedia
    localStorage.clear()
  })
  function pretendNarrow() {
    window.matchMedia = ((q: string) =>
      ({
        matches: /max-width:\s*1180px/.test(q),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia
  }
  it('starts closed in a narrow window and opens from details', async () => {
    pretendNarrow()
    seed()
    renderWorkspace()
    await screen.findByRole('button', { name: /details ▸/ })
    expect(document.querySelector('.ws__side--project')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /details ▸/ }))
    expect(document.querySelector('.ws__side--project')).not.toBeNull()
  })
})
