import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Only the native seam is mocked (the desk polls the vault, and the answers are
// written vault-side). The question store, the desk projection and the note
// renderer are all REAL here — the assertions are about what really lands in
// business/context.md, and when.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  readVaultFile: vi.fn(async () => null as string | null),
  writeVaultNote: vi.fn(
    async (_v: string, rel: string, _content: string) => `/vault/${rel}` as string | null,
  ),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import Desk from './Desk'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { ask, dismissSet, list as listSets, openSet } from '../lib/businessInterview'

function renderDesk() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Desk show="needs" />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** The store is a module singleton — close anything a test left open. */
function clearSets(): void {
  for (const s of listSets()) if (s.status === 'open') dismissSet(s.id, Date.now())
}

let seq = 0
const q = (base: string) => `${base} (${++seq})?`

beforeEach(() => {
  localStorage.clear()
  native.isNative.mockReturnValue(true)
  native.writeVaultNote.mockClear().mockResolvedValue('/vault/business/context.md')
  native.readVaultFile.mockReset().mockResolvedValue(null)
})
afterEach(() => {
  clearSets()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('Desk — the companion asks about the business (Needs you)', () => {
  it('shows the questions as QUESTIONS, one answerable line each, and says nothing is recorded yet', async () => {
    const q1 = q('Who are your biggest clients')
    ask([q1, q('What do you charge')], Date.now())
    renderDesk()

    expect(await screen.findByText('A few questions about your business')).toBeInTheDocument()
    expect(screen.getByText(/2 questions — answer any of them, or dismiss/)).toBeInTheDocument()
    expect(screen.getByLabelText(q1)).toBeInTheDocument()
    expect(screen.getByText(/business\/context.md — that note is all it remembers/)).toBeInTheDocument()
    // Nothing can be saved until he actually types something.
    expect(screen.getByRole('button', { name: 'Save answers' })).toBeDisabled()
  })

  it('writes ONLY the answers the user typed into the vault note, labelled as their own words', async () => {
    const q1 = q('Who are your biggest clients')
    const q2 = q('What do you charge')
    const set = ask([q1, q2], Date.now())!
    renderDesk()
    await screen.findByLabelText(q1)

    fireEvent.change(screen.getByLabelText(q1), { target: { value: 'Two councils.' } })
    // q2 is left BLANK on purpose — it must not appear as an answer anywhere.
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))

    await waitFor(() => {
      expect(
        native.writeVaultNote.mock.calls.some((c) => c[1] === 'business/context.md'),
      ).toBe(true)
    })
    const call = native.writeVaultNote.mock.calls.find((c) => c[1] === 'business/context.md')!
    const body = String(call[2])
    expect(body).toContain('What the user told me (their own words)')
    expect(body).toContain(`**Q:** ${q1}`)
    expect(body).toContain('**A:** Two councils.')
    // The unanswered question is NOT in the note, in any form.
    expect(body).not.toContain(q2)
    // The set is closed, so it stops asking.
    expect(listSets().find((s) => s.id === set.id)!.status).toBe('answered')
    expect(openSet(listSets())).toBeNull()
    expect(await screen.findByText(/Saved 1 answer to business\/context.md/)).toBeInTheDocument()
  })

  it('says plainly when the write FAILED — the answers would exist nowhere', async () => {
    const q1 = q('Who are your biggest clients')
    ask([q1], Date.now())
    native.writeVaultNote.mockResolvedValue(null) // every write fails
    renderDesk()
    await screen.findByLabelText(q1)

    fireEvent.change(screen.getByLabelText(q1), { target: { value: 'Two councils.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))

    expect(await screen.findByText(/your answers were NOT saved/)).toBeInTheDocument()
  })

  it('dismissing takes two taps and is sticky — the row goes and the questions never return', async () => {
    const q1 = q('Who are your biggest clients')
    const set = ask([q1], Date.now())!
    renderDesk()
    await screen.findByLabelText(q1)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByText('Dismiss for good?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, dismiss' }))

    await waitFor(() => {
      expect(screen.queryByLabelText(q1)).not.toBeInTheDocument()
    })
    expect(listSets().find((s) => s.id === set.id)!.status).toBe('dismissed')
    // Nothing about the business was recorded by a dismissal.
    expect(
      native.writeVaultNote.mock.calls.some((c) => c[1] === 'business/context.md'),
    ).toBe(false)
  })
})
