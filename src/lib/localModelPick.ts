// SC Prism — the best local model FOR EACH KIND OF WORK (2026-08-29).
//
// WHY THIS EXISTS
// ---------------
// The measured rows (localModels.ts, 2026-08-17) tell him what each model IS:
// its own recorded speed, its own judged quality, the server's own memory
// arithmetic. What they don't say is what each model is FOR. Retrieval and
// research live on turnaround, so they weigh SPEED; the implementer and
// reviewer are judged on their output, so they weigh the Tier-2 score; chat
// wants both at once. This file turns the rows into one evidence-backed pick
// per kind, with a reason that cites the real numbers behind it.
//
// SAME RULES AS THE ROWS IT READS:
//   * an UNMEASURED model is never ranked or suggested — there is no evidence
//     to back a pick with;
//   * a model the server says cannot load right now is never suggested;
//   * no vendor claims, no parameter-count heuristics — every reason names a
//     measured figure ("highest judged quality (0.81 over 14 runs)").
//
// AND THE ONE-RESIDENT-MODEL TRUTH (2026-08-28, live): the oMLX server holds
// ONE big model resident. Seats bound to gemma errored with the server
// refusing once Qwen was resident — its own arithmetic said the pair could
// not co-load. A per-kind mix that needs two such models is a plan for that
// exact failure, so when the rows carry the server's sizes and the report a
// ceiling, the mix is checked: picks that cannot co-load are called out with
// the server's own figures and collapsed to the single best compromise.
//
// Pure: rows (already measured) + the server's report in, picks out. No I/O.

import {
  gb,
  runs,
  speedClause,
  type LocalModelRow,
  type LocalServerStatus,
  type ModelQuality,
} from './localModels'

/** The kinds of work a local model gets asked to do here. */
export type WorkKind = 'retrieval' | 'research' | 'implementer' | 'reviewer' | 'chat'

export const WORK_KINDS: readonly WorkKind[] = [
  'retrieval',
  'research',
  'implementer',
  'reviewer',
  'chat',
]

/** What each kind weighs. Not a scorecard — a statement of what the work needs. */
const WEIGHTING: Record<WorkKind, 'speed' | 'quality' | 'balanced'> = {
  retrieval: 'speed',
  research: 'speed',
  implementer: 'quality',
  reviewer: 'quality',
  chat: 'balanced',
}

export interface KindPick {
  kind: WorkKind
  /** The model the evidence backs for this kind. */
  id: string
  /** One line naming the measured numbers behind the pick. */
  reason: string
}

export interface KindPicks {
  /** One pick per kind, in WORK_KINDS order — empty when nothing is measured. */
  picks: KindPick[]
  /** '' unless the per-kind mix needs models the server's own figures say
   *  cannot co-load; then the callout, citing those figures. */
  memoryNote: string
}

const judgedClause = (q: ModelQuality): string => `${q.mean.toFixed(2)} over ${runs(q.runs)}`

/** Everything this one row measured, spelled the rows' own way. */
function ownClauses(r: LocalModelRow): string {
  const parts: string[] = []
  if (r.speed) parts.push(speedClause(r.speed))
  if (r.quality) parts.push(`judged ${judgedClause(r.quality)}`)
  return parts.join(' · ')
}

/**
 * Fastest of the rows that measured speed: tokens/sec when both know it, else
 * the p50 they both do (the same comparison the rows' own "fastest here" flag
 * makes). A tied metric goes to the model with more samples behind it.
 */
function fastestOf(rows: readonly LocalModelRow[]): LocalModelRow | null {
  return rows
    .filter((r) => r.speed !== null)
    .reduce<LocalModelRow | null>((best, r) => {
      if (!best) return r
      const a = r.speed!
      const b = best.speed!
      if (a.tokensPerSec !== null && b.tokensPerSec !== null && a.tokensPerSec !== b.tokensPerSec)
        return a.tokensPerSec > b.tokensPerSec ? r : best
      if (a.p50Ms !== b.p50Ms) return a.p50Ms < b.p50Ms ? r : best
      return a.samples > b.samples ? r : best
    }, null)
}

/** Highest judged mean; a tie goes to the model with more judged runs. */
function bestJudgedOf(rows: readonly LocalModelRow[]): LocalModelRow | null {
  return rows
    .filter((r) => r.quality !== null)
    .reduce<LocalModelRow | null>((top, r) => {
      if (!top) return r
      const a = r.quality!
      const b = top.quality!
      if (a.mean !== b.mean) return a.mean > b.mean ? r : top
      return a.runs > b.runs ? r : top
    }, null)
}

/**
 * Best BALANCE, over rows measured on both dimensions: each row's p50 and
 * judged mean as a ratio of the best among them, summed. Both terms are
 * ratios of measured numbers — nothing enters that wasn't recorded — and the
 * reason still cites the raw figures, never this composite.
 */
function bestBalancedOf(rows: readonly LocalModelRow[]): LocalModelRow | null {
  const both = rows.filter((r) => r.speed !== null && r.quality !== null)
  if (both.length === 0) return null
  const minP50 = Math.min(...both.map((r) => r.speed!.p50Ms))
  const maxMean = Math.max(...both.map((r) => r.quality!.mean))
  const score = (r: LocalModelRow): number =>
    (r.speed!.p50Ms > 0 ? minP50 / r.speed!.p50Ms : 1) +
    (maxMean > 0 ? r.quality!.mean / maxMean : 0)
  return both.reduce<LocalModelRow | null>((top, r) => {
    if (!top) return r
    const a = score(r)
    const b = score(top)
    if (a !== b) return a > b ? r : top
    return r.speed!.samples + r.quality!.runs > top.speed!.samples + top.quality!.runs ? r : top
  }, null)
}

