// The workload slider, read from Settings (see lib/workload.ts for the rule).
//
// Three questions, one answer each: which AIs are there to seat, which stop is
// in force, and what a roster looks like re-seated for it. Every place that
// resolves a DEFAULT team asks here, so what Settings shows and what a run
// gets are the same list.

import { providerUsable, type Settings } from './settings'
import { agentSlug } from './agents'
import {
  applyWorkload,
  effectiveWorkload,
  isWorkload,
  type WorkloadAIs,
  type WorkloadStop,
} from './workload'

/**
 * The AIs a stop can seat, by the same "really connected" test the team
 * launcher uses (`providerUsable`). '' means that kind of AI is not there —
 * and a stop never seats an AI that is not there.
 */
export function workloadAIs(settings: Settings): WorkloadAIs {
  const list = settings.providers ?? []
  const primary = list.find((p) => p.primary && providerUsable(p))?.id ?? ''
  const local = providerUsable(list.find((p) => p.id === 'local')) ? 'local' : ''
  const second =
    list.find((p) => providerUsable(p) && p.id !== primary && p.id !== 'local')?.id ?? ''
  return { primary, local, second }
}

/** The stop in force. A store that predates the slider changes nothing. */
export function settingsStop(settings: Settings): WorkloadStop {
  const chosen = isWorkload(settings.workload) ? settings.workload : 'measured'
  // Read defensively: a hand-edited store can hold anything here.
  const cached: unknown = settings.workloadMeasured
  const measured = isWorkload(cached) && cached !== 'measured' ? cached : ''
  return effectiveWorkload(chosen, measured)
}

/** A default team's roster, re-seated for the stop in force. */
export function seatByWorkload(settings: Settings, roster: string): string {
  return applyWorkload(roster, settingsStop(settings), workloadAIs(settings), {
    secondOpinion: settings.workloadSecondOpinion === true,
  })
}

/**
 * The AI a seat REALLY runs on: the one set on the agent — unless it sits on
 * the default team, where the workload stop in force re-seats it at run time.
 * An agent staffed to a project keeps the AI set on it. The single source for
 * every surface that says where an agent runs (its card, the per-AI seat
 * count), so none of them can say the card's setting when the run will differ.
 */
export function agentRunsOn(
  settings: Settings,
  agent: { name: string; model: string; assignedTo?: string },
): string {
  if ((agent.assignedTo ?? '') !== 'system') return String(agent.model)
  const seated = seatByWorkload(settings, `${agentSlug(agent.name)}:${agent.model}`)
  return seated.slice(seated.indexOf(':') + 1)
}

