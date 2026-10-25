import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// H1 — the desk's held-tool span read is deduped across the concurrent
// useDeskState instances that mount together (the Workspace header status line,
// the always-visible <Desk show="needs">, and the expandable <Desk show="rest">).
// Before the fix each instance polled the same vault span tail (+ approval
// policy) independently — 2-3× the I/O every ~4s. We mock only the native seam
// and assert that mounting TWO consumers triggers exactly ONE underlying
// readSpansTail / readMcpApprovals within a tick (the reads share one in-flight
// promise), while each instance still gets its own state (no behavior change).
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

// Two desk consumers mounted together — the real Workspace pairing of
// <Desk show="needs"> + <Desk show="rest"> (each runs its own useDeskState).
function renderTwoDesks() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Desk show="needs" />
              <Desk show="rest" />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Desk — held-tool span read is deduped across concurrent instances (H1)', () => {
  beforeEach(() => {
    localStorage.clear()
    native.isNative.mockReturnValue(true)
    native.resolveVaultDir.mockClear().mockResolvedValue('/vault')
    native.readSpansTail.mockClear().mockResolvedValue([])
    native.readMcpApprovals.mockClear().mockResolvedValue({ require: [], granted: [] })
  })
  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('mounting two consumers reads the span tail + approval policy ONCE, not per-instance', async () => {
    renderTwoDesks()
    // The two mount-time fetches share one in-flight read — wait until it lands…
    await waitFor(() => expect(native.readSpansTail).toHaveBeenCalled())
    // …then prove it happened a single time (2 instances → 1 read, not 2).
    expect(native.readSpansTail).toHaveBeenCalledTimes(1)
    expect(native.readMcpApprovals).toHaveBeenCalledTimes(1)
  })
})
