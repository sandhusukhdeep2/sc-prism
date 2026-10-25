import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Telegram TWO-WAY (2026-08-11 spec) — the phone answering something already
// parked. We mock ONLY the native seam of nativeEngine (the six telegram
// bridges plus the approval I/O) and keep every decision rule real, so what is
// exercised here is the actual gate: chat id, single-use request id, still-
// genuinely-pending, and the SAME writer a desk click uses.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  decideApproval: vi.fn(async () => true),
  startTelegramWatch: vi.fn(async () => null as string | null),
  stopTelegramWatch: vi.fn(async () => undefined),
  takeTelegramDecisions: vi.fn(async () => [] as unknown[]),
  sendTelegramRequest: vi.fn(async () => null as string | null),
  answerTelegramCallback: vi.fn(async () => undefined),
}))
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})

import {
  approvalRequestText,
  configureTelegramApprovals,
  dispatchRequestText,
  handleTelegramDecision,
  pumpTelegramApprovals,
  recentTelegramNotes,
  resetTelegramApprovalsForTest,
  telegramApprovalLog,
  telegramDecidedTargets,
  telegramNoteText,
  telegramNotesSnapshot,
  telegramRequestIdsForTest,
  type TelegramDecisionNote,
} from './telegramApprovals'
import { addJob, getManagers, parkJob } from './managers'
import type { PendingApproval, TelegramDecision } from './nativeEngine'

// A REAL bot token shape — used to prove it never lands anywhere readable.
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
const CHAT = '424242'

const paused: PendingApproval = {
  id: 'req-abc',
  run_id: 'run-1',
  server: 'fs',
  tool: 'write_file',
  // Arguments are CONTENT (a path, a payload, possibly vault-derived). The
  // request message must never carry this.
  args_summary: '{"path":"/Users/me/vault/private.md"}',
  at: Math.floor(Date.now() / 1000),
}

function tap(requestId: string, decision: 'allow' | 'deny', chat = CHAT): TelegramDecision {
  return { callback_id: `cb-${requestId}`, request_id: requestId, decision, chat_id: chat }
}

/** Turn the loop on and announce `paused`, returning the minted request id. */
async function armWithPausedRun(now = Date.now()): Promise<string> {
  native.readPendingApprovals.mockResolvedValue([paused])
  configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
  await pumpTelegramApprovals(now)
  const [id] = telegramRequestIdsForTest()
  return id
}

