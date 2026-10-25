// SC Prism — choosing a local model on EVIDENCE (2026-08-17).
//
// WHY THIS EXISTS
// ---------------
// The local picker was a bare list of ids. Sukhdeep has three local models with
// wildly different behaviour and no way to tell them apart, so he ran the
// SLOWEST one for days (115s p50) while a faster, stronger one sat unused (9.8s
// p50). A fourth failure mode — a model that cannot LOAD at all — reached him as
// "the provider is unreachable" (see runBudget's fourth ending).
//
// THE RULE THIS FILE ENFORCES: every number a row shows is traceable to
//   * a `model_call` span in his own vault (speed),
//   * a Tier-2 judge verdict on his own work (quality), or
//   * the local server's own `/v1/models/status` report (size, ceiling, load
//     rate),
// and the row says WHICH. There are no vendor claims here, no parameter-count
// heuristics, and no rankings invented from names. A model with no recorded
// runs gets NO speed figure, NO quality figure, and is NOT ranked — it is never
// described as better or worse than one he has actually run.
//
// Pure: spans + verdicts + the server's report in, view-model out. No I/O, so
// every rule below is unit-testable without a server or a vault.

import type { Verdict } from '../engine/types'
import type { EngineSpan } from './nativeEngine'
import { LATENCY_WINDOW, modelCallSamples, pct } from './runBudget'

// ---------------------------------------------------------------------------
// The server's own report (/v1/models/status)
// ---------------------------------------------------------------------------

/**
 * What the local server says about itself. Every field is optional because the
 * server may not report it — and an ABSENT field must stay absent all the way
 * to the UI, which then says "the server didn't report this" rather than
 * showing a number nobody measured.
 *
 * Verified live on this machine (oMLX): `load_seconds_per_gb_estimate`,
 * per-model sizes, `final_ceiling` and `current_model_memory`.
 */
export interface LocalServerStatus {
  /** Hard memory ceiling for models, in GB (`final_ceiling`). */
  ceilingGb: number | null
  /** GB already held by resident model(s) (`current_model_memory`). */
  residentGb: number | null
  /** The server's OWN load-rate estimate, seconds per GB. An estimate, labelled as one. */
  loadSecondsPerGb: number | null
  /** model id -> its size in GB, as the server reports it. */
  sizeGb: Record<string, number>
  /** model ids the server says are resident right now. */
  resident: string[]
}

export const EMPTY_STATUS: LocalServerStatus = {
  ceilingGb: null,
  residentGb: null,
  loadSecondsPerGb: null,
  sizeGb: {},
  resident: [],
}

