// SC Prism — honest run budgets, measured from what THIS machine really does,
// and honest words for the three ways a run can end without an answer.
//
// WHY THIS EXISTS (the failure that produced it, 2026-08-16)
// ---------------------------------------------------------
// A project interview ran: `opus` cloud 27.0s, `opus` cloud 27.2s, a
// `vault·vault_read` tool call, then `Qwen3.8-27B-4bit` LOCAL 64.8s and 67.5s —
// ~187s of work, every call answering, against a FLAT 90s client wall. We killed
// it, and then told the user "no real reply — timed out or the AI could not be
// reached" and "Couldn't reach the AI just now". Both were false. The AI
// answered every call; WE cancelled it.
//
// Two causes, and this module is the fix for both halves' shared machinery:
//
// 1. The 90s wall was set when every turn was cloud-fast. It ignores the VAULT
//    EGRESS FLOOR (`loop.VAULT_LOCAL_REASON`, 12ba45c): the moment a run reads
//    vault content, the REMAINDER of that run is pinned to the local model. That
//    floor is the privacy guarantee and is NOT weakened here — nothing in this
//    file routes anything. Instead the BUDGET learns what local costs on this
//    machine and pays it.
//
// 2. Our own cancellation was reported as the provider failing. The stop copy
//    below names the three endings apart: WE cancelled (and what it was doing),
//    the provider could not be reached, the engine returned a placeholder.
//
// THE BUDGET DESIGN, and why this one
// -----------------------------------
// Three candidates were on the table:
//   (a) multiply the flat wall when a run is (or may become) local-routed;
//   (b) measure a rolling per-provider latency and budget from that;
//   (c) bound each TURN (each model call) rather than the whole exchange.
// (a) alone is a guess that still breaks whenever the local model changes, and a
// multiplier big enough for a 5-call local exchange is exactly the "huge constant
// that hides a real stall" we must not ship. (b) alone still fails by
// construction: a flat wall sized for ONE typical call cannot hold an exchange of
// five, and a wall sized for five hides a stall in the first one.
//
// So this is (b) + (c): a STALL bound sized from measured per-route latency, that
// the run may re-earn each time the engine demonstrably finishes a step, under an
// absolute ceiling.
//   * `stallMs` — how long we wait with NOTHING new finishing. Derived from the
//     90th-percentile duration of recent real model calls on the slower of the
//     two routes this run could take (a run that has not read the vault yet still
//     MIGHT, so we budget for local). A stall is therefore defined against this
//     machine's own numbers, not a magic constant.
//   * progress — the engine appends a span to spans.jsonl when a step CLOSES.
//     A new closed step is proof the run is alive, and buys another `stallMs`.
//     No progress for a whole `stallMs` is a real stall and is cancelled.
//   * `ceilingMs` — the absolute wall, so even a run that keeps producing steps
//     cannot run forever.
// With no measurements at all (fresh install) the numbers collapse to exactly the
// old 90s stall, so nothing regresses on a machine we know nothing about.

import type { EngineSpan } from './nativeEngine'

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Durations above this are NOT latency — they are the Mac having slept through
 * a call. Real evidence from the user's own spans.jsonl: single `model_call`
 * spans of 46,863s and 18,073s (13 and 5 hours) straddling darkwake, next to
 * ordinary 65s ones. Averaging those in would produce a budget of hours, which
 * would hide every real stall forever. They are dropped, never smoothed.
 */
export const SUSPEND_OUTLIER_MS = 900_000

/** Rolling window: only the most recent N calls per route count, so replacing a
 *  slow local model is reflected within a handful of runs. */
export const LATENCY_WINDOW = 40

/** Per-call assumption when nothing has been measured yet. Chosen so the derived
 *  stall is exactly the historical 90s wall — a machine we know nothing about is
 *  treated exactly as before. */
export const DEFAULT_PER_CALL_MS = 60_000

/** A measured p90 is multiplied by this before it becomes a stall bound: one
 *  worst-normal call, plus half of one again for scheduling noise. */
export const STALL_SLACK = 1.5

