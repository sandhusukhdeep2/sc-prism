import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// THE load-bearing test for Telegram two-way (2026-08-11 spec): a decision made
// on the PHONE must produce the SAME artifact a decision made at the DESK
// produces — the engine's blocking broker reads one file and must not be able
// to tell which button was pressed.
//
// So nothing app-side is mocked here. `nativeEngine` is REAL, `Desk` is REAL,
// `telegramApprovals` is REAL; only the Tauri bridge itself is replaced, by a
// router that RECORDS every (command, args) pair. The assertion is on those
// recorded calls — the actual write instruction that crosses into Rust, whose
// exact bytes on disk are pinned by the Rust test
// (`approval_tests::write_then_read_round_trip_and_skips_junk`). Asserting on a
// mock of our own decision function would prove nothing; this proves the wire.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import Desk, { resetDeskDecisionSets } from '../components/Desk'
import { SettingsProvider } from './settings'
import { ConnectivityProvider } from './connectivity'
import { OnboardingProvider } from './onboarding'
import { AppProvider } from '../store/AppStore'
import {
  handleTelegramDecision,
  pumpTelegramApprovals,
  resetTelegramApprovalsForTest,
  telegramRequestIdsForTest,
} from './telegramApprovals'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const CHAT = '424242'
const PAUSED = /Build paused — fs · write_file needs your approval to run/

// One REAL pending request, exactly as the engine's BlockingApprovalBroker
// writes it to <vault>/approvals/pending/<id>.json.
const pendingRow = {
  id: 'req-abc',
  run_id: 'run-1',
  server: 'fs',
  tool: 'write_file',
  args_summary: '{"path":"/tmp/x"}',
  at: Math.floor(Date.now() / 1000) - 30,
}

interface Call {
  cmd: string
  args: unknown
}
let calls: Call[] = []

function writes(): Call[] {
  return calls.filter((c) => c.cmd === 'write_approval_decision')
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

beforeEach(() => {
    resetDeskDecisionSets()
  localStorage.clear()
  resetTelegramApprovalsForTest()
  calls = []
  // Reports ON with real-shaped credentials, so AppStore itself starts the
  // inbound loop — the wiring under test, not a hand-built harness.
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      vaultPath: '/vault',
      telegramBotToken: TOKEN,
      telegramChatId: CHAT,
      telegramReports: true,
    }),
  )
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  invokeMock.mockReset().mockImplementation(async (cmd: string, args: unknown) => {
    calls.push({ cmd, args })
    switch (cmd) {
      case 'read_pending_approvals':
        return [pendingRow]
      case 'read_spans_tail':
        return []
      case 'read_vault_file':
        return null // no mcp-approvals.json → inactive policy
      case 'store_get':
        return null
      case 'telegram_take_decisions':
        return []
      case 'telegram_watch_log':
        return []
      default:
        return undefined
    }
  })
})

afterEach(() => {
  resetTelegramApprovalsForTest()
  localStorage.clear()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.clearAllMocks()
})

