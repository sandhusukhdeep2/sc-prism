// SC Prism — manager agents (persisted under `scprism.managers` + disk store).
// A manager is a standing agent bound to ONE connected AI; it owns recurring
// maintenance JOBS, each tagged to a department from the interview. A global
// deterministic driver (AppStore) runs due jobs serially through the REAL
// engine with the manager's provider as primary (ADR-007: the driver — code —
// orchestrates; models never do).

import { useCallback, useSyncExternalStore } from 'react'
import { isNative, storeGet, storeSet } from './nativeEngine'
import type { InterviewState } from './interview'
import type { Settings } from './settings'

export interface ManagerRun {
  at: number
  ok: boolean
  summary: string
}

export interface ManagerJob {
  id: string
  managerId: string
  title: string
  department: string
  prompt: string
  everyMinutes: number
  lastRun: number
  runs: ManagerRun[] // newest first, capped
  /** 'report' appends prose to vault/reports (default); 'dispatch' runs the
   *  full verified pipeline and produces a real Verdict; 'team' runs the same
   *  dispatch approval machine but through a roster of agents (see below). */
  kind?: 'report' | 'dispatch' | 'team'
  /** Dispatch/team only: 'ask' parks the job for the user's OK (default); 'auto' runs unattended. */
  approval?: 'ask' | 'auto'
  /** >0 = parked awaiting the user's OK (dispatch/team + 'ask'). */
  pendingSince?: number
  /** >0 = the user approved; the driver runs it on the next tick. */
  approvedAt?: number
  /** Team only: 'lead:<id>,researcher:<id>,critic:<id>'. '' = default roster at run time. */
  roster?: string
  /** Team only: max tokens for the team run. 0/absent = 100_000 at run time. */
  tokenBudget?: number
}

/** One heartbeat wake outcome (2026-07-29 spec). Every beat the UI shows IS
 *  one of these records — the orb line, the card log, and the report all come
 *  from here, never fabricated. `tokens` is the run's REAL in+out sum. */
export interface Beat {
  at: number
  action: 'worked' | 'rested'
  line: string
  ok: boolean
  tokens: number
}

/** What the USER has decided about the heartbeat — persisted separately from
 *  `enabled` so "never decided" and "decided OFF" are different facts.
 *  Without this the setup-completion default-on (2026-08-05 §Part 3) would
 *  re-enable a heartbeat the user deliberately switched off, every launch. */
export type HeartbeatConsent = 'undecided' | 'on' | 'off'

/** The companion's heartbeat: wake on a cadence, look at real state, do ONE
 *  governed piece of work or honestly rest. Seeded OFF/undecided; it turns ON
 *  by itself ONCE setup completes (2026-08-05 §Part 3) and that flip is only
 *  legitimate because it is announced — see `autoOnAt` + HeartbeatNotice. */
export interface Heartbeat {
  enabled: boolean
  charter: string
  everyMinutes: number
  lastBeat: number
  beats: Beat[] // newest first, capped at MAX_BEATS
  /** Per-day accumulator (local day, same discipline as beatsTodayTokens).
   *  The beats ARRAY is capped at MAX_BEATS, so a fast cadence (15m = 96
   *  beats/day) would silently under-report if the card summed the array —
   *  this counter survives the trim. Updated by recordBeat; reset when the
   *  local day changes. */
  today: { day: string; beats: number; tokens: number }
  /** The user's own decision. Written ONLY by an explicit user action (the
   *  Agents switch, the orb pause/resume, the consent notice's buttons) —
   *  never by the app's default-on. 'off' is sticky across relaunches. */
  consent: HeartbeatConsent
  /** When the APP default-enabled this heartbeat at setup completion (0 =
   *  never). Two jobs: it makes the flip once-only, and while consent is
   *  still 'undecided' it is what makes the consent notice visible. A
   *  token-spending background loop the user never saw announced would be a
   *  bill-time surprise — this field is the receipt that it was announced. */
  autoOnAt: number
  /**
   * Come back BEFORE the next cadence beat is due (0/absent = cadence only).
   *
   * Set when a wake is skipped for a reason that says nothing about whether
   * there was work to do — today, only a maintenance (dark) wake. Without it a
   * skip costs the whole hour it landed in, because the skip records a beat and
   * the beat advances the cadence: six consecutive maintenance wakes across one
   * night left Sukhdeep's manager idle from 02:37 to 09:55 having done nothing
   * at all, each skip having quietly spent an hour it never used.
   */
  retryAt?: number
  /**
   * The RUN of consecutive maintenance-wake skips currently in progress.
   *
   * Retrying every five minutes through a sleeping night would append ~96 skip
   * beats and push the real history out of a 40-beat log — the log would be
   * destroyed by the very fix meant to protect it. So a run of skips collapses
   * into ONE beat that counts itself, and this is its tally. Cleared by the
   * first beat that actually runs.
   */
  skipRun?: { since: number; count: number }
  /**
   * The deterministic state fingerprint the last REAL beat was taken over
   * (2026-08-28). Written only by a wake that actually ran the model — a chain
   * of free rests must never re-anchor itself, or a wake that failed against
   * changed state could hide behind its own print forever.
   *
   * The day this exists for: eleven hourly wakes, 48,826 tokens, seven of them
   * concluding "Same 8 notes, the same 'new' node cli project". Whether
   * anything changed is a question deterministic code can answer for free —
   * the model is only woken for state it has not already seen.
   */
  lastPrint?: { hash: string; at: number }
  /**
   * The RUN of consecutive free rests in progress — recordRestBeat's collapse
   * tally, exactly the discipline skipRun gives maintenance wakes: a quiet day
   * costs the 40-beat log ONE self-counting entry, not eleven. Cleared by the
   * first beat that actually runs.
   */
  restRun?: { since: number; count: number }
}

export interface Manager {
  id: string // 'mgr-<providerId>'
  providerId: string
  name: string
  enabled: boolean
  /** v1: only the companion manager carries one (id COMPANION_MANAGER_ID). */
  heartbeat?: Heartbeat
}

export interface ManagersState {
  managers: Manager[]
  jobs: ManagerJob[]
  seeded: boolean
  /**
   * When the driver's interval last FIRED — not when it last did work.
   *
   * WHY THIS FIELD EXISTS. Sukhdeep's manager stopped on 20 Aug and nobody
   * noticed for a week: no beat, no job run, no error, and an app that went on
   * looking healthy the whole time. Every existing signal records what the
   * driver DID; none records that it was alive. So a driver that never reaches
   * its work — because its interval is throttled, its effect never mounted, or
   * a guard sends every tick home early — is indistinguishable from a manager
   * with nothing to do.
   *
   * This is written on EVERY tick, before any guard. Silence here means the
   * loop itself is dead, and `driverStalled` below turns that into something
   * the app can say out loud.
   *
   * IN MEMORY ONLY, deliberately — see `recordDriverTick`. The question it
   * answers ("is the loop running right now?") is only ever about the session
   * you are in; a value carried over from a previous one would be an
   * accusation about hours the app was not even open.
   */
  lastTick?: number
}

const STORAGE_KEY = 'scprism.managers'

/** The driver's own interval (AppStore). Exported so the staleness rule below
 *  and the driver cannot disagree about how often a tick is expected. */
export const DRIVER_TICK_MS = 30_000

/**
 * When this session began — the floor under every silence measurement.
 *
 * The driver's interval is created once with AppProvider and fires first at
 * +30s, so a just-opened app has legitimately not ticked yet. Measuring
 * silence from module load rather than from zero means a Mac that was shut for
 * three days is not greeted by an accusation the moment it wakes.
 */
const SESSION_START = Date.now()
const MAX_RUNS = 20
const MAX_BEATS = 40
/** Hard cap on the charter: it travels inside EVERY wake prompt, so an
 *  unbounded paste would silently inflate every beat's token cost. Enforced
 *  in updateHeartbeat + sanitizeHeartbeat + the Agents textarea maxLength. */
export const MAX_CHARTER = 2000

/** The one manager whose runs use the normal PRIMARY path (buildEngineProviders),
 *  not a pinned per-manager provider. Its display name comes from
 *  settings.companionName at render time — never baked into the store. */
export const COMPANION_MANAGER_ID = 'mgr-companion'