/** Floor — never wait less than the historical flat wall. */
export const MIN_STALL_MS = 90_000
/** Cap — beyond this, "still nothing finished" is a stall whatever the model. */
export const MAX_STALL_MS = 300_000
/** Absolute wall for one exchange, however much progress it keeps making.
 *  Sized for a person sitting in front of the app: ten minutes of watching a
 *  spinner is already past the point where an honest stop beats a longer wait. */
export const ABS_CEILING_MS = 600_000

/**
 * The same wall for work NOBODY IS WAITING ON — a background heartbeat wake.
 *
 * The ceiling above is a patience budget, and patience is a property of the
 * person waiting. There is no person here: the wake runs on its own cadence
 * while the user is elsewhere, so the only thing a short ceiling buys is a
 * killed run and an empty hour. Measured on Sukhdeep's Mac, a wake that
 * actually finishes its work takes eleven to fifteen minutes on his local
 * model — over the interactive ceiling, and the reason every beat died.
 *
 * Twenty minutes leaves headroom above the slowest wake observed without ever
 * letting a genuinely wedged run hold the engine slot for the whole hour.
 */
export const UNATTENDED_CEILING_MS = 1_200_000
/** How many stall windows the ceiling allows before it bites. */
export const CEILING_STALLS = 4

/** A local model this slow will threaten budgets, and the user deserves to be
 *  told the measured number before he meets it as a mystery failure. */
export const SLOW_LOCAL_MS = 60_000

export type RunRoute = 'local' | 'cloud'

/** Measured latency for one route, over the rolling window. */
export interface RouteLatency {
  route: RunRoute
  /** The model most of these samples ran on ('' when mixed/unknown). */
  model: string
  samples: number
  p50Ms: number
  p90Ms: number
}

export interface LatencyStats {
  local: RouteLatency | null
  cloud: RouteLatency | null
}

export const EMPTY_LATENCY: LatencyStats = { local: null, cloud: null }

/** Percentile of an ASCENDING array of numbers. 0 for an empty one. */
export function pct(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const i = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * p))
  return sortedMs[i]
}

function routeOf(attrs: Record<string, unknown> | undefined): RunRoute | null {
  if (!attrs) return null
  const r = attrs.route
  if (r === 'local' || r === 'cloud') return r
  if (typeof attrs.is_local === 'boolean') return attrs.is_local ? 'local' : 'cloud'
  return null
}

function modelOf(attrs: Record<string, unknown> | undefined): string {
  const m = attrs?.model
  return typeof m === 'string' ? m : ''
}

/**
 * ONE `model_call` span, reduced to the facts a measurement may use.
 * `tokensOut`/`isReal` are the span's own attrs — absent means unknown, never
 * assumed (a reader that needs them must say so, see `modelCallSamples`).
 */
export interface ModelCallSample {
  ms: number
  model: string
  route: RunRoute
  tokensOut: number | null
  /** The gateway's `is_real` attr: false = a stub/placeholder, not a completion. */
  isReal: boolean | null
}

/**
 * THE span filter — the single place a `model_call` span becomes a usable
 * measurement, so every reader inherits the same rules and the same outlier
 * drop. Both `latencyFromSpans` (the run budget) and the local-model picker
 * read through this: there is exactly one measurement of local speed in the
 * app, not two that can disagree.
 *
 * Dropped here, always: non-`model_call` spans, non-positive/absent durations,
 * routeless spans, and anything longer than `SUSPEND_OUTLIER_MS` (the Mac slept
 * mid-call — 13-hour "latencies" are real in this vault and would poison every
 * average that touched them).
 */
export function modelCallSamples(spans: EngineSpan[]): ModelCallSample[] {
  const out: ModelCallSample[] = []
  for (const s of spans) {
    if (s.type !== 'model_call') continue
    const ms = s.duration_ms
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) continue
    if (ms > SUSPEND_OUTLIER_MS) continue // slept-through call, not latency
    const route = routeOf(s.attrs)
    if (!route) continue
    const rawOut = s.attrs?.tokens_out
    const rawReal = s.attrs?.is_real
    out.push({
      ms,
      model: modelOf(s.attrs),
      route,
      tokensOut: typeof rawOut === 'number' && Number.isFinite(rawOut) && rawOut > 0 ? rawOut : null,
      isReal: typeof rawReal === 'boolean' ? rawReal : null,
    })
  }
  return out
}