/**
 * The evidence-backed pick for one kind of work, or `null` when no measured
 * model can take it. The reason states the superlative only when there was a
 * comparison to win ("fastest measured here"), says "the only" when there
 * wasn't, and says plainly when a kind's own dimension had nothing recorded
 * and what was used instead. Every figure in it is a measured one.
 */
export function pickForKind(rows: readonly LocalModelRow[], kind: WorkKind): KindPick | null {
  const measured = rows.filter((r) => r.measured)
  // Never suggest what the server's own arithmetic says cannot load today.
  const candidates = measured.filter((r) => r.fit !== 'wont-load')
  if (candidates.length === 0) return null

  if (candidates.length === 1) {
    const only = candidates[0]
    // Two different facts, said apart (recommend()'s distinction): the only
    // model measured at all, or the only measured one that can load right now.
    const basis =
      measured.length > candidates.length
        ? 'the only measured model that can load right now'
        : 'the only model with runs recorded here'
    return { kind, id: only.id, reason: `${basis} (${ownClauses(only)})` }
  }

  const timedCount = candidates.filter((r) => r.speed !== null).length
  const judgedCount = candidates.filter((r) => r.quality !== null).length
  const speedReason = (r: LocalModelRow): string =>
    timedCount > 1
      ? `fastest measured here (${speedClause(r.speed!)})`
      : `the only model with speed measured here (${speedClause(r.speed!)})`
  const qualityReason = (r: LocalModelRow): string =>
    judgedCount > 1
      ? `highest judged quality (${judgedClause(r.quality!)})`
      : `the only model with judged runs here (${judgedClause(r.quality!)})`

  const bySpeed = fastestOf(candidates)
  const byQuality = bestJudgedOf(candidates)

  switch (WEIGHTING[kind]) {
    case 'speed': {
      if (bySpeed) return { kind, id: bySpeed.id, reason: speedReason(bySpeed) }
      // Nothing timed at all: say so, and show the evidence actually used.
      if (byQuality)
        return { kind, id: byQuality.id, reason: `no speed recorded yet — ${qualityReason(byQuality)}` }
      return null
    }
    case 'quality': {
      if (byQuality) return { kind, id: byQuality.id, reason: qualityReason(byQuality) }
      if (bySpeed)
        return { kind, id: bySpeed.id, reason: `no judged runs yet — ${speedReason(bySpeed)}` }
      return null
    }
    case 'balanced': {
      const byBoth = bestBalancedOf(candidates)
      if (byBoth) {
        const bothCount = candidates.filter((r) => r.speed !== null && r.quality !== null).length
        const cite = `${speedClause(byBoth.speed!)} · judged ${judgedClause(byBoth.quality!)}`
        return {
          kind,
          id: byBoth.id,
          reason:
            bothCount > 1
              ? `best measured balance of speed and quality (${cite})`
              : `the only model measured on both speed and quality (${cite})`,
        }
      }
      // No model measured on both: quality first (the rows' own recommendation
      // order), then speed — each saying what it is.
      if (byQuality) return { kind, id: byQuality.id, reason: qualityReason(byQuality) }
      if (bySpeed) return { kind, id: bySpeed.id, reason: speedReason(bySpeed) }
      return null
    }
  }
}

/**
 * Every kind's pick, then the one-resident-model check over the set.
 *
 * The check runs ONLY on figures that exist: the rows' own server-reported
 * sizes and the report's ceiling. Any of them absent → no claim, the split
 * stands (the server that never reported a ceiling has not said the mix will
 * fail). When the figures do say the picked models cannot all stay loaded,
 * every kind gets the single best compromise — the balanced pick, since it is
 * about to serve speed-weighted and quality-weighted work alike — and the
 * callout states the server's arithmetic. A kind that already wanted the
 * compromise model keeps its own sharper reason.
 */
export function buildKindPicks(
  rows: readonly LocalModelRow[],
  status: LocalServerStatus | null,
): KindPicks {
  const picks: KindPick[] = []
  for (const kind of WORK_KINDS) {
    const p = pickForKind(rows, kind)
    if (p) picks.push(p)
  }
  if (picks.length === 0) return { picks, memoryNote: '' }

  const distinct = [...new Set(picks.map((p) => p.id))]
  if (distinct.length < 2) return { picks, memoryNote: '' }

  const ceiling = status?.ceilingGb ?? null
  const sizes = distinct.map((id) => rows.find((r) => r.id === id)?.sizeGb ?? null)
  if (ceiling === null || sizes.some((s) => s === null)) return { picks, memoryNote: '' }
  const total = (sizes as number[]).reduce((a, b) => a + b, 0)
  if (total <= ceiling) return { picks, memoryNote: '' }

  // The 2026-08-28 failure, pre-empted: this mix would have one kind's calls
  // refused the moment the other kind's model went resident.
  const compromise = pickForKind(rows, 'chat')
  if (!compromise) return { picks, memoryNote: '' }
  const compromiseRow = rows.find((r) => r.id === compromise.id)
  const memoryNote =
    `A per-kind mix would need ${distinct.join(' + ')} loaded together — ` +
    `${(sizes as number[]).map(gb).join(' + ')} against a ${gb(ceiling)} ceiling ` +
    `(the server's own figures) — and your server holds one model at a time. ` +
    `Every kind gets the single best compromise: ${compromise.id}.`
  return {
    picks: picks.map((p) =>
      p.id === compromise.id
        ? p
        : {
            ...p,
            id: compromise.id,
            reason: `single-model compromise (${compromiseRow ? ownClauses(compromiseRow) : compromise.reason})`,
          },
    ),
    memoryNote,
  }
}