/**
 * The charter EVERY install shipped with before the 2026-08-15 ladder — kept
 * verbatim because it is the migration's fingerprint. A stored charter equal to
 * this string is one nobody ever edited, so it may be replaced with the ladder;
 * a charter that differs by so much as a character is the USER'S text and is
 * never overwritten (see `migrateCharter`).
 */
export const OLD_STARTER_CHARTER =
  'You are the standing companion for this business. Each wake, look at the ' +
  'real project statuses and the knowledge vault, and prepare ONE small ' +
  'useful piece of work — a summary, a tidy-up, a draft, a flagged risk — ' +
  'within your existing grants. Never invent work: if nothing genuinely ' +
  'needs doing, rest honestly.'

/**
 * The charter is a PRIORITY LADDER, not three parallel jobs (2026-08-15 spec
 * §3). He does ONE piece of work per wake, so the only useful thing a charter
 * can do is say which piece — walk from the top, take the first rung that has
 * genuinely NEW state, and if none does, rest. The rest protocol is unchanged:
 * the exact `NOTHING_NEEDED — <line>` token parseWakeReply has always read.
 *
 * Rung 2's list is not invented here: it is the concrete upkeep his OWN
 * vault-health report produced (index verdicts, triage log.md, archive stale
 * reports, flag broken links). Rung 4 is fenced hard — business work only from
 * context he was actually given, because inferring a business fact he was never
 * told is precisely the failure the interview (spec §4) exists to prevent.
 */
export const STARTER_CHARTER = [
  'You are the standing companion for this business. Each wake you do ONE piece of work.',
  'Choose it by walking this ladder from the top and taking the FIRST rung that has genuinely new state:',
  '1. Waiting on the user — surface anything genuinely waiting on them, plainly and in their words. Never invent one.',
  '2. Vault upkeep — index verdicts, triage log.md, archive stale reports, flag broken links.',
  '3. Project prep — read the real project state, draft the next step, flag blockers.',
  '4. Business work — ONLY from business context you have actually been given. Never infer a business fact you were not told.',
  'If no rung has genuinely new state, rest: reply exactly `NOTHING_NEEDED — <one honest line>`.',
  'Resting is a real outcome. Never manufacture work to look busy.',
].join('\n')

/**
 * The ladder migration. An install still carrying the OLD default charter moves
 * to the new one; anything else is left exactly as it is.
 *
 * The distinction is a byte comparison against the known old default (trimmed,
 * because the textarea's save path can leave surrounding whitespace). That is
 * the only honest test available: there is no "edited" flag, so "differs from
 * the string we shipped" is what "the user wrote this" means. The consequence
 * is deliberately one-sided — a user who edited his charter back into the exact
 * old wording loses that edit; a user who changed a single word keeps all of it.
 */
export function migrateCharter(charter: string): string {
  return charter.trim() === OLD_STARTER_CHARTER ? STARTER_CHARTER : charter
}

/**
 * The companion's default cadence, in minutes (2026-08-15 spec §2 — cadence
 * measured in hours). It was 15-30 minutes; it is now 2 hours.
 *
 * Why: a vault that changes a few times a day gives a 15-minute wake nothing
 * new to act on. It re-reads unchanged state, finds the same nothing, and bills
 * for the reading — 96 real AI runs a day to discover 96 times that the notes
 * have not moved. Two hours is roughly the rate at which this business's state
 * actually changes, so a wake has a real chance of finding something.
 *
 * EXISTING installs keep whatever cadence they already store — this default
 * only seeds a new companion and backs a malformed stored value.
 */
export const DEFAULT_CADENCE_MIN = 120

/** The seeded companion manager — heartbeat present, OFF and UNDECIDED. It
 *  stays off until either the user enables it or setup completes (which
 *  default-enables it with a visible notice — see applySetupDefaultOn). */
