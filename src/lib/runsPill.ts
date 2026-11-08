// The Work header's one status pill: how many runs are recorded, and how many
// of THOSE RUNS stayed on this Mac. "of runs" is the point — the rail's local
// meter counts tokens, and the two figures legitimately differ; each says what
// it counts so they cannot read as a contradiction.
export function runsPill(runsRecorded: number, localRunsPct: number): string {
  if (runsRecorded <= 0) return 'no runs yet — stats appear as you work'
  return `${runsRecorded} run${runsRecorded === 1 ? '' : 's'} recorded all time · ${localRunsPct}% of runs on your Mac`
}