/** The status endpoint for a local base URL (trailing slashes tolerated). */
export function modelStatusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/models/status`
}

/**
 * Unit normalization, and ONLY that: servers report GB floats (oMLX does:
 * "projected memory 42.36GB"), but a byte count is possible. Anything at or
 * above a million is read as bytes; everything else is taken as GB, as written.
 * Never a capability claim — just the same quantity in one unit.
 */
function toGb(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return v >= 1e6 ? v / 1024 ** 3 : v
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

const CEILING_KEYS = ['final_ceiling', 'memory_ceiling', 'ceiling_gb', 'ceiling']
const RESIDENT_KEYS = ['current_model_memory', 'resident_memory', 'used_memory']
const LOAD_RATE_KEYS = ['load_seconds_per_gb_estimate', 'load_seconds_per_gb']
const SIZE_KEYS = ['size_gb', 'memory_gb', 'model_size_gb', 'estimated_memory', 'model_size', 'size']
const ID_KEYS = ['id', 'model', 'model_id', 'name']

/**
 * Parse `/v1/models/status`. Deliberately TOLERANT about where a field sits
 * (top level or nested under `memory` / `status` / `server`) and STRICT about
 * inventing: a key that is not there yields `null`, never a default. A body we
 * cannot parse at all yields `null` — the caller then shows no memory figures
 * rather than plausible ones.
 */
export function parseModelStatus(raw: string): LocalServerStatus | null {
  let root: unknown
  try {
    root = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(root)) return null

  const out: LocalServerStatus = { ...EMPTY_STATUS, sizeGb: {}, resident: [] }

  // Walk a bounded tree looking for the scalars, wherever the server put them.
  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || !isRecord(node)) return
    for (const key of CEILING_KEYS) {
      if (out.ceilingGb === null && key in node) out.ceilingGb = toGb(node[key])
    }
    for (const key of RESIDENT_KEYS) {
      if (out.residentGb === null && key in node) out.residentGb = toGb(node[key])
    }
    for (const key of LOAD_RATE_KEYS) {
      if (out.loadSecondsPerGb === null && key in node) out.loadSecondsPerGb = num(node[key])
    }
    for (const v of Object.values(node)) {
      if (isRecord(v)) visit(v, depth + 1)
    }
  }
  visit(root, 0)

  // Model entries: an array under `models`/`data`, or an id-keyed object.
  const entries: [string, unknown][] = []
  const list = root.models ?? root.data
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!isRecord(item)) continue
      const idKey = ID_KEYS.find((k) => typeof item[k] === 'string')
      if (!idKey) continue
      entries.push([String(item[idKey]), item])
    }
  } else if (isRecord(list)) {
    for (const [id, item] of Object.entries(list)) entries.push([id, item])
  }

  for (const [id, item] of entries) {
    if (!isRecord(item)) continue
    for (const key of SIZE_KEYS) {
      if (key in item) {
        const gb = toGb(item[key])
        if (gb !== null) {
          out.sizeGb[id] = gb
          break
        }
      }
    }
    if (item.loaded === true || item.resident === true || item.status === 'loaded') {
      out.resident.push(id)
    }
  }

  // A single "which model is up" field, however the server names it.
  for (const key of ['current_model', 'loaded_model', 'active_model']) {
    const v = root[key]
    if (typeof v === 'string' && v && !out.resident.includes(v)) out.resident.push(v)
  }

  return out
}

// ---------------------------------------------------------------------------
// Measured speed — from this vault's own spans
// ---------------------------------------------------------------------------

/** What his own runs prove about one model's speed. Never extrapolated. */
export interface ModelSpeed {
  /** How many real local calls on THIS model the window holds. */
  samples: number
  p50Ms: number
  p90Ms: number
  /** Output tokens per second, when the spans recorded token counts; else null. */
  tokensPerSec: number | null
}

/**
 * Speed for ONE model id, from `model_call` spans.
 *
 * Reuses `modelCallSamples` — the app's single span filter — so this inherits
 * the >15-minute SUSPEND drop (the Mac slept mid-call; 13-hour "latencies" are
 * real in this vault) and the same route reading, byte for byte, as the run
 * budget. There is one measurement of local speed in this app, not two.
 *
 * Two extra gates here, both of which can only REMOVE samples:
 *   * the span's model must EQUAL this id — a run on another local model is not
 *     evidence about this one (this is why the picker cannot reuse
 *     `latencyFromSpans`'s preferred-model fallback, which widens to every
 *     local call when the preferred model has none of its own);
 *   * `is_real === false` spans are dropped: that is a stub/placeholder, and
 *     timing a placeholder would report a model as instantaneous.
 * No samples → `null`, which the UI renders as "no runs recorded yet".
 */
export function speedForModel(spans: EngineSpan[], model: string): ModelSpeed | null {
  if (!model) return null
  const rows = modelCallSamples(spans)
    .filter((s) => s.route === 'local' && s.model === model && s.isReal !== false)
    .slice(-LATENCY_WINDOW)
  if (rows.length === 0) return null
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b)
  const timed = rows.filter((r) => r.tokensOut !== null)
  const totalTokens = timed.reduce((n, r) => n + (r.tokensOut ?? 0), 0)
  const totalSecs = timed.reduce((n, r) => n + r.ms / 1000, 0)
  return {
    samples: rows.length,
    p50Ms: Math.round(pct(sorted, 0.5)),
    p90Ms: Math.round(pct(sorted, 0.9)),
    tokensPerSec: totalSecs > 0 && totalTokens > 0 ? totalTokens / totalSecs : null,
  }
}

// ---------------------------------------------------------------------------
// Measured quality — the Tier-2 judge, on his own work
// ---------------------------------------------------------------------------

/** What the judge recorded about one model. The only "better at thinking"
 *  signal this app owns, and it is measured on his real runs. */
export interface ModelQuality {
  runs: number
  /** Mean Tier-2 eval score (0..1) over those runs. */
  mean: number
}

/**
 * Did the Tier-2 judge actually RUN on this verdict?
 *
 * It matters because `mapVerdict` writes `evalScore: 0` when Tier-2 was
 * short-circuited (Tier-1 failed, or there was nothing to judge). Averaging
 * those zeros in would invent a bad reviewer score for runs no reviewer ever
 * looked at — the mirror image of the lie this feature exists to stop.
 * `trajectory === 'trajectory ok'` is written exactly when the engine reported
 * `tier2.ran`; the enrichment fields are the same evidence from the other side.
 */
function judgeRan(v: Verdict): boolean {
  const t2 = v.tier2
  if (!t2) return false
  return (
    t2.trajectory === 'trajectory ok' ||
    t2.metrics !== undefined ||
    t2.judgeNotes !== undefined ||
    t2.envelopeOk !== undefined
  )
}

/**
 * Attribute a verdict to a LOCAL model — the same idiom as `agents.ts`'s
 * `attributesTo`, and the same discipline:
 *   * only `native.models_used` counts. A sim verdict (no `native`) is NEVER
 *     attributed to anything — it did not happen on this model, or any model.
 *   * the entry's provider part must be a local one, and its MODEL part must
 *     EQUAL this id (case-insensitively). `attributesTo` matches a family by
 *     substring because an agent names a family; a model row names one exact
 *     model, so a substring match here would let `qwen3-8b` claim `qwen3-8b-4bit`'s
 *     runs.
 * `attributesTo`'s TIME gate has no analogue here and none is faked: a run that
 * literally recorded this model id ran on this model, whenever it happened.
 */
export function verdictRanOnModel(v: Verdict, model: string): boolean {
  const used = v.native?.models_used
  if (!used || used.length === 0 || !model) return false
  const want = model.trim().toLowerCase()
  return used.some((label) => {
    const [provider, name] = label.split(' · ').map((s) => s.trim().toLowerCase())
    if (!name) return false
    return provider.includes('local') && name === want
  })
}

/** The judge's mean score for one model, or `null` when it never judged one. */
export function qualityForModel(verdicts: readonly Verdict[], model: string): ModelQuality | null {
  const scores: number[] = []
  for (const v of verdicts) {
    if (!verdictRanOnModel(v, model)) continue
    if (!judgeRan(v)) continue
    const s = v.tier2?.evalScore
    if (typeof s !== 'number' || !Number.isFinite(s)) continue
    scores.push(s)
  }
  if (scores.length === 0) return null
  return { runs: scores.length, mean: scores.reduce((a, b) => a + b, 0) / scores.length }
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

/** Whether this model can be loaded RIGHT NOW, from the server's own figures. */
export type ModelFit = 'fits' | 'resident' | 'wont-load' | 'unknown'

export interface LocalModelRow {
  id: string
  /** Has real evidence (runs recorded). Only a measured row is ranked. */
  measured: boolean
  ranked: boolean
  speed: ModelSpeed | null
  quality: ModelQuality | null
  /** The server's reported size, GB. null = the server didn't say. */
  sizeGb: number | null
  /** size × the server's own seconds-per-GB estimate. An ESTIMATE, labelled. */
  loadEstimateSec: number | null
  fit: ModelFit
  /** The memory arithmetic in words, from the server's numbers only. '' when unknown. */
  fitLine: string
  /** One line derived from THIS row's numbers, naming its basis. */
  suggestion: string
}

export interface LocalModelReport {
  rows: LocalModelRow[]
  /** The recommendation, naming its basis. '' when the evidence doesn't support one. */
  recommendation: string
  /** One line about the evidence as a whole (e.g. nothing measured yet). */
  note: string
}

export interface LocalModelInput {
  /** Model ids the local server lists, in its own order. */
  models: readonly string[]
  spans: EngineSpan[]
  verdicts: readonly Verdict[]
  status: LocalServerStatus | null
  /** The model currently configured, so a row can say "in use". */
  selected?: string
}

// `gb` / `runs` / `speedClause` are exported for ONE reader only: the per-kind
// pick (localModelPick.ts), so a pick's reason and a row's fact line spell the
// same measurement the same way. One formatter, not two drifting copies.
export const gb = (v: number): string => `${v >= 10 ? Math.round(v) : v.toFixed(1)} GB`
const secs = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)
const tok = (t: number): string => (t >= 10 ? `${Math.round(t)} tok/s` : `${t.toFixed(1)} tok/s`)
export const runs = (n: number): string => `${n} run${n === 1 ? '' : 's'}`

/** The speed clause a row is entitled to: tokens/sec when the spans recorded
 *  tokens, else the latency it definitely knows. Never both invented. */
export function speedClause(s: ModelSpeed): string {
  return s.tokensPerSec !== null
    ? `${tok(s.tokensPerSec)} over ${runs(s.samples)}`
    : `${secs(s.p50Ms)} a call (p50) over ${runs(s.samples)}`
}

function fitFor(id: string, sizeGb: number | null, status: LocalServerStatus | null): { fit: ModelFit; line: string } {
  if (!status) return { fit: 'unknown', line: '' }
  if (status.resident.includes(id)) {
    return {
      fit: 'resident',
      line: `loaded right now${sizeGb !== null ? ` — ${gb(sizeGb)}` : ''}`,
    }
  }
  if (sizeGb === null || status.ceilingGb === null) return { fit: 'unknown', line: '' }
  const resident = status.residentGb ?? 0
  const projected = resident + sizeGb
  const line =
    `${gb(sizeGb)} model · ${gb(resident)} already resident · ` +
    `${gb(projected)} needed against a ${gb(status.ceilingGb)} ceiling`
  return { fit: projected > status.ceilingGb ? 'wont-load' : 'fits', line }
}

/**
 * Build the picker's rows + its one recommendation.
 *
 * Ordering: rows WITH evidence first (fastest measured first), unmeasured rows
 * after, in the server's own order. That ordering IS the ranking, and an
 * unmeasured model never enters it — being last here means "not ranked", not
 * "worst".
 */
export function buildLocalModelReport(input: LocalModelInput): LocalModelReport {
  const status = input.status
  const base = input.models.map((id): LocalModelRow => {
    const speed = speedForModel(input.spans, id)
    const quality = qualityForModel(input.verdicts, id)
    const sizeGb = status?.sizeGb[id] ?? null
    const { fit, line } = fitFor(id, sizeGb, status)
    const measured = speed !== null || quality !== null
    return {
      id,
      measured,
      ranked: measured,
      speed,
      quality,
      sizeGb,
      loadEstimateSec:
        sizeGb !== null && status?.loadSecondsPerGb ? sizeGb * status.loadSecondsPerGb : null,
      fit,
      fitLine: line,
      suggestion: '',
    }
  })

  // Superlatives are computed over MEASURED rows only — the whole point.
  const measured = base.filter((r) => r.measured)
  const withSpeed = measured.filter((r) => r.speed !== null)
  const fastest = withSpeed.reduce<LocalModelRow | null>((best, r) => {
    if (!best) return r
    // tokens/sec when both know it, else the p50 they both do know.
    const a = r.speed!
    const b = best.speed!
    if (a.tokensPerSec !== null && b.tokensPerSec !== null) return a.tokensPerSec > b.tokensPerSec ? r : best
    return a.p50Ms < b.p50Ms ? r : best
  }, null)
  const withQuality = measured.filter((r) => r.quality !== null)
  const best = withQuality.reduce<LocalModelRow | null>(
    (top, r) => (!top || r.quality!.mean > top.quality!.mean ? r : top),
    null,
  )

  for (const row of base) {
    row.suggestion = suggestionFor(row, {
      fastest: fastest?.id === row.id && withSpeed.length > 1,
      best: best?.id === row.id && withQuality.length > 1,
      only: measured.length === 1 && row.measured,
    })
  }

  const rows = [
    ...measured.sort((a, b) => (a.speed?.p50Ms ?? Number.MAX_SAFE_INTEGER) - (b.speed?.p50Ms ?? Number.MAX_SAFE_INTEGER)),
    ...base.filter((r) => !r.measured),
  ]

  return { rows, recommendation: recommend(measured, best, fastest), note: noteFor(base, measured, status) }
}

function suggestionFor(
  row: LocalModelRow,
  flags: { fastest: boolean; best: boolean; only: boolean },
): string {
  const parts: string[] = []
  // Safety first: a model that cannot load must say so BEFORE it is picked —
  // and it still carries whatever it measured, because "can't load today" is
  // not a verdict on how it performed when it could.
  if (row.fit === 'wont-load') {
    parts.push(`won't load right now — ${row.fitLine} (the server's own figures)`)
  }
  if (!row.measured) {
    parts.push('no runs recorded yet — not ranked, and no speed or quality figure to show')
    return parts.join(' · ')
  }

  if (flags.fastest && row.speed) parts.push(`fastest here (${speedClause(row.speed)})`)
  if (flags.best && row.quality) {
    parts.push(`highest judged quality (${row.quality.mean.toFixed(2)} over ${runs(row.quality.runs)})`)
  }
  if (parts.length > 0) return parts.join(' · ')

  // No superlative: state only what this row itself measured.
  if (flags.only && row.speed) return `the only model with runs recorded here (${speedClause(row.speed)})`
  const own: string[] = []
  if (row.speed) own.push(`measured here: ${speedClause(row.speed)}`)
  if (row.quality) own.push(`judged ${row.quality.mean.toFixed(2)} over ${runs(row.quality.runs)}`)
  return own.join(' · ')
}

/** The default recommendation — offered ONLY when evidence supports it, and
 *  always naming the basis. A model that cannot load is never recommended. */
function recommend(
  measured: readonly LocalModelRow[],
  best: LocalModelRow | null,
  fastest: LocalModelRow | null,
): string {
  const usable = (r: LocalModelRow | null): r is LocalModelRow => !!r && r.fit !== 'wont-load'
  if (usable(best) && best.quality && measured.filter((r) => r.quality).length > 1) {
    return (
      `Recommended: ${best.id} — highest judged quality on your own runs ` +
      `(${best.quality.mean.toFixed(2)} mean Tier-2 score over ${runs(best.quality.runs)}).`
    )
  }
  if (usable(fastest) && fastest.speed && measured.filter((r) => r.speed).length > 1) {
    return `Recommended: ${fastest.id} — fastest measured here (${speedClause(fastest.speed)}).`
  }
  const one = measured.filter((r) => r.fit !== 'wont-load')
  if (one.length === 1 && one[0].speed) {
    // Say WHICH kind of "only" this is: the only measured model at all, or the
    // only measured one that can load right now. They are different facts.
    const basis =
      measured.length > one.length
        ? 'the only measured model that can load right now'
        : 'the only model with runs recorded here'
    return `Recommended: ${one[0].id} — ${basis} (${speedClause(one[0].speed)}). Nothing to compare it against yet.`
  }
  return ''
}

/**
 * The four fact lines a row renders. Kept here (not in the component) so the
 * wording is unit-testable and so no view can quietly compose a number the
 * model layer refused to claim. Each line either states a measured/reported
 * figure and names its source, or says plainly that nothing is recorded.
 */
export interface RowFacts {
  speed: string
  quality: string
  memory: string
  load: string
}

export function rowFacts(row: LocalModelRow, status: LocalServerStatus | null): RowFacts {
  const speed = row.speed
    ? `${secs(row.speed.p50Ms)} a call (p50)` +
      (row.speed.tokensPerSec !== null ? `, ${tok(row.speed.tokensPerSec)}` : '') +
      ` over ${runs(row.speed.samples)} here`
    : 'no runs recorded yet'
  const quality = row.quality
    ? `${row.quality.mean.toFixed(2)} mean Tier-2 judge score over ${runs(row.quality.runs)}`
    : 'no judged runs yet'

  let memory: string
  if (row.fit === 'resident') memory = row.fitLine
  else if (row.fit === 'unknown')
    memory = row.sizeGb !== null ? `${gb(row.sizeGb)} — your server reported no ceiling` : 'your server reported no size'
  else memory = `${row.fitLine} — ${row.fit === 'fits' ? 'fits right now' : "won't load right now"}`

  const rate = status?.loadSecondsPerGb
  const load =
    row.loadEstimateSec !== null && rate
      ? `about ${Math.round(row.loadEstimateSec)}s on the first call — the server's own estimate ` +
        `(${rate.toFixed(1)}s per GB), not a measurement`
      : 'your server reported no load estimate'

  return { speed, quality, memory, load }
}

/** One honest line about the evidence as a whole. */
function noteFor(
  all: readonly LocalModelRow[],
  measured: readonly LocalModelRow[],
  status: LocalServerStatus | null,
): string {
  const parts: string[] = []
  if (all.length === 0) return 'No models listed by your local server yet.'
  if (measured.length === 0) {
    parts.push(
      'No runs recorded on any of these models yet, so there is nothing to rank and nothing to recommend.',
    )
  } else {
    parts.push(
      `Speed is your own recorded runs; quality is the Tier-2 judge's mean score on them. ` +
        `${measured.length} of ${all.length} model${all.length === 1 ? '' : 's'} ${measured.length === 1 ? 'has' : 'have'} runs recorded.`,
    )
  }
  if (!status) {
    parts.push('Your local server did not report its memory status, so sizes and fit are unknown.')
  } else if (status.loadSecondsPerGb) {
    parts.push(
      `Load times are the server's own estimate (${status.loadSecondsPerGb.toFixed(1)}s per GB), not a measurement.`,
    )
  }
  return parts.join(' ')
}
