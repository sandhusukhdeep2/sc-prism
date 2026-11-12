// THE WORKLOAD SLIDER (2026-11-12).
//
// The owner: "one slider that changes the dependency… if the user wants the
// primary AI to just give the instruction and check the work, it can do only
// that, and all the workload is on local… fix by your measurement first, but
// give the slider to the user. If the user wants to go all in with local, he
// can."
//
// A stop on the slider is a rule about SEATS: who plans, who does the work,
// who checks it. It is applied to the DEFAULT team by code — the composer's
// team and a project's system agents — and never to a team the user staffed by
// hand, whose seats are his own explicit choice. No model picks anything
// (ADR-007), the privacy floor still outranks every stop, and the Settings
// page shows the resulting seats before anything runs.
//
// Pure: a roster string in, a roster string out.

import { splitRoster } from './roster'
import { WORKLOAD_STOPS, type WorkloadStop, type Workload } from './workloadKinds'

export { WORKLOAD_STOPS, isWorkload } from './workloadKinds'
export type { Workload, WorkloadStop } from './workloadKinds'

/** What a seat is FOR. */
export type SeatKind = 'plan' | 'do' | 'check'

const PLAN_WORDS = ['lead', 'planner', 'plan', 'manager', 'architect', 'orchestrator', 'director']
const CHECK_WORDS = ['critic', 'review', 'reviewer', 'verifier', 'verify', 'qa', 'judge', 'auditor', 'checker']

/**
 * What a seat is for, read from its role name's own words. A name made of
 * several words ("reviewer-verifier", "tech-lead") is read word by word; a
 * seat that neither plans nor checks does the work.
 */
export function seatKind(role: string): SeatKind {
  const words = role.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((w) => CHECK_WORDS.includes(w))) return 'check'
  if (words.some((w) => PLAN_WORDS.includes(w))) return 'plan'
  return 'do'
}

/** Seats that read the user's own notes. They stay on this Mac at every stop
 *  — the same instinct the privacy floor enforces at run time, applied before
 *  the run instead of in the middle of it. */
const PRIVATE_WORDS = ['retrieval', 'vault', 'memory', 'archivist', 'librarian', 'notes']

export function isPrivateSeat(role: string): boolean {
  const words = role.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((w) => PRIVATE_WORDS.includes(w))
}

/** The AIs a stop can seat. '' = that kind of AI is not connected. */
export interface WorkloadAIs {
  /** The primary's provider token. */
  primary: string
  /** 'local' when a local model is connected. */
  local: string
  /** A connected cloud AI that is not the primary. */
  second: string
}

/** Which AI a stop gives each kind of seat: 'P' the primary, 'L' local. */
const STOP_RULES: Record<(typeof WORKLOAD_STOPS)[number], Record<SeatKind, 'P' | 'L'>> = {
  'primary-all': { plan: 'P', do: 'P', check: 'P' },
  'primary-leads': { plan: 'P', do: 'L', check: 'P' },
  'primary-checks': { plan: 'L', do: 'L', check: 'P' },
  'local-all': { plan: 'L', do: 'L', check: 'L' },
}

function seatToken(
  role: string,
  was: string,
  stop: WorkloadStop,
  ai: WorkloadAIs,
  secondOpinion: boolean,
): string {
  if (stop === 'agents') return was
  // A seat that reads your notes stays local at every stop.
  if (isPrivateSeat(role)) return ai.local || was
  const kind = seatKind(role)
  const want = STOP_RULES[stop][kind]
  // A SECOND OPINION: where the primary would have checked, another AI does.
  // Never at all-local — that would send the work off the Mac to be checked.
  if (secondOpinion && kind === 'check' && want === 'P' && ai.second) return ai.second
  const token = want === 'P' ? ai.primary : ai.local
  // An AI that is not there is never seated: the seat keeps the AI it had.
  return token || was
}

/**
 * Re-seat a roster (`role:token,…`) for a stop. 'agents' returns it untouched.
 */
