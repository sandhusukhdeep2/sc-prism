import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import FloatingPulse from './FloatingPulse'
import { SettingsProvider, DEFAULT_SETTINGS, type Settings } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider } from '../store/AppStore'
import {
  COMPANION_MANAGER_ID,
  ensureSeeded,
  recordManagerBeat,
  updateHeartbeat,
} from '../lib/managers'
import type { InterviewState } from '../lib/interview'

// The orb is a native surface (the heartbeat driver only exists there) —
// force native and leave storeGet PENDING so SettingsProvider never flips
// `hydrated` (no connectivity cold-probe), mirroring AppStore.timeoutHonesty.
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
  }
})

const interview: InterviewState = {
  business: 'Finance practice',
  companyName: 'Sukh',
  website: '',
  departments: ['operations'],
  teamSize: '20+ people',
  budget: '$1k+/mo',
  sensitiveWords: [],
  verifyCommand: '',
  compliance: [],
  roles: [],
  priorities: [],
  signoffs: [],
  neverTouch: [],
  adaptive: [],
}

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, enabled: p.id === 'local' })),
}

function renderPulse() {
  return render(
    <SettingsProvider>
      <ConnectivityProvider>
        <AppProvider>
          <FloatingPulse />
        </AppProvider>
      </ConnectivityProvider>
    </SettingsProvider>,
  )
}

const orb = () => screen.getByRole('button', { name: /heartbeat/ })

// NOTE: the managers store is a module singleton, so these tests build on
// each other in order: empty store first, then seed + beat, then pause.
describe('FloatingPulse', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('idle + no heartbeat: NO pulse class, and the popover shows the honest off line', () => {
    renderPulse()
    // heartbeatLive is null → the animation-gating class must be absent.
    expect(orb().className).not.toContain('is-live')
    fireEvent.click(orb())
    expect(
      screen.getByText('resting — heartbeat off · enable on the Agents page'),
    ).toBeInTheDocument()
    // A never-enabled heartbeat offers no orb toggle — first enable is the
    // Agents card's explicit consent.
    expect(screen.queryByText(/resume heartbeat/)).not.toBeInTheDocument()
  })

  it('enabled: the popover shows the REAL last beat line + the resting/next-check line', () => {
    ensureSeeded(settings, interview)
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    recordManagerBeat(COMPANION_MANAGER_ID, {
      at: Date.now() - 2 * 60_000,
      action: 'worked',
      line: 'tidied the vault index',
      ok: true,
      tokens: 123,
    })
    renderPulse()
    expect(orb().className).not.toContain('is-live') // still no live run
    fireEvent.click(orb())
    // The headline carries the REAL beat record, not invented status.
    expect(screen.getByText(/resting — next check .* · last: tidied the vault index/)).toBeInTheDocument()
    // The beat log row too (glyph ✓ = worked).
    expect(screen.getByText('tidied the vault index')).toBeInTheDocument()
    expect(screen.getByText('✓')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pause heartbeat' })).toBeInTheDocument()
  })

  it('pausing writes heartbeat.enabled and the popover flips to the honest off line', () => {
    renderPulse()
    fireEvent.click(orb())
    fireEvent.click(screen.getByRole('button', { name: 'pause heartbeat' }))
    expect(
      screen.getByText('resting — heartbeat off · enable on the Agents page'),
    ).toBeInTheDocument()
    // Beats exist (consent already happened once) → resume stays available.
    expect(screen.getByRole('button', { name: 'resume heartbeat' })).toBeInTheDocument()
  })

  it('an OVERDUE beat shows the honest engine-wait line, never "due now"', () => {
    // Resume (the enable transition stamps lastBeat = now), then record a
    // beat three hours in the past — past the 2h default cadence, so the next
    // beat is overdue. The driver fires a due beat within one 30s tick whenever the
    // engine is free, so a beat that STAYS overdue is honestly queued behind
    // a busy/user-parked engine — not perpetually "due now".
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    recordManagerBeat(COMPANION_MANAGER_ID, {
      at: Date.now() - 3 * 60 * 60_000,
      action: 'rested',
      line: 'quiet hour',
      ok: true,
      tokens: 0,
    })
    renderPulse()
    fireEvent.click(orb())
    expect(
      screen.getByText(/resting — waiting for a free engine slot · last: quiet hour/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/due now/)).not.toBeInTheDocument()
  })

  // --- "Wake now" (2026-08-05 spec §Part 3) ---
  // The orb gets the same immediate-beat button the Agents card has. The orb's
  // oldest law is unchanged and re-pinned here: offering a wake is not a wake,
  // so nothing animates until a run is genuinely live.

  it('offers Wake now on the popover — live, with no excuse line, when a wake can run', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    renderPulse()
    const o = orb() // captured before the popover adds its own buttons
    fireEvent.click(o)
    const btn = screen.getByRole('button', { name: 'Wake now' })
    expect(btn).toBeEnabled()
    expect(screen.queryByText(/can’t wake now/)).not.toBeInTheDocument()
    // Offering a wake is NOT a wake: the orb is still static.
    expect(o.className).not.toContain('is-live')
  })

  it('an OFF heartbeat disables Wake now and SAYS why — never a dead button', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: false })
    renderPulse()
    const o = orb()
    fireEvent.click(o)
    const btn = screen.getByRole('button', { name: 'Wake now' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'heartbeat is off — turn it on first')
    expect(
      screen.getByText('can’t wake now — heartbeat is off — turn it on first'),
    ).toBeInTheDocument()
    expect(o.className).not.toContain('is-live')
  })
})