/**
 * Roll up real `model_call` spans into per-route latency.
 *
 * `preferLocalModel` is the local model the app is CONFIGURED to use right now.
 * When it has samples of its own they are used alone — budgeting the model that
 * will actually run, not an average across every local model ever configured
 * (the user's vault holds three, from 5s to 300s a call).
 *
 * Pure: takes spans, returns numbers. It reads routing, it never sets it.
 */
export function latencyFromSpans(spans: EngineSpan[], preferLocalModel = ''): LatencyStats {
  const by: Record<RunRoute, ModelCallSample[]> = { local: [], cloud: [] }
  for (const sample of modelCallSamples(spans)) by[sample.route].push(sample)

  const summarize = (route: RunRoute): RouteLatency | null => {
    let rows = by[route]
    if (route === 'local' && preferLocalModel) {
      const mine = rows.filter((r) => r.model === preferLocalModel)
      if (mine.length > 0) rows = mine
    }
    rows = rows.slice(-LATENCY_WINDOW)
    if (rows.length === 0) return null
    const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
    const models = new Set(rows.map((r) => r.model).filter(Boolean))
    return {
      route,
      model: models.size === 1 ? [...models][0] : '',
      samples: rows.length,
      p50Ms: Math.round(pct(sorted, 0.5)),
      p90Ms: Math.round(pct(sorted, 0.9)),
    }
  }

  return { local: summarize('local'), cloud: summarize('cloud') }
}

/** The newest closed engine step — evidence of what a run was doing, used both
 *  as the progress token and to say so in the stop message. */
export interface EngineStep {
  /** Span start (epoch seconds, as telemetry writes it). Monotone per step, so
   *  a CHANGE in this value is proof another step closed. */
  at: number
  route?: RunRoute
  model?: string
  name?: string
}

/** Newest closed step from a span tail (any span type — a tool call closing is
 *  progress too). `null` when the tail carries nothing usable. */