function companionManager(): Manager {
  return {
    id: COMPANION_MANAGER_ID,
    providerId: 'primary',
    name: 'Companion',
    enabled: false,
    heartbeat: {
      enabled: false,
      charter: STARTER_CHARTER,
      everyMinutes: DEFAULT_CADENCE_MIN,
      lastBeat: 0,
      beats: [],
      today: { day: '', beats: 0, tokens: 0 },
      consent: 'undecided',
      autoOnAt: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function managerIdFor(providerId: string): string {
  return `mgr-${providerId}`
}

/** Jobs whose interval elapsed, restricted to ENABLED managers. */
export function dueJobs(state: ManagersState, now: number): ManagerJob[] {
  const enabled = new Set(state.managers.filter((m) => m.enabled).map((m) => m.id))
  return state.jobs.filter((j) => {
    if (!enabled.has(j.managerId)) return false
    if ((j.approvedAt ?? 0) > 0) return true // an approval overrides the timer
    if ((j.pendingSince ?? 0) > 0) return false // parked awaiting the user
    return now - j.lastRun >= j.everyMinutes * 60_000
  })
}

/** The companion manager's display name — settings.companionName wins at
 *  render time (never baked into the store), else the seeded fallback. */
export function managerDisplayName(m: Manager, settings: Settings): string {
  if (m.id === COMPANION_MANAGER_ID && settings.companionName.trim()) {
    return settings.companionName.trim()
  }
  return m.name
}

/** A heartbeat is due when it is ON and its interval elapsed — same lastRun
 *  discipline as dueJobs. The ENABLE transition stamps lastBeat = now (see
 *  updateHeartbeat), so a fresh enable waits one full cadence rather than
 *  firing within 30s of the toggle; a legacy-stored lastBeat 0 is still due
 *  immediately, which only this helper's callers can reach. */
export function beatDue(now: number, hb: Heartbeat | undefined): boolean {
  if (!hb?.enabled) return false
  // A pending retry (a skip that spent none of its hour) comes due on its own
  // schedule, ahead of the cadence. Either clock can make a beat due.
  if (hb.retryAt && now >= hb.retryAt) return true
  return now - hb.lastBeat >= hb.everyMinutes * 60_000
}

/**
 * Should the app default-enable this heartbeat now that setup is complete
 * (2026-08-05 §Part 3 — "always-on manager")? TRUE only when setup is done,
 * the user has NEVER decided, and the app has not already done it once.
 *
 * The two negative cases are the whole point:
 * - `consent === 'off'` — the user explicitly turned it off. That decision is
 *   sticky forever; re-enabling it on the next launch would be the app
 *   overruling a human about spending his money.
 * - `autoOnAt > 0` — already default-enabled once. If he then turned it off
 *   the consent covers it; this is the belt-and-braces so the flip is
 *   once-in-a-lifetime even if consent were somehow reset.
 * Pure so the whole decision is unit-testable without a store.
 */
export function shouldDefaultOn(hb: Heartbeat | undefined, setupDone: boolean): boolean {
  if (!setupDone || !hb) return false
  return hb.consent === 'undecided' && hb.autoOnAt === 0
}

/**
 * Is the consent notice owed to the user? TRUE from the moment the app
 * default-enabled the heartbeat until he answers it (either button on the
 * notice writes a real `consent`, which is what clears it). This is the only
 * thing that makes the silent-enable honest: a token-spending background loop
 * he never saw announced must never be discovered from a bill.
 */
export function heartbeatNoticeDue(hb: Heartbeat | undefined): boolean {
  return !!hb && hb.autoOnAt > 0 && hb.consent === 'undecided'
}

/**
 * The honest reason "Wake now" cannot run a beat right this second, or `null`
 * when it can. A disabled button that says nothing looks broken; every refusal
 * here names a real, checkable condition. Ordered most-specific first so the
 * reason is the useful one (a wake already running is not "engine busy").
 * Pure — the store re-checks the same predicate authoritatively before it
 * spends anything, and both surfaces render from this one function so the orb
 * and the Agents card can never disagree.
 */
export function wakeNowBlockReason(opts: {
  hb: Heartbeat | undefined
  primaryReal: boolean
  waking: boolean
  engineBusy: boolean
}): string | null {
  if (!opts.hb) return 'no heartbeat on this companion'
  if (!opts.hb.enabled) return 'heartbeat is off — turn it on first'
  if (!opts.primaryReal) return 'no AI connected — connect a provider in Settings'
  if (opts.waking) return 'a wake is already running'
  if (opts.engineBusy) return 'the engine is busy with another run'
  return null
}

// ---------------------------------------------------------------------------
// Don't work on a sleeping Mac (2026-08-15 spec §1)
// ---------------------------------------------------------------------------

/** The honest line a skipped wake records. The gap in the beat log must be
 *  explained — a silent missing beat is indistinguishable from a broken app. */
export const DARK_WAKE_SKIP_LINE = 'skipped — the Mac was in a maintenance wake, nothing ran'

/**
 * Should this wake be skipped without spending anything? ONLY on a proven dark
 * wake. 'unknown' — the signal could not be read at all — RUNS, because
 * skipping work on a guess is the one failure mode worse than a wasted beat.
 * A one-line function so the rule has exactly one home and a test of its own.
 */
export function shouldSkipWake(power: 'full' | 'dark' | 'unknown'): boolean {
  return power === 'dark'
}

/**
 * How soon a skipped wake tries again.
 *
 * A maintenance wake gives roughly ninety seconds of real CPU spread over the
 * better part of an hour, so coming back in five minutes usually finds either
 * the same dark wake (skip again, free) or a Mac that is properly awake and can
 * do the work. It is short enough that a machine woken at ten past the hour
 * does not idle until the next one, and long enough that a whole sleeping night
 * costs a few dozen `pmset` reads and nothing else.
 */
export const DARK_WAKE_RETRY_MS = 5 * 60_000

/** The beat a skipped wake records: rested, ok (nothing failed — the machine
 *  was simply asleep), zero tokens, and the machine's own words for why.
 *  A `run` of more than one collapses into this single self-counting line, so
 *  a night of maintenance wakes costs the beat log one entry instead of
 *  ninety-six. */
export function darkWakeBeat(at: number, detail = '', run?: { since: number; count: number }): Beat {
  const why = detail.trim()
  const times =
    run && run.count > 1 ? ` — ${run.count} times since ${clockLabel(run.since)}` : ''
  return {
    at,
    action: 'rested',
    line: (why ? `${DARK_WAKE_SKIP_LINE} (${why})` : DARK_WAKE_SKIP_LINE) + times,
    ok: true,
    tokens: 0,
  }
}

/** Local wall-clock time, for a line a person reads next to their own day. */
function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Record a skipped wake WITHOUT spending the cadence it landed in.
 *
 * Three things happen here that `recordBeat` must not do:
 *  - `retryAt` is set, so the next attempt is minutes away rather than a full
 *    hour — the skip gives back the time it did not use.
 *  - a run of consecutive skips COLLAPSES into one self-counting beat, so the
 *    faster retry cannot flush the real history out of a capped log.
 *  - the per-day counter counts the RUN once, not each retry, so the card does
 *    not report ninety-six beats for a night the manager spent asleep.
 */
export function recordSkipBeat(
  hb: Heartbeat,
  at: number,
  detail: string,
  retryAt: number,
): Heartbeat {
  const continuing = !!hb.skipRun && !!hb.beats[0] && isSkipBeat(hb.beats[0])
  const run = continuing
    ? { since: hb.skipRun!.since, count: hb.skipRun!.count + 1 }
    : { since: at, count: 1 }
  const beat = darkWakeBeat(at, detail, run)
  const beats = continuing
    ? [beat, ...hb.beats.slice(1)]
    : [beat, ...hb.beats].slice(0, MAX_BEATS)
  const day = localDayKey(at)
  const today = continuing
    ? hb.today.day === day
      ? hb.today
      : { day, beats: 1, tokens: 0 }
    : hb.today.day === day
      ? { day, beats: hb.today.beats + 1, tokens: hb.today.tokens }
      : { day, beats: 1, tokens: 0 }
  return { ...hb, lastBeat: at, retryAt, skipRun: run, beats, today }
}

/** Is this beat one of the collapsed maintenance-wake skips? */
export function isSkipBeat(b: Beat): boolean {
  return b.line.startsWith(DARK_WAKE_SKIP_LINE)
}

// ---------------------------------------------------------------------------
// The unchanged-state guard (2026-08-28): never pay to learn nothing changed
// ---------------------------------------------------------------------------

/** One vault note's change-relevant identity: path + mtime + size. The walk
 *  that produces these lists only .md files — spans/verdicts (.jsonl/.json)
 *  never dirty a wake. */
export interface VaultNoteMeta {
  path: string
  mtime: number
  size: number
}

/** Everything a wake would paste into its prompt, reduced to the identities
 *  that can change. If none of these moved since the last REAL beat, the model
 *  has already seen this exact world and said its piece about it. */
export interface WakeStateInputs {
  needsYou: number
  projects: { id: string; name: string; status: string }[]
  vaultNotes: VaultNoteMeta[]
  /** The companion's OWN report dir(s). A worked beat appends to
   *  reports/<slug>/heartbeat.md — if that write counted as new state, every
   *  beat would arm the next one and the guard could never fire. */
  excludePrefixes: string[]
  businessNote: string
  evidencePool: string[]
  agents: string[]
  questionSetIds: string[]
  charter: string
  everyMinutes: number
}

/** FNV-1a over a string — tiny, deterministic, stdlib-free. Two passes with
 *  different offset bases give 64 bits of print; a collision would cost one
 *  skipped wake inside the 12h re-anchor window, never a wrong answer. */
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The free "did anything change?" answer. Canonicalizes (sorts every list)
 *  so gather order can never fake a change. */
export function wakeFingerprint(i: WakeStateInputs): string {
  const notes = i.vaultNotes
    .filter((n) => !i.excludePrefixes.some((p) => n.path.startsWith(p)))
    .map((n) => `${n.path}|${n.mtime}|${n.size}`)
    .sort()
  const canon = JSON.stringify({
    needsYou: i.needsYou,
    projects: i.projects.map((p) => `${p.id}|${p.name}|${p.status}`).sort(),
    notes,
    business: i.businessNote,
    // The companion's OWN verdicts are not world changes: each wake records a
    // `heartbeat-…` verdict, and if that id counted here, every beat would arm
    // the next one and the guard could never fire — the report-file loop
    // (excludePrefixes above) reborn through the evidence pool. Seen live
    // 2026-08-29: three hourly wakes re-failing the same reply, each armed by
    // the last one's verdict. Real runs still count; only self-echo is muted.
    pool: i.evidencePool.filter((id) => !id.startsWith('heartbeat-')).sort(),
    agents: [...i.agents].sort(),
    sets: [...i.questionSetIds].sort(),
    charter: i.charter,
    every: i.everyMinutes,
  })
  return fnv1a(canon, 0x811c9dc5).toString(16) + fnv1a(canon, 0x9dc5811c).toString(16)
}

/** The honest line a free rest records. Like DARK_WAKE_SKIP_LINE, it is the
 *  stable prefix isRestBeat keys on — reword it and the collapse breaks. */
export const REST_UNCHANGED_LINE = 'nothing changed — rested without a model call'

/** Force one REAL beat after this much quiet, even over an unchanged print.
 *  An idle vault must not mean the companion never checks in again — and a
 *  model occasionally re-reading a quiet world is how drift gets noticed. */
export const REST_REANCHOR_MS = 12 * 3_600_000

/** Is this beat one of the collapsed free rests? */
export function isRestBeat(b: Beat): boolean {
  return b.line.startsWith(REST_UNCHANGED_LINE)
}

/**
 * Record a FREE rest: the fingerprint matched, so no model ran and no tokens
 * were spent. Advances the cadence (the hour was honestly used — checking cost
 * one directory walk), collapses a run of rests into one self-counting beat,
 * and counts the run once in the per-day accumulator — all the disciplines
 * recordSkipBeat established, minus the retry debt: unlike a dark wake, a rest
 * DID its check, so it owes nothing back.
 */
export function recordRestBeat(hb: Heartbeat, at: number): Heartbeat {
  const continuing = !!hb.restRun && !!hb.beats[0] && isRestBeat(hb.beats[0])
  const run = continuing
    ? { since: hb.restRun!.since, count: hb.restRun!.count + 1 }
    : { since: at, count: 1 }
  const times = run.count > 1 ? ` — ${run.count} times since ${clockLabel(run.since)}` : ''
  const beat: Beat = { at, action: 'rested', line: REST_UNCHANGED_LINE + times, ok: true, tokens: 0 }
  const beats = continuing ? [beat, ...hb.beats.slice(1)] : [beat, ...hb.beats].slice(0, MAX_BEATS)
  const day = localDayKey(at)
  const today = continuing
    ? hb.today.day === day
      ? hb.today
      : { day, beats: 1, tokens: 0 }
    : hb.today.day === day
      ? { day, beats: hb.today.beats + 1, tokens: hb.today.tokens }
      : { day, beats: 1, tokens: 0 }
  const next = { ...hb, lastBeat: at, restRun: run, beats, today }
  // A rest is a completed check: any dark-wake retry debt is settled by it.
  delete next.retryAt
  delete next.skipRun
  return next
}

// ---------------------------------------------------------------------------
// The priority ladder (2026-08-15 spec §3)
// ---------------------------------------------------------------------------

/** The four rungs, in order, plus the honest fifth outcome. */
export type LadderRung = 'needs-you' | 'vault' | 'projects' | 'business' | 'rest'

/** What the APP can prove about each rung at wake time. Counts only — whether a
 *  rung has genuinely NEW state is a judgement only the wake itself can make
 *  over the real files (ADR-007: the driver orchestrates, the model works). */
export interface LadderState {
  /** Items genuinely waiting on the user right now (desk-derived, never guessed). */
  needsYou: number
  /** Notes the vault actually holds — 0 means rung 2 has nothing to look at. */
  vaultNotes: number
  /** Real projects on file. */
  projects: number
  /** Whether a business-context note with real, user-given content exists. */
  businessContext: boolean
}

/**
 * The highest rung that has anything AT ALL to look at — the ladder's ordering
 * made checkable. It deliberately answers a weaker question than "where is the
 * work": the app can prove a rung is EMPTY (no items waiting, no notes, no
 * projects, no business context) but it cannot prove a non-empty rung has
 * something new, so it names the top non-empty rung and the wake decides from
 * there. With everything empty the answer is 'rest', which is a first-class
 * outcome and not a failure.
 */
export function topRung(s: LadderState): LadderRung {
  if (s.needsYou > 0) return 'needs-you'
  if (s.vaultNotes > 0) return 'vault'
  if (s.projects > 0) return 'projects'
  if (s.businessContext) return 'business'
  return 'rest'
}

/**
 * The ladder FACTS for the wake prompt — what the app knows, rung by rung, so
 * the model never has to guess at (or invent) the shape of the state it is
 * about to work on. Every empty rung says it is empty, which is what stops a
 * wake from writing about projects that do not exist. Pure and unit-tested; the
 * charter (editable by the user) still carries the ladder's instructions.
 */
export function ladderBrief(s: LadderState): string {
  const lines = [
    `1. Waiting on you: ${s.needsYou === 0 ? 'nothing is waiting on you right now' : `${s.needsYou} item${s.needsYou === 1 ? '' : 's'}`}.`,
    `2. Vault: ${s.vaultNotes === 0 ? 'no notes yet — nothing to keep tidy' : `${s.vaultNotes} note${s.vaultNotes === 1 ? '' : 's'}`}.`,
    `3. Projects: ${s.projects === 0 ? 'none yet' : `${s.projects} on file`}.`,
    `4. Business context: ${s.businessContext ? 'recorded in the vault (read it before you use it)' : 'NONE recorded — you have not been told anything about this business, so do not write as if you had'}.`,
  ]
  return [
    'Ladder state, as the app can actually verify it right now:',
    lines.join('\n'),
    `The highest rung with anything to look at is ${topRung(s)}. Start there, and take the first rung that has genuinely NEW state — one piece of work, then stop.`,
  ].join('\n')
}

/**
 * Classify a wake reply. The wake instruction lets the model reply exactly
 * `NOTHING_NEEDED — <one honest line>` to rest; anything else is work and the
 * beat line is the reply's first line (capped like a run summary).
 *
 * Protocol tightening (audit): a rest is ONLY the exact token on the first
 * line — `NOTHING_NEEDED` followed by end-of-line or a dash/colon separator —
 * with NOTHING after that line. `NOTHING_NEEDED_X did Y`, `NOTHING_NEEDED is
 * wrong — …`, or a rest-line followed by more paragraphs all classify as
 * 'worked' so real content is never silently dropped from the report. A
 * blank/whitespace-only reply is neither work nor an honest rest — the driver
 * records it ok:false (no vault write, no phone line).
 */
/** How far into a reply we will look for the SUMMARY marker. A reasoning model
 *  thinks for a paragraph or two, not for pages; past this we stop hunting and
 *  fall back rather than picking a line out of the middle of an essay. */
const SUMMARY_SCAN_LINES = 40

export function parseWakeReply(text: string): { action: 'worked' | 'rested'; line: string } {
  const trimmed = text.trim()
  if (!trimmed) return { action: 'rested', line: 'blank reply — nothing recorded' }
  const lines = trimmed.split('\n')
  const [rawFirst = '', ...rest] = lines
  const first = rawFirst.trim()
  const restBlank = rest.join('\n').trim() === ''
  if (restBlank && /^NOTHING_NEEDED\s*($|[—–:-])/.test(first)) {
    const line = first.slice('NOTHING_NEEDED'.length).replace(/^[\s—–:-]+/, '').trim()
    return { action: 'rested', line: (line || 'nothing needed').slice(0, 160) }
  }

  // THE MARKED SUMMARY, if the model gave one.
  //
  // "The first line" is only the summary when the model answers straight away.
  // A reasoning model thinks aloud first: the wake that finally completed its
  // research opened with "Let me think about the ladder:", and THAT became the
  // line in the orb and the beat log — a scratchpad heading standing in for a
  // report. The charter now asks for `SUMMARY: <one line>`, so this reads the
  // marker it asked for rather than guessing which line is the point.
  for (const raw of lines.slice(0, SUMMARY_SCAN_LINES)) {
    const m = raw.trim().match(/^(?:[*_#>\s-]*)SUMMARY\s*[:—–-]\s*(.+)$/i)
    if (m) {
      // Markdown emphasis around the line is the model dressing it up, not
      // part of what it said.
      const line = m[1].replace(/[*_`]/g, '').trim()
      if (line) return { action: 'worked', line: line.slice(0, 160) }
    }
  }

  // No marker: the first line, exactly as before. A model that answers plainly
  // is not punished for not using a keyword.
  return { action: 'worked', line: first.slice(0, 160) }
}

/**
 * Join a wake's reply line with a trailing note (the proposal outcome) inside
 * ONE budget, giving the NOTE the room it needs. A plain
 * `${line}${note}`.slice(0, 280) guillotines the note — and the note is the
 * honest part: a refusal reason naming three ~40-char run ids runs ~150 chars,
 * so it was being cut mid-id, leaving a truncated id that resolves to nothing.
 * The reply line is what gets shortened (with an ellipsis, so the trim is
 * visible); a note longer than the whole budget is truncated alone, because a
 * half-line of reply plus a half-refusal helps nobody.
 */
export function beatLineWithNote(line: string, note: string, max = 280): string {
  if (!note) return line.slice(0, max)
  if (note.length >= max) return note.slice(0, max)
  const room = max - note.length
  const head = line.length <= room ? line : `${line.slice(0, Math.max(0, room - 1)).trimEnd()}…`
  return `${head}${note}`
}

/** Local-day key (YYYY-MM-DD from LOCAL date parts, never UTC) — the same
 *  local-day discipline beatsTodayTokens has always used. */
function localDayKey(at: number): string {
  const d = new Date(at)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Rebuild the per-day accumulator from the (possibly trimmed) beats array —
 *  the honest fallback for a malformed/missing stored `today`. Can only ever
 *  UNDER-report after a trim, never invent beats. */
function todayFromBeats(beats: Beat[]): Heartbeat['today'] {
  const newest = beats[0]
  if (!newest) return { day: '', beats: 0, tokens: 0 }
  const day = localDayKey(newest.at)
  const sameDay = beats.filter((b) => localDayKey(b.at) === day)
  return { day, beats: sameDay.length, tokens: sameDay.reduce((s, b) => s + b.tokens, 0) }
}

/** Record one beat: prepend (newest first, like runs) + advance lastBeat,
 *  capped at MAX_BEATS — and roll the per-day accumulator (reset on a local
 *  day change), so the day count survives the array trim. Pure — the store
 *  mutator applies it. */
export function recordBeat(hb: Heartbeat, beat: Beat): Heartbeat {
  const day = localDayKey(beat.at)
  const today =
    hb.today.day === day
      ? { day, beats: hb.today.beats + 1, tokens: hb.today.tokens + beat.tokens }
      : { day, beats: 1, tokens: beat.tokens }
  // A beat that actually ran ends any run of skips and returns the heartbeat to
  // its plain cadence — `retryAt` is a debt owed by a skip, and this pays it.
  const next = { ...hb, lastBeat: beat.at, today, beats: [beat, ...hb.beats].slice(0, MAX_BEATS) }
  delete next.retryAt
  delete next.skipRun
  // …and a real beat ends any run of free rests: the next rest starts its own
  // count instead of continuing a tally with a worked beat in the middle.
  delete next.restRun
  return next
}

/** Today's beats + their REAL token sum — the card's "today: N beats ·
 *  X tokens" line. Reads the per-day ACCUMULATOR (not the trimmed beats
 *  array, which caps at MAX_BEATS and would under-report a 15m-cadence day
 *  of 96 beats). A stale accumulator from an earlier day honestly reads as
 *  zero. Real sums over real runs, never an estimate. */
export function beatsTodayTokens(hb: Heartbeat, now: number): { count: number; tokens: number } {
  if (hb.today.day !== localDayKey(now)) return { count: 0, tokens: 0 }
  return { count: hb.today.beats, tokens: hb.today.tokens }
}

// --- Shared row labels (Agents' job rows + the Automations page) -------------
// These were private to Agents.tsx; the Automations page (2026-08-09 honesty
// pass) shows the SAME recurring work, so both pages read one implementation
// rather than drifting into two dialects of "ran 3h ago · due in 21h".

/** "never" / "just now" / "3m ago" / "2h ago" / "4d ago" for an epoch-ms time. */
export function agoLabel(at: number, now: number): string {
  if (!at) return 'never'
  const m = Math.round((now - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / (60 * 24))}d ago`
}

/**
 * "last ✓ 5h ago" / "last ✕ 2d ago" for a job's REAL newest run record, or ''
 * when the job has never run (nothing happened, so nothing is claimed).
 *
 * Shared by the Automations job rows and the Work page's "Up next" (2026-08-16
 * Finding 2): a job's persisted `runs[]` is the only record of it the user gets
 * between launches — the live card lives only for the length of the run and
 * `finishedRuns` is deliberately never persisted — so both surfaces state it
 * from the SAME helper instead of one of them staying silent about weeks of
 * real work.
 */
export function lastRunLabel(j: ManagerJob, now: number): string {
  const last = j.runs[0]
  if (!last) return ''
  return `last ${last.ok ? '✓' : '✕'} ${agoLabel(j.lastRun || last.at, now)}`
}

/** "due now" / "in 12m" / "in 5h" / "in 2d" from lastRun + cadence. */
export function nextDueLabel(j: { lastRun: number; everyMinutes: number }, now: number): string {
  const msLeft = j.lastRun + j.everyMinutes * 60_000 - now
  if (msLeft <= 0) return 'due now'
  const m = Math.ceil(msLeft / 60_000)
  return m < 60
    ? `in ${m}m`
    : m < 60 * 24
      ? `in ${Math.round(m / 60)}h`
      : `in ${Math.round(m / (60 * 24))}d`
}

/**
 * The consent copy — ONE sentence set, used by the Agents card and by the
 * setup-completion notice. Shared deliberately: the notice's whole job is to
 * show the user the same grant the card describes, so a second wording could
 * only ever be a weaker version of the disclosure. States the two facts a
 * consent needs: what he will do, and that it spends real money.
 */
export function heartbeatConsentCopy(name: string, everyMinutes: number): string {
  return (
    `${name} wakes ${cadenceLabel(everyMinutes)}, looks at your real project and vault state, ` +
    'and does ONE small piece of work within its existing grants — or honestly rests. ' +
    'Every wake is a real AI run that spends real tokens; each beat’s cost is recorded ' +
    'and shown on its card.'
  )
}

/** "every 30m" / "every 12h" / "every 7d" — the cadence, said in plain words. */
export function cadenceLabel(everyMinutes: number): string {
  if (everyMinutes < 60) return `every ${everyMinutes}m`
  if (everyMinutes < 60 * 24) return `every ${Math.round(everyMinutes / 60)}h`
  return `every ${Math.round(everyMinutes / (60 * 24))}d`
}

export function jobKind(j: ManagerJob): 'report' | 'dispatch' | 'team' {
  if (j.kind === 'team') return 'team'
  if (j.kind === 'dispatch') return 'dispatch'
  return 'report'
}

/**
 * What the driver should do with a due job. Reports always run (their path is
 * unchanged). A dispatch or team job runs when approved or set to auto; an
 * 'ask' dispatch/team job parks once and then waits until the user approves
 * or rejects — the approval machine is shared, not duplicated.
 */
/**
 * Whether a job of this kind can EVER park for approval.
 *
 * The rule is `nextDispatchAction`'s first line: a report job always runs,
 * whatever its approval setting says. Three surfaces used to promise the
 * opposite — "a manager job set to 'ask me first' parks here before it runs" —
 * which reads as a broken app to anyone whose jobs are all report jobs set to
 * "ask me first": they are told to expect a park the driver will never produce.
 * Those surfaces now ask this function instead of restating a rule from memory.
 */
export function jobCanPark(j: ManagerJob): boolean {
  return jobKind(j) !== 'report'
}

/** The parking rule in plain words — one string, every surface that explains it. */
export const PARKING_RULE =
  'Only work and team jobs park for approval. A report job runs without an OK even when it is set to “ask me first” — it reads your real state and writes a summary, changing nothing, so there is nothing to approve.'

export function nextDispatchAction(j: ManagerJob): 'run' | 'park' | 'wait' {
  if (jobKind(j) === 'report') return 'run'
  if ((j.approvedAt ?? 0) > 0) return 'run'
  if ((j.approval ?? 'ask') === 'auto') return 'run'
  if ((j.pendingSince ?? 0) > 0) return 'wait'
  return 'park'
}

/**
 * Default roster for a new team job, keyed off the manager's own provider id.
 * The manager leads (per ADR-007 the driver orchestrates, never a model), a
 * local researcher keeps cost down, and the critic is whichever of
 * gemini/claude the manager is NOT (so the critic is never the same model as
 * the lead).
 *
 * `providerCheck` (2026-08-12) drops any of those three that isn't connected —
 * '' for a provider that can really answer, a reason otherwise (lib/roster.ts).
 * It used to hand back all three unconditionally, so a job's default team could
 * name a provider the user had never connected and that seat then answered with
 * an offline stub. Callers with genuinely no provider context (a form
 * placeholder) pass `allowAllProviders` and say so out loud.
 */
/** The roles a manager staffs when the user has not named a roster. */
const TEAM_ROLES = ['lead', 'researcher', 'critic'] as const

/**
 * The crew a manager assembles from the AIs that can REALLY answer right now.
 *
 * WHAT THIS REPLACES, and why it was wrong. The old version hard-coded the
 * assignment: lead got the manager's own provider, `researcher` was ALWAYS
 * 'local', and `critic` was always Gemini (or Claude if the manager was
 * Gemini). Then every seat whose provider could not answer was silently
 * DROPPED. On Sukhdeep's Mac — Gemini switched off, Claude's CLI failing its
 * probe — that arithmetic produced a "team" of one local researcher, which is
 * exactly what he saw and exactly what he objected to: "default fallback is not
 * local... the manager is going to choose which task to give to which agent and
 * which AI that agent is going to use."
 *
 * So this chooses rather than assumes:
 *  · the LEAD keeps the manager's own AI when it can answer — the manager leads
 *    with its own model or not at all;
 *  · the other seats prefer an AI NOBODY ELSE IS ON, because the point of a
 *    crew is more than one opinion, and two seats on one model is one opinion
 *    typed twice;
 *  · when the diversity runs out, seats double up rather than vanish. Three
 *    coworkers on one model is a smaller team than you hoped for; a team of one
 *    because two seats were quietly deleted is a broken product.
 *
 * `candidates` is every provider token worth considering, in the user's own
 * order. `providerCheck` returns '' when a token can take a seat, or the reason
 * it cannot — the SAME gate the roster picker shows, so what a manager staffs
 * and what the app says is available can never disagree.
 *
 * Returns '' only when NOTHING can answer, which is the honest empty: there is
 * no team to name, and the caller reports that rather than inventing one.
 */
export function defaultTeamRoster(
  managerProviderId: string,
  providerCheck: (token: string) => string,
  candidates: readonly string[] = ['local', 'claude', 'claude-cli', 'gemini', 'openai'],
): string {
  // Every AI that can genuinely take a seat, manager's own first so the lead
  // gets it when it is usable.
  const usable: string[] = []
  for (const token of [managerProviderId, ...candidates]) {
    const t = (token ?? '').trim()
    if (!t || usable.includes(t)) continue
    if (!providerCheck(t)) usable.push(t)
  }
  if (usable.length === 0) return ''

  const taken = new Set<string>()
  const seats = TEAM_ROLES.map((role) => {
    // Prefer an AI no seat is on yet; once they are all spoken for, reuse in
    // the same order rather than dropping the seat.
    const fresh = usable.find((t) => !taken.has(t))
    const token = fresh ?? usable[taken.size % usable.length]
    taken.add(token)
    return `${role}:${token}`
  })
  return seats.join(',')
}

/** Trim an appended report so the newest content stays under `cap` chars. */
export function trimReport(existing: string, entry: string, cap = 50_000): string {
  const next = existing + entry
  if (next.length <= cap) return next
  const cut = next.length - cap
  const idx = next.indexOf('\n## ', cut)
  return idx >= 0 ? next.slice(idx) : next.slice(cut)
}

/**
 * Seed managers + starter jobs from the REAL setup: one manager per enabled
 * provider (disabled until the user flips it on), and interview-driven jobs.
 * Pure — takes inputs, returns state. Idempotent by construction (only called
 * when `seeded` is false).
 */
export function seedFromSetup(settings: Settings, interview: InterviewState): ManagersState {
  const enabledProviders = settings.providers.filter((p) => p.enabled)
  const managers: Manager[] = enabledProviders.map((p) => ({
    id: managerIdFor(p.id),
    providerId: p.id,
    name: `${p.name.replace(/\s*\(.*\)$/, '')} manager`,
    enabled: false,
  }))
  // The companion rides along with its heartbeat seeded OFF (2026-07-29 spec).
  managers.push(companionManager())

  const localMgr = managers.find((m) => m.providerId === 'local')
  const cloudMgrs = managers.filter((m) => m.providerId !== 'local')
  const bestCloud = cloudMgrs[0] ?? localMgr
  const cheapCloud =
    cloudMgrs.find((m) => m.providerId.includes('gemini')) ?? bestCloud

  const jobs: ManagerJob[] = []
  let n = 0
  const add = (
    mgr: Manager | undefined,
    title: string,
    department: string,
    prompt: string,
    everyMinutes: number,
  ) => {
    if (!mgr) return
    jobs.push({
      id: `job-${(n++).toString(36)}`,
      managerId: mgr.id,
      title,
      department,
      prompt,
      everyMinutes,
      lastRun: 0,
      runs: [],
    })
  }

  if (interview.compliance.length > 0) {
    add(
      bestCloud,
      'Compliance check',
      interview.departments.find((d) => /compliance/i.test(d)) ?? 'compliance',
      `Review our compliance obligations (${interview.compliance.join(', ')}) against recent work recorded in the vault. List anything that needs attention as short bullets; say "all clear" if nothing does.`,
      24 * 60,
    )
  }
  add(
    localMgr,
    'Summarize new notes',
    interview.departments.find((d) => /ops|operations/i.test(d)) ?? 'operations',
    'Summarize the newest notes and conversations in the vault in under 120 words — what changed, what needs a decision.',
    12 * 60,
  )
  add(
    localMgr,
    'Vault health',
    interview.departments.find((d) => /ops|operations/i.test(d)) ?? 'operations',
    'Check the knowledge vault for hygiene problems: notes missing structure, broken cross-links, stale sections. Report the top 3 fixes as bullets.',
    24 * 60,
  )
  add(
    cheapCloud,
    'Cost & drift review',
    interview.departments.find((d) => /finance/i.test(d)) ?? 'finance',
    'Review recent run costs and evaluation trends recorded in the vault. Flag rising costs or falling eval scores; say "stable" if healthy.',
    7 * 24 * 60,
  )

  return { managers, jobs, seeded: true }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const EMPTY: ManagersState = { managers: [], jobs: [], seeded: false }

/** Back-compat: a stored heartbeat is normalized field-by-field; anything
 *  malformed degrades toward DISABLED (enabled must be exactly true), never
 *  toward a runnable heartbeat. No heartbeat / not an object → undefined,
 *  which beatDue treats as off. */
function sanitizeHeartbeat(v: unknown): Heartbeat | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const h = v as Partial<Heartbeat>
  const beats = Array.isArray(h.beats)
    ? h.beats
        .filter((b): b is Beat => !!b && typeof b.at === 'number' && typeof b.line === 'string')
        .map((b) => ({
          at: b.at,
          action: b.action === 'rested' ? ('rested' as const) : ('worked' as const),
          line: b.line,
          ok: b.ok === true,
          tokens: typeof b.tokens === 'number' ? b.tokens : 0,
        }))
        .slice(0, MAX_BEATS)
    : []
  // Per-day accumulator: keep a well-formed stored one AS-IS (it may honestly
  // exceed what the trimmed beats array shows — that is its whole point); a
  // malformed/missing one (incl. every pre-accumulator store) is recomputed
  // from the beats, which can only under-report, never invent.
  const t = h.today as Partial<Heartbeat['today']> | undefined
  const todayValid =
    !!t &&
    typeof t === 'object' &&
    typeof t.day === 'string' &&
    typeof t.beats === 'number' &&
    Number.isFinite(t.beats) &&
    t.beats >= 0 &&
    typeof t.tokens === 'number' &&
    Number.isFinite(t.tokens) &&
    t.tokens >= 0
  const enabled = h.enabled === true
  // Consent back-fill for stores written BEFORE the field existed (every
  // install shipped so far). The rule reads the only evidence such a store
  // carries, and never invents a decision the user did not make:
  //  - ON right now  → he turned it on himself; the explicit Agents-card
  //    consent was the ONLY way it could be on. → 'on'.
  //  - OFF with beats → it ran, then it stopped: he turned it off. → 'off',
  //    so the default-on below leaves it alone (same "beats prove a consent
  //    happened" reading FloatingPulse's resume button has always used).
  //  - OFF with no beats → never decided. → 'undecided' (default-on eligible).
  // A missing/garbage stored value can only degrade toward 'undecided', which
  // is the state that REQUIRES the visible notice — never toward a silent on.
  const rawConsent = (h as { consent?: unknown }).consent
  const consent: HeartbeatConsent =
    rawConsent === 'on' || rawConsent === 'off' || rawConsent === 'undecided'
      ? rawConsent
      : enabled
        ? 'on'
        : beats.length > 0
          ? 'off'
          : 'undecided'
  const rawAuto = (h as { autoOnAt?: unknown }).autoOnAt
  return {
    enabled,
    // Same MAX_CHARTER bound as updateHeartbeat — a stored over-long charter
    // must not ride into every wake prompt. The ladder migration (2026-08-15)
    // rides here, on the ONE load path both localStorage and the disk store go
    // through: an untouched OLD default becomes the ladder, an edited charter is
    // left alone forever.
    charter: typeof h.charter === 'string' ? migrateCharter(h.charter).slice(0, MAX_CHARTER) : '',
    // isFinite mirrors updateHeartbeat's clamp: a stored Infinity/NaN cadence
    // would make the beat never due (silently disabled while showing ON). A
    // VALID stored cadence is kept as-is: the new 2h default seeds new
    // companions, it never overrules a cadence the user already chose.
    everyMinutes:
      typeof h.everyMinutes === 'number' && Number.isFinite(h.everyMinutes) && h.everyMinutes >= 5
        ? h.everyMinutes
        : DEFAULT_CADENCE_MIN,
    lastBeat: typeof h.lastBeat === 'number' ? h.lastBeat : 0,
    beats,
    today: todayValid ? { day: t.day!, beats: t.beats!, tokens: t.tokens! } : todayFromBeats(beats),
    consent,
    // A malformed autoOnAt reads as 0 = "never default-enabled". That can only
    // ever cause ONE extra announced flip (with its notice), never a silent one.
    autoOnAt: typeof rawAuto === 'number' && Number.isFinite(rawAuto) && rawAuto > 0 ? rawAuto : 0,
    // Both skip fields are written ONLY when they carry information, so a
    // heartbeat that has never been skipped round-trips exactly as it did
    // before they existed — no key appears in the store, and no existing
    // expectation of that store's shape changes.
    //
    // A pending retry survives a relaunch on purpose: the hour a skip gave back
    // is still owed after a restart. Anything malformed is simply dropped,
    // which can only ever delay a beat to its cadence — the behaviour before
    // the field existed — never bring one forward wrongly.
    ...(typeof h.retryAt === 'number' && Number.isFinite(h.retryAt) && h.retryAt > 0
      ? { retryAt: h.retryAt }
      : {}),
    // The skip tally is only ever a collapse/display aid; a malformed one is
    // dropped and the next skip simply starts a fresh run.
    ...(h.skipRun &&
    typeof h.skipRun.since === 'number' &&
    Number.isFinite(h.skipRun.since) &&
    typeof h.skipRun.count === 'number' &&
    Number.isFinite(h.skipRun.count) &&
    h.skipRun.count > 0
      ? { skipRun: { since: h.skipRun.since, count: h.skipRun.count } }
      : {}),
    // The unchanged-state print survives a relaunch on purpose: a fresh launch
    // over an unchanged world must not buy a burn. A malformed print is
    // dropped, which can only ever cost one real beat — never skip one wrongly.
    ...(h.lastPrint &&
    typeof h.lastPrint.hash === 'string' &&
    h.lastPrint.hash.length > 0 &&
    typeof h.lastPrint.at === 'number' &&
    Number.isFinite(h.lastPrint.at) &&
    h.lastPrint.at > 0
      ? { lastPrint: { hash: h.lastPrint.hash, at: h.lastPrint.at } }
      : {}),
    // The rest tally mirrors skipRun: a display aid; malformed → fresh run.
    ...(h.restRun &&
    typeof h.restRun.since === 'number' &&
    Number.isFinite(h.restRun.since) &&
    typeof h.restRun.count === 'number' &&
    Number.isFinite(h.restRun.count) &&
    h.restRun.count > 0
      ? { restRun: { since: h.restRun.since, count: h.restRun.count } }
      : {}),
  }
}

/**
 * A heartbeat manager's `enabled` flag IS its heartbeat's switch (2026-08-16
 * Finding 3).
 *
 * The companion card has no manager-level toggle — the switch the user can see
 * and use is the heartbeat's own "turn on/off" (with its consent record and the
 * setup default-on behind it). `Manager.enabled` was left at its seeded `false`
 * forever, so the driver's heartbeat gate and the flag disagreed: a manager the
 * data said was OFF kept waking, spending real tokens. Gating the driver on the
 * flag alone would have been just as dishonest the other way — nothing in the
 * app can ever set it true, so the heartbeat would silently never run again.
 *
 * So the two are kept in lockstep here, and this runs on LOAD as well as on
 * every mutation: an existing store (like the one that has been beating with
 * `enabled: false` for weeks) self-heals to the state the user actually sees,
 * and turning the heartbeat off now really does turn the manager off — for the
 * driver, the Agents card and the orb alike.
 *
 * Managers WITHOUT a heartbeat are untouched: their own visible switch (the
 * Agents card toggle → setManagerEnabled) still governs their jobs.
 */
function withHeartbeatEnabledSynced(m: Manager): Manager {
  if (!m.heartbeat || m.enabled === m.heartbeat.enabled) return m
  return { ...m, enabled: m.heartbeat.enabled }
}

function sanitize(v: unknown): ManagersState {
  if (typeof v !== 'object' || v === null) return { ...EMPTY }
  const s = v as Partial<ManagersState>
  return {
    managers: Array.isArray(s.managers)
      ? s.managers
          .filter((m): m is Manager => !!m && typeof m.id === 'string')
          .map((m) => withHeartbeatEnabledSynced({ ...m, heartbeat: sanitizeHeartbeat(m.heartbeat) }))
      : [],
    jobs: Array.isArray(s.jobs)
      ? s.jobs
          .filter((j): j is ManagerJob => !!j && typeof j.id === 'string')
          .map((j) => ({
            ...j,
            runs: (j.runs ?? []).slice(0, MAX_RUNS),
            kind:
              j.kind === 'dispatch'
                ? ('dispatch' as const)
                : j.kind === 'team'
                  ? ('team' as const)
                  : ('report' as const),
            approval: j.approval === 'auto' ? ('auto' as const) : ('ask' as const),
            pendingSince: typeof j.pendingSince === 'number' ? j.pendingSince : 0,
            approvedAt: typeof j.approvedAt === 'number' ? j.approvedAt : 0,
            roster: typeof j.roster === 'string' ? j.roster : '',
            tokenBudget: typeof j.tokenBudget === 'number' ? j.tokenBudget : 0,
          }))
      : [],
    seeded: Boolean(s.seeded),
  }
}

let state: ManagersState = load()
const listeners = new Set<() => void>()
let diskHydrated = !isNative()

function load(): ManagersState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

function emit(): void {
  for (const l of listeners) l()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* non-fatal */
  }
  if (diskHydrated) void storeSet('managers', JSON.stringify(state))
}

if (isNative()) {
  void storeGet('managers').then((raw) => {
    if (raw) {
      try {
        state = sanitize(JSON.parse(raw))
        emit()
      } catch {
        /* keep localStorage copy */
      }
    }
    diskHydrated = true
  })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getManagers(): ManagersState {
  return state
}

function setState(next: ManagersState): void {
  state = next
  persist()
  emit()
}

/** Seed once from the live setup (no-op after the first call). Stores seeded
 *  before the heartbeat era lack the companion manager — back-fill it once
 *  (heartbeat still OFF; enabling stays an explicit consent). */
export function ensureSeeded(settings: Settings, interview: InterviewState): void {
  if (!state.seeded) {
    setState(seedFromSetup(settings, interview))
    return
  }
  if (!state.managers.some((m) => m.id === COMPANION_MANAGER_ID)) {
    setState({ ...state, managers: [...state.managers, companionManager()] })
  }
}

export function setManagerEnabled(id: string, enabled: boolean): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id !== id
        ? m
        : m.heartbeat
          ? // A heartbeat manager has ONE switch, not two (see
            // withHeartbeatEnabledSynced): flipping the manager flips his
            // heartbeat with it, and records the decision as the user's, so
            // "off" can never mean "off on the card, on in the driver".
            {
              ...m,
              enabled,
              heartbeat: { ...m.heartbeat, enabled, consent: enabled ? 'on' : 'off' },
            }
          : { ...m, enabled },
    ),
  })
}

/** Update a heartbeat's settings (enable/pause, charter, cadence). No-op for
 *  a manager without one — a heartbeat is never conjured by a patch. The
 *  mutator enforces the same bounds sanitize does (a patch is just another
 *  untrusted write path): cadence must be a finite number >= 5 (Infinity/NaN/0
 *  degrade to 30 — an Infinity cadence would silently never beat while
 *  showing ON), and the charter is capped at MAX_CHARTER. */
export function updateHeartbeat(
  id: string,
  patch: Partial<Pick<Heartbeat, 'enabled' | 'charter' | 'everyMinutes'>>,
): void {
  setState({
    ...state,
    managers: state.managers.map((m) => {
      if (m.id !== id || !m.heartbeat) return m
      const next = { ...m.heartbeat, ...patch }
      next.everyMinutes =
        Number.isFinite(next.everyMinutes) && next.everyMinutes >= 5
          ? next.everyMinutes
          : DEFAULT_CADENCE_MIN
      next.charter = next.charter.slice(0, MAX_CHARTER)
      // No instant first beat: the OFF→ON transition (Agents toggle or orb
      // resume — both land here) starts the cadence NOW, so the first wake
      // comes one cadence later instead of within 30s of the click. An
      // already-ON heartbeat patched with enabled:true (or a charter edit)
      // keeps its cadence position.
      if (patch.enabled === true && !m.heartbeat.enabled) next.lastBeat = Date.now()
      // EVERY caller of this function is a user action (the Agents switch, the
      // orb's pause/resume, the consent notice's buttons) — the app's own
      // default-on goes through applySetupDefaultOn instead. So an `enabled`
      // in the patch IS the user deciding, and it is recorded as such: that
      // is what makes a "decided off" survive the next launch.
      if (typeof patch.enabled === 'boolean') next.consent = patch.enabled ? 'on' : 'off'
      // The manager flag rides along with the switch the user just used, so
      // the driver's gate and this card agree (withHeartbeatEnabledSynced).
      return { ...m, enabled: next.enabled, heartbeat: next }
    }),
  })
}

/**
 * Setup-completion default-on (2026-08-05 §Part 3 — the always-on manager).
 * Turns the heartbeat ON exactly once, and ONLY for a user who has never
 * decided (see shouldDefaultOn). Two disciplines ride along:
 *
 * - `lastBeat = now`, so the first check comes one full cadence later. A wake
 *   firing within 30s of finishing setup would be exactly the surprise spend
 *   the prior audit removed from the manual enable.
 * - `autoOnAt = now`, which is what raises the consent notice. The flip is not
 *   finished until the user has SEEN it; this field is that obligation.
 *
 * Returns true when it actually flipped (the caller may run it on every
 * render — it is a no-op after the first).
 */
export function applySetupDefaultOn(id: string, now: number): boolean {
  const m = state.managers.find((x) => x.id === id)
  if (!m?.heartbeat || !shouldDefaultOn(m.heartbeat, true)) return false
  setState({
    ...state,
    managers: state.managers.map((x) =>
      x.id === id && x.heartbeat
        ? {
            ...x,
            enabled: true, // the flag follows the switch — see withHeartbeatEnabledSynced
            heartbeat: { ...x.heartbeat, enabled: true, lastBeat: now, autoOnAt: now },
          }
        : x,
    ),
  })
  return true
}

/**
 * The user's answer to the consent notice: `keep` leaves it running, else it
 * goes off right now. Either way a REAL decision is recorded, so the notice
 * never returns and the default-on never fires again. This is the "one-click
 * way to turn it back off" the notice promises.
 */
export function answerHeartbeatNotice(id: string, keep: boolean): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id === id && m.heartbeat
        ? {
            ...m,
            enabled: keep, // the flag follows the switch — see withHeartbeatEnabledSynced
            heartbeat: { ...m.heartbeat, enabled: keep, consent: keep ? 'on' : 'off' },
          }
        : m,
    ),
  })
}

/** Driver outcome: append one REAL beat (recordBeat trims + advances lastBeat)
 *  and persist it — every line the orb/card shows is one of these records. */
export function recordManagerBeat(id: string, beat: Beat): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id === id && m.heartbeat ? { ...m, heartbeat: recordBeat(m.heartbeat, beat) } : m,
    ),
  })
}

