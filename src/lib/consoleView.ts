// The measurements behind the Console's cards, as shapes a person can read.
//
// 2026-11-11 tour of the installed app: token burn was three unlabelled blocks
// (no amount on any of them), the eval line plotted 383 points edge to edge
// and read as a solid band, and "0 blocked · 0 hook errors" stood in alarm
// red. Nothing here invents a number: each function reshapes what the engine
// dashboard already reports.

import type { ProviderBurn } from './engineStats'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export interface BurnRow {
  key: string
  label: string
  isLocal: boolean
  tokens: number
  /** "7M", "20K" — the amount, short. */
  tokensLabel: string
  /** Bar width relative to the largest provider (0 only when no tokens). */
  widthPct: number
  /** Share of all burned tokens, rounded. */
  sharePct: number
  /** The share as written: a provider that burned something is never "0%". */
  shareLabel: string
}

/** One row per provider: its amount, its bar, and its share of the whole. */
export function burnRows(providers: readonly ProviderBurn[]): BurnRow[] {
  const max = Math.max(0, ...providers.map((p) => p.tokens))
  const total = providers.reduce((n, p) => n + p.tokens, 0)
  return providers.map((p) => {
    const sharePct = total > 0 ? Math.round((p.tokens / total) * 100) : 0
    return {
      key: p.key,
      label: p.label,
      isLocal: p.isLocal,
      tokens: p.tokens,
      tokensLabel: compact.format(p.tokens),
      widthPct: p.tokens > 0 && max > 0 ? Math.max(2, Math.round((p.tokens / max) * 100)) : 0,
      sharePct,
      shareLabel: p.tokens > 0 && sharePct < 1 ? '<1%' : `${sharePct}%`,
    }
  })
}

/**
 * A long series as at most `maxPoints` averages, in order. A sparkline a few
 * hundred pixels wide cannot show 383 points; drawn raw they overlap into a
 * band. Each output point is the mean of its slice, so no value leaves the
 * range of the values it stands for.
 */
export function bucketMeans(values: readonly number[], maxPoints: number): number[] {
  const n = values.length
  if (n <= maxPoints || maxPoints < 1) return [...values]
  const out: number[] = []
  for (let b = 0; b < maxPoints; b++) {
    const from = Math.floor((b * n) / maxPoints)
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / maxPoints))
    let sum = 0
    for (let i = from; i < to; i++) sum += values[i]
    out.push(sum / (to - from))
  }
  return out
}

/** A count of bad things is an alarm only when there are some. */
export function countTone(n: number | null | undefined): 'calm' | 'alert' {
  return typeof n === 'number' && n > 0 ? 'alert' : 'calm'
}