export function lastStepFromSpans(spans: EngineSpan[]): EngineStep | null {
  let best: EngineStep | null = null
  for (const s of spans) {
    if (typeof s.start !== 'number' || !Number.isFinite(s.start)) continue
    if (best && s.start <= best.at) continue
    best = {
      at: s.start,
      route: routeOf(s.attrs) ?? undefined,
      model: modelOf(s.attrs) || undefined,
      name: s.name,
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface TurnBudget {
  /** Wait this long with NOTHING finishing before calling it a stall. */
  stallMs: number
  /** Absolute wall for the whole exchange, however much progress it makes. */
  ceilingMs: number
  /** The per-call number the stall was derived from. */
  perCallMs: number
  /** Whether the derivation came from real measurements or the default. */
  measured: boolean
  /** One plain sentence naming where these numbers came from. */
  basis: string
  /** Typical (p50) local call, when measured — for the stop message's evidence. */
  localTypicalMs?: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`

/**
 * Budget one exchange from measured latency.
 *
 * The per-call figure is the SLOWER of the two routes, deliberately: a run that
 * has not read the vault yet still might, and the egress floor then pins the
 * rest of it local. Budgeting for the fast route and killing the run when the
 * floor does its job is exactly the bug this replaces. Nothing here changes
 * WHERE a call goes — only how long we are willing to wait for it.
 */
export function turnBudget(stats: LatencyStats): TurnBudget {
  const localP90 = stats.local?.p90Ms ?? 0
  const cloudP90 = stats.cloud?.p90Ms ?? 0
  const measured = localP90 > 0 || cloudP90 > 0
  const perCallMs = measured ? Math.max(localP90, cloudP90) : DEFAULT_PER_CALL_MS
  const stallMs = clamp(Math.round(perCallMs * STALL_SLACK), MIN_STALL_MS, MAX_STALL_MS)
  const ceilingMs = Math.min(stallMs * CEILING_STALLS, ABS_CEILING_MS)

  const slowest = localP90 >= cloudP90 ? stats.local : stats.cloud
  const basis = measured && slowest
    ? `measured: ${slowest.route === 'local' ? 'your local model' : 'your cloud model'}` +
      `${slowest.model ? ` (${slowest.model})` : ''} takes up to ${secs(slowest.p90Ms)} a call ` +
      `over its last ${slowest.samples} call${slowest.samples === 1 ? '' : 's'}`
    : `no calls measured yet — using the ${secs(DEFAULT_PER_CALL_MS)} default per call`

  return {
    stallMs,
    ceilingMs,
    perCallMs,
    measured,
    basis,
    localTypicalMs: stats.local?.p50Ms,
  }
}

/** The budget used when nothing has been measured — exactly the historical wall. */
export const DEFAULT_TURN_BUDGET: TurnBudget = turnBudget(EMPTY_LATENCY)

/**
 * FIX 3 — the measured warning, offered BEFORE the user meets it as a mystery.
 * Returns '' unless the configured local model is genuinely slow enough to
 * threaten a budget. Purely factual: the numbers are its own measurements, and
 * the consequence stated (vault reads stay local) is the egress floor's
 * documented behaviour, not advice.
 */
export function slowLocalNotice(stats: LatencyStats): string {
  const l = stats.local
  if (!l || l.p90Ms < SLOW_LOCAL_MS) return ''
  const name = l.model ? `Your local model (${l.model})` : 'Your local model'
  return (
    `${name} is measured at about ${secs(l.p50Ms)} per call ` +
    `(up to ${secs(l.p90Ms)}) over its last ${l.samples} call${l.samples === 1 ? '' : 's'}. ` +
    `Anything that reads your vault stays on this model for the rest of that run — ` +
    `so those runs take minutes, not seconds. That is the privacy floor doing its job, not a fault.`
  )
}

// ---------------------------------------------------------------------------
// The bounded wait
// ---------------------------------------------------------------------------

export type BudgetOutcome<T> =
  | { done: true; value: T }
  | { done: false; elapsedMs: number; reason: 'stalled' | 'ceiling' }

export interface WaitOptions {
  stallMs: number
  ceilingMs: number
  /** Monotone progress token — a CHANGE means another engine step closed. When
   *  omitted the wait degrades to a single flat `stallMs` wall (browser/tests). */
  progress?: () => Promise<number | null> | number | null
  now?: () => number
}

/**
 * Wait for `work`, cancelling only when the run stops making progress or hits
 * its ceiling. Never cancels a run that is demonstrably still finishing steps
 * inside its stall window; never waits forever for one that isn't.
 *
 * The caller does the actual killing (`cancelEngineRun`) — this returns the
 * decision plus the honest elapsed time, and nothing else.
 *
 * `work`'s rejection is re-thrown at the await point, exactly as a bare race
 * did. `work` is wrapped ONCE, so bailing out early can never leave an
 * unhandled rejection behind when the abandoned promise settles later.
 */
export async function waitWithBudget<T>(work: Promise<T>, opts: WaitOptions): Promise<BudgetOutcome<T>> {
  const now = opts.now ?? (() => Date.now())
  const started = now()
  const ceilingAt = started + Math.max(opts.ceilingMs, opts.stallMs)
  let deadline = started + opts.stallMs

  const wrapped: Promise<{ tag: 'work'; value: T } | { tag: 'err'; error: unknown }> = work.then(
    (value) => ({ tag: 'work' as const, value }),
    (error: unknown) => ({ tag: 'err' as const, error }),
  )

  const probe = async (): Promise<number | null> => {
    if (!opts.progress) return null
    try {
      return (await opts.progress()) ?? null
    } catch {
      return null
    }
  }

  let seen = await probe()

  for (;;) {
    const waitMs = Math.max(0, Math.min(deadline, ceilingAt) - now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = new Promise<{ tag: 'tick' }>((resolve) => {
      timer = setTimeout(() => resolve({ tag: 'tick' as const }), waitMs)
    })
    const r = await Promise.race([wrapped, tick])
    if (timer !== undefined) clearTimeout(timer)

    if (r.tag === 'work') return { done: true, value: r.value }
    if (r.tag === 'err') throw r.error

    const at = now()
    if (at >= ceilingAt) return { done: false, elapsedMs: at - started, reason: 'ceiling' }

    const p = await probe()
    if (p !== null && seen !== null && p !== seen) {
      // A step closed while we waited: the run is alive, so it earns another
      // stall window (still under the ceiling).
      seen = p
      deadline = at + opts.stallMs
      continue
    }
    if (p !== null && seen === null) {
      // First reading arrived late — treat it as the baseline, not as progress.
      seen = p
      deadline = at + opts.stallMs
      continue
    }
    return { done: false, elapsedMs: at - started, reason: 'stalled' }
  }
}

// ---------------------------------------------------------------------------
// The three honest endings
// ---------------------------------------------------------------------------

export interface StopFacts {
  elapsedMs: number
  reason: 'stalled' | 'ceiling'
  stallMs: number
  ceilingMs: number
  /** The newest step we could see when we pulled the plug, if any. */
  lastStep?: EngineStep
  /** Typical local call time, when measured. */
  localTypicalMs?: number
}

/** The clause that names what the run was doing, from real span evidence only.
 *  No evidence → no claim. */
function evidenceClause(f: StopFacts): string {
  const step = f.lastStep
  if (!step || !step.route) return ''
  const named = step.model ? ` (${step.model})` : ''
  if (step.route === 'local') {
    const typical = f.localTypicalMs && f.localTypicalMs > 0 ? `, which averages ${secs(f.localTypicalMs)} a call here` : ''
    return (
      ` The last step we saw ran on your local model${named}${typical}` +
      ` — reading your vault keeps the rest of a run local, so it runs at local speed.`
    )
  }
  return ` The last step we saw ran in the cloud${named}.`
}

/**
 * (a) WE cancelled it. The first clause exists to kill the old lie outright:
 * the user must never again read "could not be reached" about a model that was
 * answering. Says how long, says who stopped it, says what it was doing.
 */
export function cancelledText(f: StopFacts): string {
  const head =
    f.reason === 'ceiling'
      ? `Stopped after ${secs(f.elapsedMs)} — we cancelled this run at its ${secs(f.ceilingMs)} ceiling. The AI did not fail and was not unreachable.`
      : `Stopped after ${secs(f.elapsedMs)} — we cancelled this run. The AI did not fail and was not unreachable.`
  const why =
    f.reason === 'ceiling'
      ? ` It was still working when we stopped it, but it had used the whole budget for one exchange.`
      : ` Nothing new finished in the last ${secs(f.stallMs)}, which is longer than a call normally takes here, so it looked stuck.`
  return `${head}${why}${evidenceClause(f)} Send again to retry.`
}

/** (a) again, in one line for a run row. */
export function cancelledDetail(f: StopFacts): string {
  const where =
    f.lastStep?.route === 'local'
      ? ' — your local model was still answering'
      : f.lastStep?.route === 'cloud'
        ? ' — the cloud model was still answering'
        : ''
  const cause = f.reason === 'ceiling' ? `hit its ${secs(f.ceilingMs)} ceiling` : `nothing finished for ${secs(f.stallMs)}`
  return `we stopped it at ${secs(f.elapsedMs)} (${cause})${where} — our cancellation, not a provider failure`
}

/**
 * The short, shared form of (a) for the background runs that keep a flat wall
 * (wake, manager job, standing loop, team). They cannot say what the model was
 * doing — no span evidence is captured on those paths — but they can and must
 * say that the stop was OURS. `extra` adds a run-specific, clearly hedged note.
 */
export function weStoppedIt(afterMs: number, extra = ''): string {
  return `we stopped it at ${secs(afterMs)} — our own wall, not a provider failure${extra ? ` (${extra})` : ''}`
}

/** (b) The provider genuinely could not be reached: nothing came back at all. */
export const UNREACHABLE_TEXT =
  'Couldn’t reach the AI — the run ended with no reply at all. This was not a timeout and nothing was cancelled: the provider gave us nothing. Check the provider in Settings, then try again.'

/** (b) in one line for a run row. */
export const UNREACHABLE_DETAIL = 'no reply came back at all — the provider could not be reached'

/** (c) The provider returned a stub — an `[offline:…]` / `[stub:…]` placeholder
 *  rather than a model completion. `reason` is the ENGINE's own words when it
 *  gave any (see AppStore `offlineReason`); '' for the bare deterministic stub,
 *  which has no cause to name beyond "there was nothing real to call".
 *
 *  (d) is checked FIRST: a local model that could not be LOADED is its own
 *  ending, and calling it a placeholder-because-no-provider would repeat the
 *  exact lie this fix exists to kill. */
export function stubText(reason: string): string {
  if (isLoadFailure(reason)) return loadFailedText(reason)
  return reason
    ? `No real AI reply — the engine returned a placeholder and said: “${reason}”. Nothing was cancelled here and the model was not slow.`
    : 'No real AI reply — the engine returned a placeholder because there was no real provider to call. Nothing was cancelled here and the model was not slow. Connect a provider in Settings, then try again.'
}

/** (c) in one line for a run row. */
export function stubDetail(reason: string): string {
  if (isLoadFailure(reason)) return loadFailedDetail(reason)
  return reason ? `placeholder reply — ${reason}` : 'placeholder reply — no real provider was available to call'
}

// ---------------------------------------------------------------------------
// (d) The FOURTH ending — the local model could not be LOADED
// ---------------------------------------------------------------------------
//
// The local server answered instantly and said no: HTTP 507, "projected memory
// 42.36GB would exceed the metal_cap memory ceiling 24.96GB". Nothing was
// unreachable, nothing was slow, nothing was cancelled — the model simply does
// not fit beside what is already resident. Until now the engine swallowed that
// status into the deterministic offline stub and the app told the user his
// provider was unreachable, which sent him looking for a network fault that did
// not exist.
//
// The ENGINE names this cause (gateway.py `_load_failed` / the Go gateway's
// `loadFailureReason`) with the marker below, and this is the only place the
// app turns that marker into words. The numbers in the sentence are the
// server's own, forwarded verbatim — nothing here estimates a footprint.

/** The engine's marker for "the local model could not be loaded". Must match
 *  gateway.py's `LOAD_FAILED_MARK` and provider.go's `loadFailedMark`. */
export const LOAD_FAILED_MARK = 'local model could not load'

/** True when an engine reason names a local model that could not be loaded. */
export function isLoadFailure(reason: string): boolean {
  return reason.toLowerCase().includes(LOAD_FAILED_MARK)
}

/** The server's own detail, after the marker (e.g. "not enough GPU memory — …"). */
function loadFailureDetail(reason: string): string {
  const i = reason.toLowerCase().indexOf(LOAD_FAILED_MARK)
  const tail = i < 0 ? reason : reason.slice(i + LOAD_FAILED_MARK.length)
  return tail.replace(/^\s*[:—-]\s*/, '').trim()
}

/** (d) The full sentence. Says what failed, quotes the server's numbers, and
 *  says plainly that this is NOT an outage — because the app used to claim it
 *  was. */
export function loadFailedText(reason: string): string {
  const detail = loadFailureDetail(reason)
  return (
    `Your local model couldn’t load${detail ? `: ${detail}` : ''}. ` +
    `Unload a model in your local server (oMLX), or pick one that fits in Settings → Local model, then try again. ` +
    `The server was reachable and answered — this is not an outage, and nothing was cancelled.`
  )
}

/** (d) in one line for a run row. */
export function loadFailedDetail(reason: string): string {
  const detail = loadFailureDetail(reason)
  return `your local model couldn’t load${detail ? ` — ${detail}` : ''} (the server answered; it was not unreachable)`
}
