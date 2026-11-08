// The room header's count of agents — from the store and the spans, never from
// a plan. "N agents · M have worked · K working now":
//   N = this project's enabled agents (its build team); when it has none, the
//       distinct agents that actually appear in the run's spans — a working
//       crew is never reported as "0 agents".
//   M = of those, the ones that appear in the run's spans — the store's
//       `usage` is seeded and never incremented, so it is not evidence.
//   K = seats with a span still open, and only while the run is genuinely
//       live — a parked run has nobody working.
import type { StoredAgent } from './agents'

export function roomCountLine(
  agents: readonly StoredAgent[],
  projectId: string,
  orbs: readonly { agent: string; outcome: string }[],
  live: boolean,
): string {
  const mine = agents.filter((a) => a.enabled && (a.assignedTo ?? '') === projectId)
  const fromSpans = new Set(orbs.map((o) => o.agent))
  const total = mine.length > 0 ? mine.length : fromSpans.size
  if (total === 0) return ''
  // "Have worked" is read from the spans, never from the store's `usage` —
  // that field is seeded (128, 214, 197) and nothing increments it.
  const worked = mine.length > 0 ? mine.filter((a) => fromSpans.has(a.name)).length : fromSpans.size
  const workingNow = live ? orbs.filter((o) => o.outcome === 'running').length : 0
  return (
    `${total} agent${total === 1 ? '' : 's'} · ` +
    `${worked} ha${worked === 1 ? 's' : 've'} worked · ` +
    `${workingNow} working now`
  )
}
