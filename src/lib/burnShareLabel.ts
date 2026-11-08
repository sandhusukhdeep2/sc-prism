// The Console footer's share, named by what it counts. The engine's burn is a
// TOKEN share (localShare over cost_by_model); the session fallback is a RUN
// share (state.stats.localSharePct). Work's pill counts runs, the rail counts
// tokens — each says so, so no two numbers wear the same words.
export function burnShareLabel(real: boolean, pct: number): string {
  return `${pct}% of ${real ? 'tokens' : 'runs'} on your Mac`
}
