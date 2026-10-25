import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mid-run BLOCKING approval — a run PAUSED RIGHT NOW at a held tool call,
// waiting for a live Approve/Deny. We mock only the native seam of nativeEngine
// (isNative / resolveVaultDir / readSpansTail / readMcpApprovals /
// readPendingApprovals / decideApproval) and keep the desk's pure projection
// (buildDeskItems) real, so the pending-request → live-approval item mapping,
// the decision write, and the optimistic removal are all exercised for real.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  decideApproval: vi.fn(async () => true),
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

import Desk, { resetDeskDecisionSets } from './Desk'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import type { PendingApproval } from '../lib/nativeEngine'

// A real pending request the engine wrote (approvals/pending/<id>.json). `at` is
// REAL epoch SECONDS (~2 minutes ago) — the desk converts to ms (at * 1000) so
// the relative time reads as "2m ago", never a huge day count.
const pendingReq: PendingApproval = {
  id: 'req-abc',
  run_id: 'run-1',
  server: 'fs',
  tool: 'write_file',
  args_summary: '{"path":"/tmp/x"}',
  at: Math.floor(Date.now() / 1000) - 120,
}

const PAUSED = /Build paused — fs · write_file needs your approval to run/

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

describe('Desk — mid-run blocking approval (a paused run in Needs you)', () => {
  beforeEach(() => {
    localStorage.clear()
    // The decision sets are module-level (shared across the page's Desk
    // instances) — a dismissal from one scenario must not hide the next one's row.
    resetDeskDecisionSets()
    native.isNative.mockReturnValue(true)
    native.resolveVaultDir.mockResolvedValue('/vault')
    native.readSpansTail.mockResolvedValue([])
    native.readMcpApprovals.mockReset().mockResolvedValue({ require: [], granted: [] })
    native.readPendingApprovals.mockReset().mockResolvedValue([pendingReq])
    native.decideApproval.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('surfaces a real pending request as an honest live-approval item with a SANE relative time', async () => {
    renderDesk()
    const title = await screen.findByText(PAUSED)
    expect(title).toHaveClass('desk__rowtitle')
    // the trimmed args_summary is the detail
    expect(screen.getByText(/\{"path":"\/tmp\/x"\}/)).toBeInTheDocument()
    // Approve (primary) + Deny (secondary) — honest live-decision affordances.
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
    // at is epoch SECONDS ~120s ago → converted to ms → "2m ago", not a day count.
    expect(await screen.findByText(/2m ago/)).toBeInTheDocument()
    expect(screen.queryByText(/\d+d ago/)).not.toBeInTheDocument()
  })

  it('Approve writes the decision "allow" for that id and optimistically removes the row', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(native.decideApproval).toHaveBeenCalledWith('/vault', 'req-abc', 'allow'))
    await waitFor(() => expect(screen.queryByText(PAUSED)).not.toBeInTheDocument())
  })

  it('Deny writes the decision "deny" for that id and removes the row', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(native.decideApproval).toHaveBeenCalledWith('/vault', 'req-abc', 'deny'))
    await waitFor(() => expect(screen.queryByText(PAUSED)).not.toBeInTheDocument())
  })

  it('a failed decision write restores the row and says so honestly (no ghost, no false resolve)', async () => {
    native.decideApproval.mockResolvedValue(false)
    renderDesk()
    await screen.findByText(PAUSED)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    // honest error; the run is still paused, so the row comes back
    expect(await screen.findByText(/couldn't send your decision/i)).toBeInTheDocument()
    expect(await screen.findByText(PAUSED)).toBeInTheDocument()
  })

  it('shows no live-approval item when nothing is pending', async () => {
    native.readPendingApprovals.mockResolvedValue([])
    renderDesk()
    await waitFor(() => expect(native.readPendingApprovals).toHaveBeenCalled())
    expect(screen.queryByText(PAUSED)).not.toBeInTheDocument()
  })

  it('non-native (browser): never reads pending, no item, no crash', async () => {
    native.isNative.mockReturnValue(false)
    renderDesk()
    // the desk's native poll is gated on isNative → it returns before any read
    expect(screen.queryByText(PAUSED)).not.toBeInTheDocument()
    expect(native.readPendingApprovals).not.toHaveBeenCalled()
  })
})