describe('one decision path — the phone writes what the desk writes', () => {
  it('a phone Approve issues the byte-identical write instruction a desk Approve issues', async () => {
    renderDesk()
    await screen.findByText(PAUSED)

    // --- the DESK path: a real click on the real button ---
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    const fromDesk = writes()[0]

    // --- the PHONE path: the request the pump announced, tapped ---
    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()
    expect(requestId).toMatch(/^[0-9a-f]{32}$/)
    const reply = await handleTelegramDecision({
      callback_id: 'cb-1',
      request_id: requestId,
      decision: 'allow',
      chat_id: CHAT,
    })
    expect(reply).toBe('Approved — the run is continuing.')
    await waitFor(() => expect(writes()).toHaveLength(2))
    const fromPhone = writes()[1]

    // IDENTICAL: same command, same vault, same id, same decision. There is no
    // "source" field to diverge on because there is no second writer.
    expect(fromPhone).toEqual(fromDesk)
    expect(fromPhone).toEqual({
      cmd: 'write_approval_decision',
      args: { vault: '/vault', id: 'req-abc', decision: 'allow' },
    })
  })

  it('a phone Deny is likewise the desk Deny, verbatim', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    const fromDesk = writes()[0]

    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()
    await handleTelegramDecision({
      callback_id: 'cb-2',
      request_id: requestId,
      decision: 'deny',
      chat_id: CHAT,
    })
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1]).toEqual(fromDesk)
    expect(writes()[1].args).toEqual({ vault: '/vault', id: 'req-abc', decision: 'deny' })
  })

  it('the desk SHOWS a phone decision (source + when) and drops the row it answered', async () => {
    renderDesk()
    await screen.findByText(PAUSED)

    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()
    await handleTelegramDecision({
      callback_id: 'cb-3',
      request_id: requestId,
      decision: 'allow',
      chat_id: CHAT,
    })

    // The app never silently disagrees with the phone: it names the source…
    expect(await screen.findByText('Approved from Telegram — fs · write_file')).toBeInTheDocument()
    // …and the row it answered is gone, because it really was decided.
    await waitFor(() => expect(screen.queryByText(PAUSED)).not.toBeInTheDocument())
  })

  it('a tap that landed after the timeout says so on BOTH sides, and writes nothing', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()

    // The engine's bound elapsed: it resumed unapproved and removed the file.
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'read_pending_approvals') return []
      if (cmd === 'read_spans_tail') return []
      return null
    })

    const reply = await handleTelegramDecision({
      callback_id: 'cb-4',
      request_id: requestId,
      decision: 'allow',
      chat_id: CHAT,
    })
    // The phone is told the truth…
    expect(reply).toBe('That request already timed out — nothing was decided.')
    // …the desk says the same thing…
    expect(
      await screen.findByText(
        'A Telegram tap for fs · write_file arrived after it timed out — nothing was decided',
      ),
    ).toBeInTheDocument()
    // …and NOTHING was written.
    expect(writes()).toHaveLength(0)
  })

  it('a tap from a stranger reaches no writer at all', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()

    const reply = await handleTelegramDecision({
      callback_id: 'cb-5',
      request_id: requestId,
      decision: 'allow',
      chat_id: '999999',
    })
    expect(reply).toBe('')
    expect(writes()).toHaveLength(0)
    // Not even an answer goes back — silence, so the bot leaks nothing.
    expect(calls.some((c) => c.cmd === 'telegram_answer_callback')).toBe(false)
    // The paused run is still on the desk, still needing a real decision.
    expect(screen.getByText(PAUSED)).toBeInTheDocument()
  })
})

describe('token custody across the whole two-way surface', () => {
  it('the token crosses into Rust ONCE (the watch handoff) and appears in nothing else the webview holds', async () => {
    renderDesk()
    await screen.findByText(PAUSED)
    await pumpTelegramApprovals()
    const [requestId] = telegramRequestIdsForTest()
    await handleTelegramDecision({
      callback_id: 'cb-6',
      request_id: requestId,
      decision: 'allow',
      chat_id: CHAT,
    })

    // The inbound loop is started with the token — deliberately, once, into
    // native custody.
    const started = calls.filter((c) => c.cmd === 'telegram_watch_start')
    expect(started.length).toBeGreaterThan(0)
    expect(JSON.stringify(started[0].args)).toContain(TOKEN)

    // Every OTHER command this feature introduces carries no token: the native
    // side already has it, so the webview is never asked to hand it back.
    // (`send_telegram` is the pre-existing one-way notifier and is unchanged.)
    const twoWay = new Set([
      'telegram_take_decisions',
      'telegram_answer_callback',
      'send_telegram_request',
      'telegram_watch_log',
      'telegram_watch_stop',
      'write_approval_decision',
      'read_pending_approvals',
    ])
    for (const c of calls.filter((x) => twoWay.has(x.cmd))) {
      expect(JSON.stringify(c.args ?? {})).not.toContain(TOKEN)
      expect(JSON.stringify(c.args ?? {})).not.toContain('AAHdqTcv')
    }

    // Nothing the bridge returns is a token either, so nothing can end up in a
    // DOM error string (the earlier audit's failure mode).
    for (const value of await Promise.all(
      ['telegram_take_decisions', 'telegram_watch_log', 'read_pending_approvals'].map((cmd) =>
        invokeMock(cmd, {}),
      ),
    )) {
      expect(JSON.stringify(value ?? null)).not.toContain(TOKEN)
    }

    // And the rendered desk never contains it.
    expect(document.body.textContent ?? '').not.toContain(TOKEN)
    expect(document.body.textContent ?? '').not.toContain('AAHdqTcv')
  })
})
