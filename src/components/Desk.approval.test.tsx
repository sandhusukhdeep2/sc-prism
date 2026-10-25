import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The tool-approval flow reads real held spans off the vault span tail and
// grants a tool for the NEXT run. We mock only the native seam of nativeEngine
// (isNative / resolveVaultDir / readSpansTail / readMcpApprovals /
// grantToolApproval) and keep the PURE readHeldToolCalls/dropAlreadyGranted
// real, so the span → item mapping (and the granted cross-check) is exercised
// for real.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  grantToolApproval: vi.fn(async () => true),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})
// The provider tree runs in "native" mode here (isNative mocked true); neutralize
// any stray bridge / path call so nothing reaches a real IPC.
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
import type { EngineSpan } from '../lib/nativeEngine'

// P9: the row now LEADS with the tool identity (server · tool) as its title;
// the "held for your approval" status phrase moved to the secondary detail line.
// LABEL tracks that sub-line — its presence still means "a held item surfaced".
const LABEL = 'held for your approval'

// A real held tool_exec span, shaped exactly like approval.py's ApprovalGate
// emits (held=true, no egress; the generic "held:" reason must NOT leak into
// the detail — readHeldToolCalls drops it). `start` is a REAL epoch-SECONDS
// value (time.time(), 2 minutes ago) — not already-ms — so the F1 fix (at =
// start * 1000) is actually exercised: a ms-fabricated fixture would mask the
// bug (it did, before the fix).
const heldSpan: EngineSpan = {
  name: 'tool_exec',
  type: 'tool_exec',
  status: 'error',
  start: Math.floor(Date.now() / 1000) - 120,
  attrs: { provider: 'mcp', server: 'echo', tool: 'add', held: true, reason: 'held: tool needs approval — not run' },
}

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

describe('Desk — held MCP tool approval (Needs you)', () => {
  beforeEach(() => {
    localStorage.clear()
    // The decision sets are module-level (shared across the page's Desk
    // instances) — a dismissal from one scenario must not hide the next one's row.
    resetDeskDecisionSets()
    native.isNative.mockReturnValue(true)
    native.resolveVaultDir.mockResolvedValue('/vault')
    native.readSpansTail.mockResolvedValue([heldSpan])
    // Default policy: nothing granted yet, so the held span above still needs
    // approval — most tests want the item to surface. F2 tests below override
    // this per-case to prove an already-granted tool is filtered out.
    native.readMcpApprovals.mockReset().mockResolvedValue({ require: [], granted: [] })
    native.grantToolApproval.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('surfaces a real held span as an honest tool-approval item (server · tool, no boilerplate reason) with a SANE relative time', async () => {
    renderDesk()
    expect(await screen.findByText(LABEL)).toBeInTheDocument()
    // P9: the tool identity is the HEADLINE, and the status phrase is the sub-line.
    expect(screen.getByText('echo · add')).toHaveClass('desk__rowtitle')
    expect(screen.getByText(LABEL)).toHaveClass('desk__rowdetail')
    // the engine's generic "held:" reason must not surface as a why
    expect(screen.queryByText(/needs approval — not run/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
    // F1: heldSpan.start is real epoch SECONDS, ~120s ago — the rendered "when"
    // must read as a sane recent time ("2m ago"), never a huge day count (the
    // pre-fix bug: comparing seconds to Date.now()'s ms read as ~20000+ days ago).
    expect(await screen.findByText(/2m ago/)).toBeInTheDocument()
    expect(screen.queryByText(/\d+d ago/)).not.toBeInTheDocument()
  })

  it('Approve grants the tool BY NAME for the next run, removes the row, and confirms honestly', async () => {
    renderDesk()
    await screen.findByText(LABEL)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    // grants the tool NAME (what the engine matches), against the resolved vault
    await waitFor(() => expect(native.grantToolApproval).toHaveBeenCalledWith('/vault', 'add'))
    // honest copy: NEXT run, never "the tool ran"
    expect(await screen.findByText(/will be allowed on your next run/i)).toBeInTheDocument()
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument()
  })

  it('Dismiss removes the row locally without granting anything (tool stays held)', async () => {
    renderDesk()
    await screen.findByText(LABEL)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryByText(LABEL)).not.toBeInTheDocument())
    expect(native.grantToolApproval).not.toHaveBeenCalled()
  })

  it('shows no tool-approval item when nothing was held', async () => {
    native.readSpansTail.mockResolvedValue([])
    renderDesk()
    await waitFor(() => expect(native.readSpansTail).toHaveBeenCalled())
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument()
  })

  it('non-native (browser): never reads spans, no item, no crash', async () => {
    native.isNative.mockReturnValue(false)
    renderDesk()
    // the effect is gated on isNative → it returns before touching the span tail
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument()
    expect(native.readSpansTail).not.toHaveBeenCalled()
  })

  // F2 — honesty: a tool already granted (in <vault>/mcp-approvals.json) must
  // NOT re-surface as "held for your approval" — it would not actually be held
  // on the next run. This matters because `dismissed` is session-local and
  // resets on a Desk remount, so without a live cross-check an approved tool
  // would look held again after any reload.
  describe('cross-checks the CURRENT granted policy (an already-approved tool is not "held")', () => {
    it('tool already granted BY TOOL NAME → no desk item, even though a held span exists', async () => {
      native.readMcpApprovals.mockResolvedValue({ require: [], granted: ['add'] })
      renderDesk()
      await waitFor(() => expect(native.readMcpApprovals).toHaveBeenCalled())
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument()
    })

    it('tool already granted BY SERVER NAME → no desk item', async () => {
      native.readMcpApprovals.mockResolvedValue({ require: [], granted: ['echo'] })
      renderDesk()
      await waitFor(() => expect(native.readMcpApprovals).toHaveBeenCalled())
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument()
    })

    it('tool NOT in granted still surfaces as a desk item (it genuinely still needs approval)', async () => {
      native.readMcpApprovals.mockResolvedValue({ require: [], granted: ['some-other-tool'] })
      renderDesk()
      expect(await screen.findByText(LABEL)).toBeInTheDocument()
    })
  })
})
