// The Work header's one status pill: how many runs are on record.
//
// It used to carry a share as well ("38% of runs on your Mac") beside the
// rail's local meter ("67% local", a share of TOKENS). Each said what it
// counted, and they still read as one fact with two values. The rail's meter
// is on every page, so the pill states no share of its own: both shares are
// on the Stats page this pill leads to, side by side and named.
export function runsPill(runsRecorded: number): string {
  if (runsRecorded <= 0) return 'no runs yet — stats appear as you work'
  return `${runsRecorded} run${runsRecorded === 1 ? '' : 's'} recorded all time`
}
