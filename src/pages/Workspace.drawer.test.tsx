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

// The project's details live in the room's pane (2026-11-12): the Details tab
// beside the chat. Since 2026-11-14 ("Visible agents") a quiet project room
// is its Team board and its chat, and Details opens on request — by itself
// only for a project that is waiting on the user (lib/roomPane.ts).
const drawer = () => document.querySelector('.pane .ws__details') as HTMLElement

/** Mount the room and open its Details beside the chat, as a user would. */
async function renderWithDetails() {
  const view = renderWorkspace()
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  return view
}

describe('the Details drawer reads', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('sets the description and the sections’ sentences in body type, not monospace', async () => {
    seed()
    await renderWithDetails()
    const goal = await screen.findByText(/A one-file demo: hello\.md greeting the crew/)
    expect(goal.className).not.toMatch(/\bmono\b/)
    fireEvent.click(await screen.findByRole('button', { name: /^Team/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Loops/ }))
    // Every explanatory sentence in the sidebar is a sentence, not code.
    for (const re of [/Default team/, /the enabled system agents run this build/, /standing build\/test loops for this project/]) {
      expect((await screen.findByText(re)).className, String(re)).not.toMatch(/\bmono\b/)
    }
  })

  it('renders the last result as markdown, clamped, with a way to see all of it', async () => {
    seed()
    await renderWithDetails()
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
    await renderWithDetails()
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
// width and the `Details` button opens the pane over it on demand.
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
    const details = await screen.findByRole('button', { name: 'Details' })
    expect(document.querySelector('.pane')).toBeNull()
    fireEvent.click(details)
    expect(document.querySelector('.pane .ws__details')).not.toBeNull()
    // …over the chat: nothing is squeezed into two unreadable halves.
    expect(document.querySelector('.ws__main')).toHaveClass('ws__main--paneover')
    // Closing it gives the chat back.
    fireEvent.click(screen.getByRole('button', { name: 'Close the pane' }))
    expect(document.querySelector('.pane')).toBeNull()
    expect(document.querySelector('.ws__main')).not.toHaveClass('ws__main--paneover')
  })
})


// THE SIDEBAR IS ONE-LINE SECTIONS (2026-11-11 — "sidebar is totally
// cluttered"). Each block folds to a line with a summary read from the
// stores; what needs the user stays visible above them; the folder path is
// itself the reveal action; and the duplicate Team block is gone.
describe('the sidebar folds to one-line sections', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('Team and Loops start folded with a summary, and open on a click', async () => {
    seed()
    await renderWithDetails()
    const team = await screen.findByRole('button', { name: /^Team/ })
    const loops = screen.getByRole('button', { name: /^Loops/ })
    expect(team).toHaveAttribute('aria-expanded', 'false')
    expect(loops).toHaveAttribute('aria-expanded', 'false')
    expect(loops.textContent).toMatch(/none|loop/)
    // Folded means not there: nothing of the section's body is rendered.
    expect(screen.queryByText(/standing build\/test loops for this project/)).toBeNull()
    fireEvent.click(loops)
    expect(loops).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/standing build\/test loops for this project/)).toBeInTheDocument()
  })

  it('the Plan is folded once the project is done, and Last result stays open', async () => {
    seed() // status: done
    await renderWithDetails()
    const plan = await screen.findByRole('button', { name: /^Plan/ })
    expect(plan).toHaveAttribute('aria-expanded', 'false')
    expect(plan.textContent).toMatch(/1 step · done/)
    expect(screen.getByRole('button', { name: /^Last result/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('the folder path is the one reveal action, and no second Team block follows', async () => {
    const p = seed()
    await renderWithDetails()
    const reveals = await screen.findAllByRole('button', { name: /reveal folder/i })
    expect(reveals).toHaveLength(1)
    expect(reveals[0].textContent).toContain('/tmp/drawer-target')
    fireEvent.click(reveals[0])
    expect(document.querySelector('.liveact')).toBeNull()
    expect(p.id).toBeTruthy()
  })
})
