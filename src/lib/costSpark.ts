// The cost card's line, drawn from the ONE cost series every page reads
// (lib/costTrend.costFloorSeries). Until 2026-11-11 the Memory page drew this
// session's verdict costs while the sentence under the line read the engine's
// run series: one card, two series. A long history is averaged into at most
// `maxPoints` points first, so hundreds of runs read as a line and not a band.

import { bucketMeans } from './consoleView'

export interface CostSpark {
  /** Path for the line, in a 220×40 box. */
  line: string
  /** The same line closed down to the baseline, for a soft fill; '' if empty. */
  area: string
  /** How many points the line has (0 = nothing measured). */
  points: number
}

export function costSpark(series: readonly number[], maxPoints = 48): CostSpark {
  const vals = bucketMeans(series, maxPoints)
  const n = vals.length
  if (n === 0) return { line: 'M0 20 L220 20', area: '', points: 0 }
  const min = Math.min(...vals)
  const span = Math.max(...vals) - min || 1
  const yFor = (v: number) => (6 + (1 - (v - min) / span) * 28).toFixed(1)
  if (n === 1) {
    const y = yFor(vals[0])
    return { line: `M0 ${y} L220 ${y}`, area: `M0 ${y} L220 ${y} L220 40 L0 40 Z`, points: 1 }
  }
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * 220).toFixed(1)} ${yFor(v)}`).join(' ')
  return { line, area: `${line} L220 40 L0 40 Z`, points: n }
}
