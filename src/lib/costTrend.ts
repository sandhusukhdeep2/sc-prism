// Shared, honest cost-trend direction. Memory's caption and Stats' cost card
// must make the SAME claim, and only one the REAL cost series supports: compare
// first vs last with a 2% deadband. With <2 points there is no data, so there
// is NO directional claim. This kills both "cost floor falling" shown against
// zero data and "cost floor holding" shown while cost actually rises.
export type CostDirection = 'down' | 'up' | 'flat' | 'none'

/**
 * Direction of a cost series (oldest→newest). 2% deadband; <2 points → flat.
 *
 * `'none'` means NO claim is available. It is returned when the last sample is
 * $0: a zero-cost run means the run made no priced call (all-local, or nothing
 * ran at all), which is an ABSENT measurement — not evidence that the cost floor
 * fell. Without this gate one $0.00 local run turned into "↓ 100% · cost floor
 * falling", the single most flattering lie on the page.
 */
/**
 * The ONE cost-floor series every page reads (2026-08-28). Stats walked the
 * engine's run series (every engine run, heartbeats and manager jobs included)
 * while Memory walked the client's verdict costs (which carry NO heartbeat or
 * manager runs) — and the same screen pair said "↑306% · cost floor rising"
 * and "trending down" at once. Prefer the engine's own record; fall back to
 * the client's chronological verdict costs when the dashboard read dropped.
 */
export function costFloorSeries(
  dash: { run_series: readonly { cost: number }[] } | null | undefined,
  verdictCostsChron: readonly number[],
): number[] {
  if (dash) return dash.run_series.map((r) => r.cost)
  return [...verdictCostsChron]
}

export function costDirection(series: readonly number[]): CostDirection {
  if (series.length < 2) return 'flat'
  const first = series[0]
  const last = series[series.length - 1]
  if (last <= 0) return 'none'
  if (first <= 0) return 'none' // no baseline to compare against
  if (last < first * 0.98) return 'down'
  if (last > first * 1.02) return 'up'
  return 'flat'
}
