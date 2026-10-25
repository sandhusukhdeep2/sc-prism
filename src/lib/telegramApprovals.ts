// SC Prism — Telegram TWO-WAY: approve or deny a PARKED request from the phone
// (2026-08-11 spec). The outbound notifier (telegramNotify.ts) is a courtesy
// mirror; this is the one place the phone can change something, and it can
// change exactly two kinds of thing, both of which are ALREADY waiting:
//
//   * a mid-run BLOCKING approval — a real engine subprocess paused at a held
//     tool call, polling <vault>/approvals/decided/<id>.json for our answer;
//   * a manager DISPATCH/TEAM job parked awaiting an OK.
//
// Not chat. Not task-giving. Those stay in the app, where the live view is.
//
// ── The single decision path (binding) ─────────────────────────────────────
// A phone tap does NOT get its own writer. It calls the SAME function a desk
// click calls — `decideApproval` for a paused run, `approveDispatch` /
// `rejectDispatch` for a parked job — so the engine reads a byte-identical
// artifact and there is no second implementation to drift.
//
// ── What may be decided (binding honesty) ──────────────────────────────────
// A tap is honoured ONLY when all three hold:
//   1. the chat id matches the configured one (checked natively AND here),
//   2. the request id is one WE minted and has not been spent,
//   3. the thing is still genuinely parked RIGHT NOW (the pending file still
//      exists / the job is still parked).
// Everything else gets an honest answer — "that request already timed out",
// "unknown request", "already decided" — and writes NOTHING. A tap from a
// foreign chat is answered with SILENCE (a stranger probing the bot learns
// nothing) plus an honest local log line.
//
// ── What goes out (binding, the outcome-only rule from the earlier audit) ──
// A request message names the tool or the job and nothing else: never the
// arguments, never model output, never vault content. Telegram is a CLOUD
// egress; the detail stays in the app, where the local-stays-local promise is
// enforced.
//
// ── Token custody ─────────────────────────────────────────────────────────
// Nothing here ever holds the bot token. `configureTelegramApprovals` hands it
// straight to the native side once, and the send/answer wrappers take no token
// at all. The module's own state (registry + notes) is token-free, so nothing
// the webview can read — or that could end up in a DOM error string — carries
// it.

import { useSyncExternalStore } from 'react'
import { approveDispatch, getManagers, rejectDispatch, type ManagerJob } from './managers'
import {
  answerTelegramCallback,
  decideApproval,
  isNative,
  readPendingApprovals,
  resolveVaultDir,
  sendTelegramRequest,
  startTelegramWatch,
  stopTelegramWatch,
  takeTelegramDecisions,
  type PendingApproval,
  type TelegramDecision,
} from './nativeEngine'

// How often the pump announces new parked items and drains inbound taps. Matches
// the desk's own native poll cadence, so the phone and the desk see the same
// world within the same few seconds.
const PUMP_MS = 4000

// A minted request id stops being usable after this — the engine's blocking
// broker defaults to a 300s bound, so a tap later than this can only be late.
// The REAL authority is still the pending file (checked on every tap); this is
// id hygiene, and it is what lets a late tap be answered "already timed out"
// instead of the less honest "unknown request".
const APPROVAL_TTL_MS = 330_000
// A parked dispatch job has no engine-side deadline — it waits for a human. Its
// id is retired after a day so the registry cannot grow without bound.
const DISPATCH_TTL_MS = 24 * 60 * 60_000
// How long a SPENT or EXPIRED id is remembered so a second tap can still be
// answered truthfully rather than as "unknown".
const REMEMBER_MS = 60 * 60_000
// Desk notes older than this stop being shown (the decision itself is permanent
// — this is just the "and it came from your phone" banner).
const NOTE_TTL_MS = 10 * 60_000
const MAX_NOTES = 5

type RequestKind = 'approval' | 'dispatch'

interface TelegramRequest {
  /** The opaque id in the button payload — never a target id. */
  id: string
  kind: RequestKind
  /** The approval id (engine request) or the manager job id. */
  target: string
  /** Human label for the desk note — a tool or job NAME, never content. */
  label: string
  /** Resolved vault dir captured when the request was minted. */
  vault: string
  at: number
  expiresAt: number
  /** Single-use: set the instant a tap is accepted, before any await. */
  spent: boolean
}

/** What the desk shows so the app and the phone never silently disagree. */
export interface TelegramDecisionNote {
  key: string
  kind: RequestKind
  label: string
  decision: 'allow' | 'deny'
  /** `decided` — it really happened. `timed-out` / `unknown` — it did NOT. */
  outcome: 'decided' | 'timed-out' | 'unknown' | 'failed'
  at: number
}