beforeEach(() => {
  localStorage.clear()
  resetTelegramApprovalsForTest()
  native.isNative.mockReturnValue(true)
  native.resolveVaultDir.mockResolvedValue('/vault')
  native.readPendingApprovals.mockReset().mockResolvedValue([])
  native.decideApproval.mockReset().mockResolvedValue(true)
  native.startTelegramWatch.mockReset().mockResolvedValue(null)
  native.stopTelegramWatch.mockReset().mockResolvedValue(undefined)
  native.takeTelegramDecisions.mockReset().mockResolvedValue([])
  native.sendTelegramRequest.mockReset().mockResolvedValue(null)
  native.answerTelegramCallback.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  resetTelegramApprovalsForTest()
  localStorage.clear()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Request ids — opaque, unguessable, single-use, expiring
// ---------------------------------------------------------------------------

describe('request ids', () => {
  it('are 128 bits of CSPRNG hex, unique per request, and never derived from the target', async () => {
    const first = await armWithPausedRun()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toContain('req-abc')

    // A second parked item mints a different id.
    resetTelegramApprovalsForTest()
    native.readPendingApprovals.mockResolvedValue([{ ...paused, id: 'req-two' }])
    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    await pumpTelegramApprovals(Date.now())
    const [second] = telegramRequestIdsForTest()
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
  })

  it('asks ONCE per parked item — a steady desk never re-pings the phone', async () => {
    await armWithPausedRun()
    expect(native.sendTelegramRequest).toHaveBeenCalledTimes(1)
    await pumpTelegramApprovals(Date.now())
    await pumpTelegramApprovals(Date.now())
    expect(native.sendTelegramRequest).toHaveBeenCalledTimes(1)
  })

  it('retires the id when the request message could not be delivered', async () => {
    native.sendTelegramRequest.mockResolvedValue('telegram said 403')
    await armWithPausedRun()
    // No live capability for a message that never arrived.
    expect(telegramRequestIdsForTest()).toEqual([])
    expect(telegramApprovalLog().join(' ')).toContain('could not send a Telegram request')
  })
})

// ---------------------------------------------------------------------------
// What goes OUT (the outcome-only rule from the earlier audit)
// ---------------------------------------------------------------------------

describe('the request message', () => {
  it('names the tool ONLY — never the arguments, never model output', async () => {
    await armWithPausedRun()
    const [text, requestId] = native.sendTelegramRequest.mock.calls[0] as unknown as [string, string]
    expect(text).toContain('fs · write_file')
    expect(text).toContain('Details in SC Prism')
    // The audit line: args_summary is content and must not egress.
    expect(text).not.toContain('private.md')
    expect(text).not.toContain('path')
    expect(text).not.toContain(paused.args_summary as string)
    // The button payload carries the opaque id and nothing about the target.
    expect(requestId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('names the manager and job for a parked dispatch — never its prompt', () => {
    const text = dispatchRequestText('Compliance', {
      id: 'job-1',
      managerId: 'm1',
      title: 'weekly scan',
      department: 'ops',
      prompt: 'SECRET PROMPT with vault detail',
      everyMinutes: 60,
      lastRun: 0,
      runs: [],
      kind: 'dispatch',
      approval: 'ask',
      pendingSince: 1,
    })
    expect(text).toContain('Compliance · weekly scan')
    expect(text).not.toContain('SECRET PROMPT')
    // And the paused-run line never carries args either.
    expect(approvalRequestText(paused)).not.toContain('private.md')
  })
})

// ---------------------------------------------------------------------------
// Who may decide — chat id, unknown ids, expiry, double taps
// ---------------------------------------------------------------------------

describe('a tap is honoured only when it is really allowed to be', () => {
  it('IGNORES a tap from a non-configured chat id: nothing written, no reply, honest log', async () => {
    const id = await armWithPausedRun()
    const reply = await handleTelegramDecision(tap(id, 'allow', '999999'))
    // Silence to the sender — a stranger probing the bot learns nothing.
    expect(reply).toBe('')
    expect(native.answerTelegramCallback).not.toHaveBeenCalled()
    // NOTHING was decided.
    expect(native.decideApproval).not.toHaveBeenCalled()
    expect(telegramDecidedTargets().has('req-abc')).toBe(false)
    // …and it is logged honestly, locally.
    const logged = telegramApprovalLog().join(' ')
    expect(logged).toContain('999999')
    expect(logged).toContain('not the configured chat')
    expect(logged).toContain('nothing was decided')
    // The request is still live for the real user.
    expect(telegramRequestIdsForTest()).toEqual([id])
  })

  it('answers an UNKNOWN request id honestly and writes nothing', async () => {
    await armWithPausedRun()
    const reply = await handleTelegramDecision(tap('f'.repeat(32), 'allow'))
    expect(reply).toBe('Unknown request — nothing was decided.')
    expect(native.answerTelegramCallback).toHaveBeenCalledWith(
      `cb-${'f'.repeat(32)}`,
      'Unknown request — nothing was decided.',
    )
    expect(native.decideApproval).not.toHaveBeenCalled()
  })

  it('answers a tap on something that already TIMED OUT honestly and writes nothing', async () => {
    const id = await armWithPausedRun()
    // The engine's bound elapsed: it removed the pending file and resumed
    // (unapproved). The desk shows nothing pending — and neither may the phone.
    native.readPendingApprovals.mockResolvedValue([])
    const reply = await handleTelegramDecision(tap(id, 'allow'))
    expect(reply).toBe('That request already timed out — nothing was decided.')
    expect(native.decideApproval).not.toHaveBeenCalled()
    expect(telegramDecidedTargets().has('req-abc')).toBe(false)
  })

  it('treats a tap past the id TTL as late WITHOUT even asking the vault', async () => {
    const now = Date.now()
    const id = await armWithPausedRun(now)
    native.readPendingApprovals.mockClear()
    // 6 minutes later — past the engine's 300s blocking bound.
    const reply = await handleTelegramDecision(tap(id, 'allow'), now + 360_000)
    expect(reply).toBe('That request already timed out — nothing was decided.')
    expect(native.readPendingApprovals).not.toHaveBeenCalled()
    expect(native.decideApproval).not.toHaveBeenCalled()
  })

  it('a DOUBLE TAP decides exactly once', async () => {
    const id = await armWithPausedRun()
    const [first, second] = await Promise.all([
      handleTelegramDecision(tap(id, 'allow')),
      handleTelegramDecision(tap(id, 'allow')),
    ])
    expect(native.decideApproval).toHaveBeenCalledTimes(1)
    expect(native.decideApproval).toHaveBeenCalledWith('/vault', 'req-abc', 'allow')
    // One of the two is told, truthfully, that nothing changed.
    expect([first, second].filter((r) => r === 'Already decided — nothing changed.')).toHaveLength(1)
    expect([first, second].filter((r) => r === 'Approved — the run is continuing.')).toHaveLength(1)
  })

  it('a failed write is NOT claimed as a decision, and the tap can be retried', async () => {
    const id = await armWithPausedRun()
    native.decideApproval.mockResolvedValue(false)
    expect(await handleTelegramDecision(tap(id, 'allow'))).toBe(
      "Couldn't record that — decide it in SC Prism.",
    )
    expect(telegramDecidedTargets().has('req-abc')).toBe(false)
    // Nothing was written, so the id is honestly still usable.
    native.decideApproval.mockResolvedValue(true)
    expect(await handleTelegramDecision(tap(id, 'allow'))).toBe('Approved — the run is continuing.')
  })
})

// ---------------------------------------------------------------------------
// The decision itself — one path, shared with the desk
// ---------------------------------------------------------------------------

describe('a valid decision goes through the SAME app-side function a desk click uses', () => {
  it('Approve → decideApproval(vault, id, "allow") — the desk button verbatim', async () => {
    const id = await armWithPausedRun()
    expect(await handleTelegramDecision(tap(id, 'allow'))).toBe('Approved — the run is continuing.')
    expect(native.decideApproval).toHaveBeenCalledWith('/vault', 'req-abc', 'allow')
    expect(telegramDecidedTargets().has('req-abc')).toBe(true)
  })

  it('Deny → decideApproval(vault, id, "deny") — never a fabricated success', async () => {
    const id = await armWithPausedRun()
    expect(await handleTelegramDecision(tap(id, 'deny'))).toBe('Denied — the tool was not run.')
    expect(native.decideApproval).toHaveBeenCalledWith('/vault', 'req-abc', 'deny')
  })

  it('a parked DISPATCH job is approved through approveDispatch — the real store moves', async () => {
    addJob('mgr-1', 'weekly scan', 'ops', 'p', 60, 'dispatch', 'ask')
    const job = getManagers().jobs[0]
    parkJob(job.id, 1000)
    expect(getManagers().jobs[0].pendingSince).toBe(1000)

    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    await pumpTelegramApprovals(Date.now())
    const [id] = telegramRequestIdsForTest()
    expect(await handleTelegramDecision(tap(id, 'allow'), 5000)).toBe('Approved — the job will run.')

    const after = getManagers().jobs[0]
    expect(after.pendingSince).toBe(0)
    expect(after.approvedAt).toBe(5000)
  })

  it('a dispatch job that is no longer parked cannot be decided from the phone', async () => {
    addJob('mgr-1', 'weekly scan', 'ops', 'p', 60, 'dispatch', 'ask')
    const job = getManagers().jobs[0]
    parkJob(job.id, 1000)
    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    await pumpTelegramApprovals(Date.now())
    const [id] = telegramRequestIdsForTest()
    // Decided at the desk in the meantime.
    parkJob(job.id, 0)
    expect(await handleTelegramDecision(tap(id, 'allow'), 5000)).toBe(
      'That request already timed out — nothing was decided.',
    )
    expect(getManagers().jobs[0].approvedAt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The desk reflects it (source + when), including the late tap
// ---------------------------------------------------------------------------

describe('the desk and the phone never silently disagree', () => {
  it('records a Telegram-sourced decision with its source and time', async () => {
    const id = await armWithPausedRun()
    await handleTelegramDecision(tap(id, 'allow'), 5_000)
    const [note] = recentTelegramNotes(telegramNotesSnapshot(), 5_000)
    expect(note.outcome).toBe('decided')
    expect(note.at).toBe(5_000)
    expect(telegramNoteText(note)).toBe('Approved from Telegram — fs · write_file')
  })

  it('says plainly when a tap landed after the request had already timed out', async () => {
    const id = await armWithPausedRun()
    native.readPendingApprovals.mockResolvedValue([])
    await handleTelegramDecision(tap(id, 'allow'), 9_000)
    const [note] = recentTelegramNotes(telegramNotesSnapshot(), 9_000)
    expect(note.outcome).toBe('timed-out')
    expect(telegramNoteText(note)).toBe(
      'A Telegram tap for fs · write_file arrived after it timed out — nothing was decided',
    )
  })

  it('ages notes out (the banner is temporary; the decision is not)', () => {
    const fresh: TelegramDecisionNote = {
      key: 'a', kind: 'approval', label: 'fs · write_file', decision: 'allow', outcome: 'decided', at: 1_000_000,
    }
    const old: TelegramDecisionNote = { ...fresh, key: 'b', at: 1_000_000 - 11 * 60_000 }
    expect(recentTelegramNotes([fresh, old], 1_000_000)).toEqual([fresh])
  })
})

// ---------------------------------------------------------------------------
// Polling only while reports are on, and token custody
// ---------------------------------------------------------------------------

describe('polling runs ONLY while reports are on', () => {
  it('never starts and never polls when reports are off', async () => {
    configureTelegramApprovals({ enabled: false, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    await pumpTelegramApprovals(Date.now())
    expect(native.startTelegramWatch).not.toHaveBeenCalled()
    expect(native.takeTelegramDecisions).not.toHaveBeenCalled()
    expect(native.readPendingApprovals).not.toHaveBeenCalled()
    expect(native.sendTelegramRequest).not.toHaveBeenCalled()
  })

  it('never starts without both credentials', async () => {
    configureTelegramApprovals({ enabled: true, token: '', chatId: CHAT, vaultPath: '/vault' })
    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: '', vaultPath: '/vault' })
    await pumpTelegramApprovals(Date.now())
    expect(native.startTelegramWatch).not.toHaveBeenCalled()
  })

  it('never starts in a browser (no engine, nothing to decide)', async () => {
    native.isNative.mockReturnValue(false)
    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    expect(native.startTelegramWatch).not.toHaveBeenCalled()
  })

  it('turning reports OFF stops the poller, forgets the token, and retires live ids', async () => {
    const id = await armWithPausedRun()
    expect(native.startTelegramWatch).toHaveBeenCalledWith(TOKEN, CHAT)
    expect(telegramRequestIdsForTest()).toEqual([id])

    configureTelegramApprovals({ enabled: false, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    expect(native.stopTelegramWatch).toHaveBeenCalled()
    expect(telegramRequestIdsForTest()).toEqual([])
    // A tap arriving after consent was withdrawn decides nothing.
    native.takeTelegramDecisions.mockResolvedValue([tap(id, 'allow')])
    await pumpTelegramApprovals(Date.now())
    expect(native.decideApproval).not.toHaveBeenCalled()
  })
})

describe('token custody', () => {
  it('the token is handed to the native side ONCE and never appears anywhere else', async () => {
    const id = await armWithPausedRun()
    await handleTelegramDecision(tap(id, 'allow'))
    await handleTelegramDecision(tap('0'.repeat(32), 'allow'))
    await handleTelegramDecision(tap(id, 'deny', '999999'))

    // The only call that ever sees the token is the native watch handoff.
    expect(native.startTelegramWatch).toHaveBeenCalledWith(TOKEN, CHAT)

    // Sending and answering take NO token — the native side uses its own copy.
    for (const call of native.sendTelegramRequest.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN)
      expect(call).toHaveLength(2)
    }
    for (const call of native.answerTelegramCallback.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN)
      expect(call).toHaveLength(2)
    }
    // Nothing the webview can read back carries it: not the log, not the notes,
    // not the live request registry.
    const readable = JSON.stringify({
      log: telegramApprovalLog(),
      notes: telegramNotesSnapshot(),
      ids: telegramRequestIdsForTest(),
      decided: [...telegramDecidedTargets()],
    })
    expect(readable).not.toContain(TOKEN)
    expect(readable).not.toContain('AAHdqTcv')
  })

  it('an honest error from the native side is surfaced without a token in it', async () => {
    native.startTelegramWatch.mockResolvedValue('telegram said 401: Unauthorized')
    configureTelegramApprovals({ enabled: true, token: TOKEN, chatId: CHAT, vaultPath: '/vault' })
    await Promise.resolve()
    await Promise.resolve()
    const logged = telegramApprovalLog().join(' ')
    expect(logged).toContain('could not start the Telegram poller')
    expect(logged).toContain('401')
    expect(logged).not.toContain(TOKEN)
  })
})