/**
 * Record a maintenance-wake SKIP: the store-level sibling of the above, and the
 * only writer of `retryAt`. Kept separate from `recordManagerBeat` so a skip can
 * never be recorded by the path that spends the cadence.
 */
export function recordManagerSkip(id: string, at: number, detail: string): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id === id && m.heartbeat
        ? { ...m, heartbeat: recordSkipBeat(m.heartbeat, at, detail, at + DARK_WAKE_RETRY_MS) }
        : m,
    ),
  })
}

/** Record a FREE rest (unchanged fingerprint — no model ran). Kept separate
 *  from recordManagerBeat for the same reason the skip is: a zero-cost path
 *  must never ride the mutator that settles a real beat's bookkeeping. */
export function recordManagerRest(id: string, at: number): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id === id && m.heartbeat ? { ...m, heartbeat: recordRestBeat(m.heartbeat, at) } : m,
    ),
  })
}

/** Stamp the state print a REAL wake just ran over. Written only after the
 *  model actually answered — see Heartbeat.lastPrint for why. */
export function setHeartbeatPrint(id: string, print: { hash: string; at: number }): void {
  setState({
    ...state,
    managers: state.managers.map((m) =>
      m.id === id && m.heartbeat ? { ...m, heartbeat: { ...m.heartbeat, lastPrint: print } } : m,
    ),
  })
}