interface TgApprovalConfig {
  enabled: boolean
  token: string
  chatId: string
  vaultPath: string
}

const requests = new Map<string, TelegramRequest>()
/** Announce-once keys (`kind:target[:parkedAt]`) so a parked item pings once. */
const announced = new Set<string>()
/** Approval ids decided from the phone — the desk hides them immediately. */
const decidedTargets = new Set<string>()
let notes: TelegramDecisionNote[] = []
let cfg: TgApprovalConfig = { enabled: false, token: '', chatId: '', vaultPath: '' }
let watching = false
let timer: ReturnType<typeof setInterval> | null = null
/** The cycle currently running — concurrent callers join it (see the pump). */
let inFlight: Promise<void> | null = null
/** Honest local log (foreign chat ids, failures) — token-free by construction. */
let localLog: string[] = []

// --- store plumbing (useSyncExternalStore) ---------------------------------

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function snapshot(): readonly TelegramDecisionNote[] {
  return notes
}

/** Decisions that arrived from Telegram, newest first — what the desk shows. */
export function useTelegramDecisions(): readonly TelegramDecisionNote[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The same snapshot the hook reads, for non-React callers (and tests). */
export function telegramNotesSnapshot(): readonly TelegramDecisionNote[] {
  return notes
}

/** Approval ids already decided from the phone (desk hides them optimistically). */
export function telegramDecidedTargets(): ReadonlySet<string> {
  return decidedTargets
}

/** The honest local log this module wrote (ignored taps, failed writes). */
export function telegramApprovalLog(): readonly string[] {
  return localLog
}

function log(line: string): void {
  localLog = [...localLog, line].slice(-50)
}

/**
 * Notes worth showing right now — pure, so the desk can render "came from
 * Telegram, 2m ago" without owning the ageing rule.
 */
export function recentTelegramNotes(
  all: readonly TelegramDecisionNote[],
  now: number,
): TelegramDecisionNote[] {
  return all.filter((n) => now - n.at <= NOTE_TTL_MS).slice(0, MAX_NOTES)
}

/**
 * The desk's line for one Telegram-sourced decision — pure, so what the app
 * says and what the phone was told can be compared in a test. Every wording
 * here is literal about whether anything actually changed.
 */
export function telegramNoteText(n: TelegramDecisionNote): string {
  if (n.outcome === 'decided') {
    return `${n.decision === 'allow' ? 'Approved' : 'Denied'} from Telegram — ${n.label}`
  }
  if (n.outcome === 'timed-out') {
    return `A Telegram tap for ${n.label} arrived after it timed out — nothing was decided`
  }
  if (n.outcome === 'failed') {
    return `A Telegram decision for ${n.label} couldn't be written — it is still waiting here`
  }
  return 'A Telegram tap carried an unknown request — nothing was decided'
}

function addNote(note: TelegramDecisionNote): void {
  notes = [note, ...notes].slice(0, MAX_NOTES)
  emit()
}

// --- request ids -----------------------------------------------------------

/**
 * An opaque, unguessable request id: 128 bits from the platform CSPRNG, hex.
 * It is a CAPABILITY (whoever holds it can decide that one thing once), so it
 * is never derived from the target id, the tool name, or a counter.
 *
 * No CSPRNG → `null`, and the caller sends NO request message: a guessable id
 * would be worse than no phone button at all.
 */
function newRequestId(): string | null {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (!c || typeof c.getRandomValues !== 'function') return null
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// --- outbound: ask ---------------------------------------------------------

/**
 * The request line for a paused run. OUTCOME/IDENTITY ONLY — `server · tool`
 * and what the buttons do. Deliberately NOT `args_summary`: that is the tool's
 * arguments (a path, a payload, possibly vault-derived), and the audit rule is
 * that content never egresses.
 */
export function approvalRequestText(p: PendingApproval): string {
  return `⏸ Approval needed — ${p.server} · ${p.tool}\nApprove to let the paused run continue, or Deny. Details in SC Prism.`
}

/** The request line for a parked job — manager + job NAME, never its prompt. */
export function dispatchRequestText(managerName: string, job: ManagerJob): string {
  return `⏸ Waiting for your OK — ${managerName} · ${job.title}\nApprove to run it, or Deny. Details in SC Prism.`
}

async function ask(kind: RequestKind, target: string, label: string, vault: string, text: string, now: number): Promise<void> {
  const id = newRequestId()
  if (!id) {
    log('no secure random source — no Telegram request was sent (an id must be unguessable)')
    return
  }
  const ttl = kind === 'approval' ? APPROVAL_TTL_MS : DISPATCH_TTL_MS
  requests.set(id, { id, kind, target, label, vault, at: now, expiresAt: now + ttl, spent: false })
  const err = await sendTelegramRequest(text, id)
  if (err) {
    // Undeliverable → retire the id rather than leave a live capability lying
    // around for a message that never arrived.
    requests.delete(id)
    log(`could not send a Telegram request for ${label} — ${err}`)
  }
}

// --- inbound: decide -------------------------------------------------------

const REPLY = {
  unknown: 'Unknown request — nothing was decided.',
  spent: 'Already decided — nothing changed.',
  expired: 'That request already timed out — nothing was decided.',
  approved: 'Approved — the run is continuing.',
  denied: 'Denied — the tool was not run.',
  jobApproved: 'Approved — the job will run.',
  jobDenied: 'Rejected — the job was not run.',
  failed: "Couldn't record that — decide it in SC Prism.",
} as const

function parkedJob(id: string): ManagerJob | undefined {
  return getManagers().jobs.find(
    (j) => j.id === id && (j.kind === 'dispatch' || j.kind === 'team') && (j.pendingSince ?? 0) > 0,
  )
}

/**
 * Honour one inbound tap — or refuse it honestly. Returns the reply text that
 * was sent to the phone (`''` = deliberate silence, for a foreign chat id).
 *
 * The order matters: the chat check and the registry checks come FIRST and cost
 * nothing, the id is spent BEFORE the still-parked check (so two taps in one
 * batch can never both get through), and only then does the decision go out —
 * through the same function a desk click uses.
 */
export async function handleTelegramDecision(
  d: TelegramDecision,
  now: number = Date.now(),
): Promise<string> {
  const decision: 'allow' | 'deny' = d.decision === 'allow' ? 'allow' : 'deny'

  // 1. Chat id. The native poller already dropped foreign chats; this is the
  // second lock on the same door. SILENT to the sender, honest locally.
  if (!cfg.chatId || String(d.chat_id) !== cfg.chatId) {
    log(
      `ignored a Telegram tap from chat ${d.chat_id || 'unknown'} — not the configured chat; nothing was decided`,
    )
    return ''
  }

  // 2. Is it one of ours, and unspent?
  const req = requests.get(d.request_id)
  if (!req) {
    await answerTelegramCallback(d.callback_id, REPLY.unknown)
    log('a Telegram tap carried an unknown request id — nothing was decided')
    addNote({ key: `unknown-${now}`, kind: 'approval', label: 'unknown request', decision, outcome: 'unknown', at: now })
    return REPLY.unknown
  }
  if (req.spent) {
    await answerTelegramCallback(d.callback_id, REPLY.spent)
    return REPLY.spent
  }

  // SINGLE-USE: spend the id here, before the first await below, so a
  // double-tap cannot produce two decisions.
  req.spent = true

  // 3. Is the thing still genuinely parked? An id past its TTL is late by
  // definition; otherwise ask the world (the pending file / the job's state).
  const stale = now > req.expiresAt
  const stillParked = stale
    ? false
    : req.kind === 'approval'
      ? (await readPendingApprovals(req.vault)).some((p) => p.id === req.target)
      : parkedJob(req.target) !== undefined
  if (!stillParked) {
    await answerTelegramCallback(d.callback_id, REPLY.expired)
    addNote({ key: req.target, kind: req.kind, label: req.label, decision, outcome: 'timed-out', at: now })
    log(`a Telegram tap for ${req.label} arrived after it was no longer pending — nothing was decided`)
    return REPLY.expired
  }

  // 4. Decide — through the SAME app-side function the desk button calls.
  if (req.kind === 'approval') {
    const ok = await decideApproval(req.vault, req.target, decision)
    if (!ok) {
      req.spent = false // nothing was written; an honest retry is allowed
      await answerTelegramCallback(d.callback_id, REPLY.failed)
      addNote({ key: req.target, kind: req.kind, label: req.label, decision, outcome: 'failed', at: now })
      return REPLY.failed
    }
    decidedTargets.add(req.target)
  } else if (decision === 'allow') {
    approveDispatch(req.target, now)
  } else {
    rejectDispatch(req.target, now)
  }

  const reply =
    req.kind === 'approval'
      ? decision === 'allow'
        ? REPLY.approved
        : REPLY.denied
      : decision === 'allow'
        ? REPLY.jobApproved
        : REPLY.jobDenied
  await answerTelegramCallback(d.callback_id, reply)
  addNote({ key: req.target, kind: req.kind, label: req.label, decision, outcome: 'decided', at: now })
  return reply
}

// --- the pump --------------------------------------------------------------

function sweep(now: number): void {
  for (const [id, r] of requests) {
    if (now - r.at > REMEMBER_MS) requests.delete(id)
  }
  // The announce-once and phone-decided sets are session-lived and only ever
  // grow, so bound them. Dropping the oldest half is safe: an entry only
  // matters while its item is still parked (minutes), and the worst case is one
  // extra ask for something genuinely still waiting — never a wrong decision.
  trimSet(announced, 500)
  trimSet(decidedTargets, 500)
}

function trimSet(set: Set<string>, cap: number): void {
  if (set.size <= cap) return
  const drop = set.size - Math.floor(cap / 2)
  let i = 0
  for (const key of set) {
    if (i++ >= drop) break
    set.delete(key)
  }
}

/**
 * One cycle: announce anything newly parked, drain the taps the native poller
 * collected, retire stale ids. Exported so tests drive it deterministically
 * instead of waiting on a timer.
 *
 * Re-entrant callers JOIN the cycle already running rather than starting a
 * second one (two concurrent drains could hand the same tap to two handlers) —
 * and joining, rather than silently returning, means an `await` here always
 * means "a cycle has finished".
 */
export function pumpTelegramApprovals(now: number = Date.now()): Promise<void> {
  if (!cfg.enabled) return Promise.resolve()
  if (inFlight) return inFlight
  inFlight = runPump(now).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runPump(now: number): Promise<void> {
  try {
    const vault = await resolveVaultDir(cfg.vaultPath)

    // Announce paused runs the user has not been asked about yet.
    for (const p of await readPendingApprovals(vault)) {
      const key = `approval:${p.id}`
      if (announced.has(key)) continue
      announced.add(key)
      await ask('approval', p.id, `${p.server} · ${p.tool}`, vault, approvalRequestText(p), now)
    }

    // Announce parked dispatch/team jobs. The key carries `pendingSince`, so a
    // job that parks AGAIN on a later cycle is a new question, not a repeat.
    const { jobs, managers } = getManagers()
    for (const j of jobs) {
      if ((j.kind !== 'dispatch' && j.kind !== 'team') || (j.pendingSince ?? 0) <= 0) continue
      const key = `dispatch:${j.id}:${j.pendingSince}`
      if (announced.has(key)) continue
      announced.add(key)
      const managerName = managers.find((m) => m.id === j.managerId)?.name ?? 'manager'
      await ask('dispatch', j.id, `${managerName} · ${j.title}`, vault, dispatchRequestText(managerName, j), now)
    }

    // Drain inbound taps — sequentially, so two taps on one request are ordered
    // and the second reads the first's `spent`.
    for (const d of await takeTelegramDecisions()) {
      await handleTelegramDecision(d, now)
    }

    sweep(now)
  } catch {
    // A pump failure must never break the app: the desk is still the source of
    // truth and every parked item is still decidable there.
  }
}

/**
 * Start / stop the whole two-way loop from settings. Called on every AppStore
 * render (like configureTelegram), so it must be cheap and idempotent.
 *
 * Reports OFF — or missing credentials, or a browser — means: the native poller
 * is stopped and FORGETS the token, the pump interval is cleared, and every
 * outstanding request id is retired. There is no state in which polling
 * continues after the user has said no.
 */
export function configureTelegramApprovals(next: TgApprovalConfig): void {
  const same =
    cfg.enabled === next.enabled &&
    cfg.token === next.token &&
    cfg.chatId === next.chatId &&
    cfg.vaultPath === next.vaultPath
  const usable = next.enabled && Boolean(next.token) && Boolean(next.chatId)
  cfg = next
  if (same && watching === usable) return

  if (!usable || !isNative()) {
    if (watching) {
      watching = false
      void stopTelegramWatch()
      log('Telegram reports are off — the inbound poller stopped and forgot the token')
    }
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    // Any outstanding capability is retired with the consent that created it.
    requests.clear()
    announced.clear()
    return
  }

  // Credentials changed while running → restart cleanly on the new pair.
  if (watching) {
    requests.clear()
    announced.clear()
  }
  watching = true
  void startTelegramWatch(next.token, next.chatId).then((err) => {
    if (err) log(`could not start the Telegram poller — ${err}`)
  })
  if (!timer) timer = setInterval(() => void pumpTelegramApprovals(), PUMP_MS)
  void pumpTelegramApprovals()
}

/** Test-only: reset every module-level bit of state. */
export function resetTelegramApprovalsForTest(): void {
  requests.clear()
  announced.clear()
  decidedTargets.clear()
  notes = []
  localLog = []
  cfg = { enabled: false, token: '', chatId: '', vaultPath: '' }
  watching = false
  inFlight = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  emit()
}

/** Test-only: the ids currently live (a spent/expired one is still listed). */
export function telegramRequestIdsForTest(): string[] {
  return [...requests.keys()]
}
