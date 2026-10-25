// One-way Telegram reports (companion grant, 2026-07-29 spec). Fire-and-forget
// — a report NEVER blocks or fails a run; delivery problems are silently
// dropped here because the run stream is the source of truth, the phone is a
// courtesy mirror. Master switch + credentials come from settings via
// configureTelegram (called by AppStore whenever settings change).
import { sendTelegram } from './nativeEngine'

interface TgConfig {
  enabled: boolean
  token: string
  chatId: string
}

let cfg: TgConfig = { enabled: false, token: '', chatId: '' }

export function configureTelegram(next: TgConfig): void {
  cfg = next
}

function fire(text: string): void {
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return
  void sendTelegram(cfg.token, cfg.chatId, text.slice(0, 500))
}

/** Project lifecycle notices ("«X» is done — check it"). Mirrors ONLY the
 *  outcome kinds a user would want on their phone, not every info line — and
 *  strips everything after the first ':' (audit): failure notices append tool
 *  detail (git stderr etc.) there, which is content, not outcome, and must
 *  not egress to Telegram. */
export function notifyNotice(kind: string, text: string): void {
  if (kind !== 'done' && kind !== 'attention') return
  const outcomeOnly = text.split(':')[0].trimEnd()
  fire(`${kind === 'done' ? '✓' : '⚠'} ${outcomeOnly}`)
}

/**
 * Manager job completion — the standing manager reporting to its human.
 * OUTCOME ONLY, never content (audit): a job's summary is model output that
 * may be 🔒-local or vault-derived — Telegram is a CLOUD egress, so the phone
 * line carries name + job + pass/fail and nothing else. Read the full report
 * in the app, where the local-stays-local promise is enforced.
 */
export function notifyManagerReport(manager: string, job: string, ok: boolean): void {
  fire(`${ok ? '✓' : '✗'} ${manager} · ${job} — ${ok ? 'passed' : 'failed'} · details in SC Prism`)
}

// Needs-you nudges dedupe on COUNT INCREASE only — a steady or shrinking desk
// stays quiet, so approving items never re-pings the phone. The FIRST poll of
// a session only seeds the baseline (audit L4): items that existed before the
// app launched were already reported; re-pinging every launch is noise.
let lastNeedsYou = 0
let needsYouSeeded = false

export function notifyNeedsYou(count: number): void {
  if (needsYouSeeded && count > lastNeedsYou) {
    fire(`Needs you: ${count} item${count === 1 ? '' : 's'} waiting on the Work desk`)
  }
  needsYouSeeded = true
  lastNeedsYou = count
}

/** Test-only reset for the needs-you dedupe. */
export function resetNeedsYouForTest(): void {
  lastNeedsYou = 0
  needsYouSeeded = false
}