let seq = 0
export function addJob(
  managerId: string,
  title: string,
  department: string,
  prompt: string,
  everyMinutes: number,
  kind: 'report' | 'dispatch' | 'team' = 'report',
  approval: 'ask' | 'auto' = 'ask',
  roster = '',
  tokenBudget = 0,
): void {
  const job: ManagerJob = {
    id: `job-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    managerId,
    title: title.trim(),
    department: department.trim() || 'general',
    prompt: prompt.trim(),
    everyMinutes: Math.max(5, everyMinutes),
    lastRun: 0,
    runs: [],
    kind,
    approval,
    pendingSince: 0,
    approvedAt: 0,
    roster,
    tokenBudget,
  }
  setState({ ...state, jobs: [job, ...state.jobs] })
}

export function removeJob(id: string): void {
  setState({ ...state, jobs: state.jobs.filter((j) => j.id !== id) })
}

export function recordJobRun(id: string, at: number, ok: boolean, summary: string): void {
  setState({
    ...state,
    jobs: state.jobs.map((j) =>
      j.id === id
        ? {
            ...j,
            lastRun: at,
            pendingSince: 0,
            approvedAt: 0,
            runs: [{ at, ok, summary }, ...j.runs].slice(0, MAX_RUNS),
          }
        : j,
    ),
  })
}

/** Driver-internal: park an 'ask' dispatch until the user decides. */
export function parkJob(id: string, at: number): void {
  setState({
    ...state,
    jobs: state.jobs.map((j) => (j.id === id ? { ...j, pendingSince: at, approvedAt: 0 } : j)),
  })
}

export function approveDispatch(id: string, at: number): void {
  setState({
    ...state,
    jobs: state.jobs.map((j) => (j.id === id ? { ...j, pendingSince: 0, approvedAt: at } : j)),
  })
}

/** A rejection is not a run: reschedule quietly via lastRun, record nothing. */
export function rejectDispatch(id: string, at: number): void {
  setState({
    ...state,
    jobs: state.jobs.map((j) =>
      j.id === id ? { ...j, pendingSince: 0, approvedAt: 0, lastRun: at } : j,
    ),
  })
}

export function useManagers(): ManagersState {
  return useSyncExternalStore(subscribe, getManagers, getManagers)
}

export function useManagerActions() {
  return {
    ensure: useCallback(ensureSeeded, []),
    setEnabled: useCallback(setManagerEnabled, []),
    addJob: useCallback(addJob, []),
    removeJob: useCallback(removeJob, []),
    approve: useCallback(approveDispatch, []),
    reject: useCallback(rejectDispatch, []),
    updateHeartbeat: useCallback(updateHeartbeat, []),
    answerNotice: useCallback(answerHeartbeatNotice, []),
  }
}


/**
 * Record that the driver's loop is alive. Called at the TOP of every tick,
 * before any guard, so it measures the loop rather than its work.
 */
export function recordDriverTick(now: number): void {
  // Deliberately NOT setState. This fires every 30s for as long as the app is
  // open; going through the normal path would re-serialise the entire manager
  // store — every manager, every job, forty beats — to localStorage AND to
  // disk 2,880 times a day, to save a number that is worthless the moment the
  // app closes. No emit either: nothing should re-render for a heartbeat that
  // changes nothing on screen. The one surface that reports this reads live
  // state on its own slow clock (`useSilenceClock`).
  state = { ...state, lastTick: now }
}

/**
 * How long the driver has been silent, or null when it is beating normally.
 *
 * Three missed ticks is the threshold: one can be lost to a busy engine or a
 * throttled timer, three in a row is a loop that is not running. Returns null
 * when nothing has ever ticked (a fresh install has not failed at anything) so
 * the app never accuses itself on first launch.
 */
export function driverStalled(
  now: number,
  s: ManagersState = state,
  since: number = SESSION_START,
): number | null {
  // Measured from the later of "last tick" and "session start". The floor is
  // what makes the never-ticked case reportable at all: an interval that never
  // mounts writes no lastTick, and without the floor that is arithmetically
  // identical to a fresh install — silent forever, by construction. With it,
  // an app that has been open for two minutes without a single tick says so.
  const from = Math.max(s.lastTick ?? 0, since)
  const silent = now - from
  return silent > DRIVER_TICK_MS * 3 ? silent : null
}

/**
 * The sentence the app says when its own manager has stopped. Plain, specific,
 * and it never guesses at a cause it has not measured.
 */
export function driverStalledLine(silentMs: number): string {
  const mins = Math.round(silentMs / 60_000)
  const when = mins < 60 ? `${mins} minutes` : mins < 60 * 24
    ? `${Math.round(mins / 60)} hours`
    : `${Math.round(mins / (60 * 24))} days`
  return `Your manager has not run for ${when}. Nothing is waking it — open Automations to restart it.`
}