export function applyWorkload(
  roster: string,
  stop: WorkloadStop,
  ai: WorkloadAIs,
  opts: { secondOpinion?: boolean } = {},
): string {
  if (stop === 'agents') return roster
  return splitRoster(roster)
    .map((p) => `${p.role}:${seatToken(p.role, p.token, stop, ai, !!opts.secondOpinion)}`)
    .join(',')
}

export interface WorkloadRow {
  role: string
  kind: SeatKind
  was: string
  now: string
  moved: boolean
  /** Reads your notes — it stays on this Mac whatever the stop. */
  private: boolean
}

/** The seats, as the slider shows them: what each is for, and where it runs now. */
export function workloadTable(
  roster: string,
  stop: WorkloadStop,
  ai: WorkloadAIs,
  opts: { secondOpinion?: boolean } = {},
): WorkloadRow[] {
  return splitRoster(roster).map((p) => {
    const now = seatToken(p.role, p.token, stop, ai, !!opts.secondOpinion)
    return {
      role: p.role,
      kind: seatKind(p.role),
      was: p.token,
      now,
      moved: now !== p.token,
      private: isPrivateSeat(p.role),
    }
  })
}

/** How many judged runs the local model needs before a stop is suggested. */
export const MIN_JUDGED_RUNS = 10
/** At or above this mean score the local model is trusted to plan too. */
export const TRUSTED_MEAN = 0.75
/** Below this mean score the local model is not given the work. */
export const WEAK_MEAN = 0.5

/**
 * The stop the measurements point to — or none, with the reason.
 *
 * The one measurement is the Tier-2 judge's mean score over the local model's
 * own judged runs (`qualityForModel`). All-local is never suggested: it gives
 * up the independent check, and that is a choice for the user to make.
 */
export function suggestWorkload(input: {
  hasLocal: boolean
  hasCloud: boolean
  quality: { runs: number; mean: number } | null
}): { stop: WorkloadStop | null; why: string } {
  if (!input.hasLocal) return { stop: null, why: 'no local model is connected — every seat runs on your primary' }
  if (!input.hasCloud) return { stop: null, why: 'no cloud AI is connected — every seat runs on this Mac' }
  const q = input.quality
  if (!q || q.runs < MIN_JUDGED_RUNS) {
    const n = q?.runs ?? 0
    return {
      stop: null,
      why: `only ${n} judged run${n === 1 ? '' : 's'} on your local model so far — ${MIN_JUDGED_RUNS} are needed before the app suggests a stop`,
    }
  }
  const why = `your local model averaged ${q.mean.toFixed(2)} over ${q.runs} judged runs`
  if (q.mean >= TRUSTED_MEAN) return { stop: 'primary-checks', why }
  if (q.mean >= WEAK_MEAN) return { stop: 'primary-leads', why }
  return { stop: 'primary-all', why }
}

/**
 * The stop the runs actually use. A stop the user chose is the stop;
 * 'measured' follows the cached measurement, and with none it changes nothing.
 */
export function effectiveWorkload(chosen: Workload, measured: WorkloadStop | ''): WorkloadStop {
  if (chosen !== 'measured') return chosen
  return measured || 'agents'
}

/** Each stop in one plain sentence, naming the primary by its own name. */
export function workloadCopy(stop: WorkloadStop, primaryName: string): { word: string; desc: string } {
  switch (stop) {
    case 'primary-all':
      return { word: `All ${primaryName}`, desc: `${primaryName} plans, does the work and checks it` }
    case 'primary-leads':
      return {
        word: `${primaryName} leads and checks`,
        desc: `${primaryName} plans and checks; your local model does the work`,
      }
    case 'primary-checks':
      return {
        word: `${primaryName} checks only`,
        desc: `your local model plans and does the work; ${primaryName} checks it`,
      }
    case 'local-all':
      return {
        word: 'All local',
        desc: 'everything runs on this Mac; your own tests are the independent check',
      }
    default:
      return { word: 'Each agent’s own AI', desc: 'every agent runs on the AI set on it — the slider is off' }
  }
}
