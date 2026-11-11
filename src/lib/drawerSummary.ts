// THE SIDEBAR'S ONE-LINERS (2026-11-11). Every block of the project sidebar
// folds to one line, and that line says what is inside — counts and states
// read from the stores, never a label alone — so a folded section cannot hide
// a problem: a seat that sits out shows in the summary itself.

export interface TeamSummaryInput {
  /** Agents assigned to this project specifically. */
  assigned: number
  /** The project's manual roster override ('' when none). */
  override: string
  /** Seats that will REALLY run, after the staffing and provider gates. */
  seats: number
  /** Seats that were asked for and cannot run. */
  sitOut: number
  /** The ask staffs nobody — the build would refuse to start. */
  refused: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function teamSummary(i: TeamSummaryInput): { text: string; warn: boolean } {
  if (i.refused) return { text: 'nobody could be staffed', warn: true }
  if (i.seats === 0) {
    return i.sitOut > 0
      ? { text: `no seat can run · ${i.sitOut} sit${i.sitOut === 1 ? 's' : ''} out`, warn: true }
      : { text: 'single model', warn: false }
  }
  const who = i.assigned > 0 ? 'this project’s agents' : i.override.trim() ? 'manual override' : 'default team'
  const out = i.sitOut > 0 ? ` · ${i.sitOut} sit${i.sitOut === 1 ? 's' : ''} out` : ''
  return { text: `${who} · ${plural(i.seats, 'seat')}${out}`, warn: i.sitOut > 0 }
}

export function loopsSummary(loops: readonly { enabled: boolean }[]): string {
  if (loops.length === 0) return 'none'
  const on = loops.filter((l) => l.enabled).length
  return `${plural(loops.length, 'loop')} · ${on === 0 ? 'off' : `${on} on`}`
}

export function filesSummary(count: number): string {
  return plural(count, 'file')
}

export function verdictsSummary(count: number): string {
  return `${count} recorded`
}

export function planSummary(p: { status: string; stepIndex: number; plan: readonly string[] }): string {
  const n = p.plan.length
  if (p.status === 'running') return `step ${Math.min(p.stepIndex + 1, n)} of ${n}`
  const state =
    p.status === 'done'
      ? 'done'
      : p.status === 'attention'
        ? 'needs a look'
        : p.status === 'awaiting'
          ? 'waiting for you'
          : 'not started'
  return `${plural(n, 'step')} · ${state}`
}
