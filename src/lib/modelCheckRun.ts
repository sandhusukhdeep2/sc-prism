// The runner around the model-check rules (see modelCheck.ts): ask each AI
// what it offers, prove a tier move before making it, apply what stands, and
// remember the day. Everything that touches the world is handed in, so the
// order of events here is testable without a network.

import { useSyncExternalStore } from 'react'
import {
  planModelCheck,
  type ModelCatalog,
  type ModelCheckResult,
  type ModelMove,
  type ModelSkip,
} from './modelCheck'
import { isCliProvider, providerUsable, type ProviderConfig } from './settings'

const STORAGE_KEY = 'scprism.modelCheck'

export interface ModelCheckState {
  catalog: ModelCatalog
  /** The last check that ran, or null when none has. */
  last: ModelCheckResult | null
}

const EMPTY: ModelCheckState = { catalog: {}, last: null }
let cached: { raw: string | null; state: ModelCheckState } | null = null
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** The saved record. Anything unreadable is "never checked" — the next check
 *  simply rebuilds it. */
export function loadModelCheck(): ModelCheckState {
  const raw = read()
  if (cached && cached.raw === raw) return cached.state
  let state = EMPTY
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ModelCheckState> | null
      if (parsed && typeof parsed === 'object' && parsed.catalog && typeof parsed.catalog === 'object') {
        state = { catalog: parsed.catalog, last: parsed.last ?? null }
      }
    } catch {
      state = EMPTY
    }
  }
  cached = { raw, state }
  return state
}

export function saveModelCheck(state: ModelCheckState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A full or blocked store only means tomorrow's check starts fresh.
  }
  for (const l of listeners) l()
}

/** The saved record, re-rendering when a check finishes. */
export function useModelCheck(): ModelCheckState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    loadModelCheck,
    loadModelCheck,
  )
}

export interface ModelCheckDeps {
  providers: readonly ProviderConfig[]
  /** Move each AI to its newest model (Settings → Your AIs). */
  auto: boolean
  now: number
  /** What this AI offers. May throw or return [] — that AI is then skipped. */
  list: (p: ProviderConfig) => Promise<string[]>
  /** Make this subscription CLI answer once on `model`. */
  probe: (providerId: string, model: string) => Promise<{ ok: boolean; error: string }>
  /** Put this AI on `model`. */
  apply: (providerId: string, model: string) => void
}

export async function runModelCheck(deps: ModelCheckDeps): Promise<ModelCheckResult> {
  const before = loadModelCheck()
  const listable = deps.providers.filter((p) => providerUsable(p) && !isCliProvider(p.id))
  const listings: Record<string, string[]> = {}
  await Promise.all(
    listable.map(async (p) => {
      try {
        const models = await deps.list(p)
        if (models.length > 0) listings[p.id] = models
      } catch {
        // Unreadable today: it keeps its last record.
      }
    }),
  )
  const plan = planModelCheck({
    providers: deps.providers,
    catalog: before.catalog,
    listings,
    now: deps.now,
    auto: deps.auto,
  })
  const moves: ModelMove[] = []
  const skipped: ModelSkip[] = []
  for (const move of plan.moves) {
    // A newer version on a key is on that AI's own list for this key. A tier
    // move on a subscription has no list behind it, so the model has to answer
    // first — "it should exist" is not moved on.
    if (move.why === 'greatest') {
      const proof = await deps.probe(move.providerId, move.to)
      if (!proof.ok) {
        skipped.push({ providerId: move.providerId, name: move.name, to: move.to, reason: proof.error })
        continue
      }
    }
    deps.apply(move.providerId, move.to)
    moves.push(move)
  }
  const result: ModelCheckResult = { at: deps.now, moves, fresh: plan.fresh, skipped }
  saveModelCheck({ catalog: plan.catalog, last: result })
  return result
}
