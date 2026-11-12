// "Fix by your measurement first" (the owner, 2026-11-12).
//
// The stop the workload slider starts on is not a guess and not a default
// somebody liked: it is read from the Tier-2 judge's scores for the local
// model on THIS Mac (`qualityForModel` — the same measurement the local-model
// picker shows). The app caches the answer in Settings so a roster can be
// resolved without reading the run history.

import type { Verdict } from '../engine/types'
import { qualityForModel, type ModelQuality } from './localModels'
import type { Settings } from './settings'
import { suggestWorkload, type WorkloadStop } from './workload'
import { workloadAIs } from './workloadSeats'

export interface WorkloadMeasurement {
  /** The stop the measurement points to — null when there is nothing to say. */
  stop: WorkloadStop | null
  /** The reason, in words the Settings page shows as they are. */
  why: string
  /** The judge's record for the local model, when it has one. */
  quality: ModelQuality | null
}

export function measureWorkload(
  settings: Settings,
  verdicts: readonly Verdict[],
): WorkloadMeasurement {
  const ai = workloadAIs(settings)
  const localModel = (settings.providers ?? []).find((p) => p.id === 'local')?.model ?? ''
  const quality = localModel ? qualityForModel(verdicts, localModel) : null
  const hasCloud = (!!ai.primary && ai.primary !== 'local') || !!ai.second
  return { ...suggestWorkload({ hasLocal: !!ai.local, hasCloud, quality }), quality }
}
