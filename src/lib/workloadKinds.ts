// The workload slider's positions (see lib/workload.ts). A leaf module — no
// imports — so the settings store can validate a saved value without pulling
// in the roster code that itself reads settings.

/**
 * 'measured' — follow the stop the measurements point to (the default);
 * 'agents'   — each agent runs on the AI set on it, the slider is off;
 * the rest   — the four stops, from all-primary to all-local.
 */
export type Workload =
  | 'measured'
  | 'agents'
  | 'primary-all'
  | 'primary-leads'
  | 'primary-checks'
  | 'local-all'

/** A stop the runs can actually use ('measured' resolves to one of these). */
export type WorkloadStop = Exclude<Workload, 'measured'>

/** The slider's own positions, left to right: all-primary → all-local. */
export const WORKLOAD_STOPS = ['primary-all', 'primary-leads', 'primary-checks', 'local-all'] as const

export function isWorkload(v: unknown): v is Workload {
  return v === 'measured' || v === 'agents' || (WORKLOAD_STOPS as readonly unknown[]).includes(v)
}
