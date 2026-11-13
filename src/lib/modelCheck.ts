// The day's first model check (2026-11-14).
//
// Once a day the app asks each connected AI what models it offers, remembers
// the answer, and says what is new. It may also MOVE an AI to a newer model.
// Every move is decided by the rules in this file — never by a model:
//
//   • A metered key moves only to a newer version of the SAME model
//     (claude-fable-5-1 → claude-fable-5-2). Never to another tier, a preview
//     or a mini: those change the bill or the behaviour, and that is the
//     user's call.
//   • The primary on a subscription CLI moves to the top model the plan offers
//     (opus → fable). A tier move there costs limits, not money — and it only
//     happens once that model has actually answered (see modelCheckRun.ts).
//   • The local AI is never moved. Its place on the workload slider was
//     measured on the model it has; a new local model is reported and left
//     for the user to pick.
//
// Pure: no store, no clock, no network. The runner supplies all three.

import { CLI_MODEL_CHOICES, isCliProvider, providerUsable, type ProviderConfig } from './settings'

/** What each AI offered the last time it was asked. */
export type ModelCatalog = Record<string, { models: string[]; at: number }>

export interface ModelMove {
  providerId: string
  name: string
  from: string
  to: string
  /** 'newer' — a newer version of the same model. 'greatest' — the top model
   *  of a subscription plan. */
  why: 'newer' | 'greatest'
}

export interface ModelFresh {
  providerId: string
  name: string
  models: string[]
}

/** A move the rules chose that was not made, in the AI's own words. */
export interface ModelSkip {
  providerId: string
  name: string
  to: string
  reason: string
}

export interface ModelCheckResult {
  at: number
  moves: ModelMove[]
  fresh: ModelFresh[]
  skipped: ModelSkip[]
}

/** Due once per calendar day (local time), and when it has never run. */
export function checkDue(lastAt: number, now: number): boolean {
  if (!lastAt) return true
  const a = new Date(lastAt)
  const b = new Date(now)
  return (
    a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()
  )
}

/**
 * A model id as a family and a version. The words are the family
 * (`claude-fable`), the numbers the version (`[5, 2]`); a snapshot date is
 * neither. A qualifier — preview, mini, latest — is a word, so it makes a
 * different family, which is what keeps a move inside one model line.
 */
export function parseModelId(id: string): { family: string; version: number[] } {
  const words: string[] = []
  const version: number[] = []
  let inDate = false
  for (const token of id.trim().toLowerCase().split(/[-_/:]+/)) {
    if (!token) continue
    if (/^\d+(\.\d+)*$/.test(token)) {
      // 20250929, or the 2024 of 2024-08-06 and the parts after it.
      const year = /^(19|20)\d\d$/.test(token)
      if (/^\d{8}$/.test(token) || year || inDate) {
        inDate = inDate || year
        continue
      }
      for (const part of token.split('.')) version.push(Number(part))
    } else {
      inDate = false
      words.push(token)
    }
  }
  return { family: words.join('-'), version }
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The newest listed version of the model `current` is — or '' when there is
 * none, when `current` is an always-current alias (no version to beat), or
 * when its name says nothing we can compare.
 */
export function newerInFamily(current: string, listed: readonly string[]): string {
  const mine = parseModelId(current)
  if (!mine.family || mine.version.length === 0) return ''
  let best = ''
  let bestVersion = mine.version
  for (const id of listed) {
    const other = parseModelId(id)
    if (other.family !== mine.family) continue
    const d = compareVersions(other.version, bestVersion)
    // On a tie between a newer model's alias and its dated snapshot, take the
    // alias — the shorter name.
    if (d > 0 || (d === 0 && best !== '' && id.length < best.length)) {
      best = id
      bestVersion = other.version
    }
  }
  return best
}

const NOT_CHAT =
  /(embed|whisper|tts|audio|speech|transcribe|image|imagen|dall-?e|sora|veo|moderation|rerank|realtime|aqa)/i

/** The listed models a conversation can use. */
export function chatModels(ids: readonly string[]): string[] {
  return ids.filter((id) => !NOT_CHAT.test(id))
}

/** What was not there last time. A first look claims nothing is new. */
export function newSince(prev: readonly string[] | undefined, listed: readonly string[]): string[] {
  if (!prev) return []
  const seen = new Set(prev)
  return listed.filter((id) => !seen.has(id))
}

/** The most capable alias each subscription CLI offers. Hand-kept beside
 *  `CLI_MODEL_CHOICES`: a CLI lists nothing, and the aliases resolve to the
 *  newest model of their tier on their own. */
const CLI_GREATEST: Record<string, string> = {
  // Claude only: it is the one CLI whose runs are passed a model at all (the
  // gateway's `--model`). Moving any other CLI's setting would change a value
  // nothing reads.
  'claude-cli': 'fable',
}

/**
 * The top model for a subscription CLI when `current` is one of its curated
 * aliases below it — else ''. The CLI's own default ('') and a hand-typed id
 * are choices the user made on purpose and are left alone.
 */
export function topCliChoice(providerId: string, current: string): string {
  const top = CLI_GREATEST[providerId]
  const curated = CLI_MODEL_CHOICES[providerId]
  if (!top || !curated || current === top) return ''
  return curated.some((c) => c.value === current) ? top : ''
}

/**
 * What the day's check records and proposes. `listings` holds what each AI
 * answered — an AI missing from it could not be read and keeps its last
 * record. With `auto` off nothing is moved; the record and the report are the
 * same.
 */
export function planModelCheck(input: {
  providers: readonly ProviderConfig[]
  catalog: ModelCatalog
  listings: Readonly<Record<string, readonly string[]>>
  now: number
  auto: boolean
}): { catalog: ModelCatalog; moves: ModelMove[]; fresh: ModelFresh[] } {
  const catalog: ModelCatalog = { ...input.catalog }
  const moves: ModelMove[] = []
  const fresh: ModelFresh[] = []
  for (const p of input.providers) {
    if (!providerUsable(p)) continue
    const current = (p.model ?? '').trim()
    if (isCliProvider(p.id)) {
      const to = input.auto && p.primary ? topCliChoice(p.id, current) : ''
      if (to) moves.push({ providerId: p.id, name: p.name, from: current, to, why: 'greatest' })
      continue
    }
    const listed = input.listings[p.id]
    if (!listed || listed.length === 0) continue
    const added = chatModels(newSince(input.catalog[p.id]?.models, listed))
    if (added.length > 0) fresh.push({ providerId: p.id, name: p.name, models: added })
    catalog[p.id] = { models: [...listed], at: input.now }
    if (!input.auto || p.id === 'local') continue
    const to = newerInFamily(current, chatModels(listed))
    if (to) moves.push({ providerId: p.id, name: p.name, from: current, to, why: 'newer' })
  }
  return { catalog, moves, fresh }
}

/** The check in one line — '' when there is nothing to say. */
export function modelCheckLine(result: ModelCheckResult): string {
  const few = (models: readonly string[]) =>
    models.slice(0, 3).join(', ') + (models.length > 3 ? ` +${models.length - 3} more` : '')
  return [
    ...result.moves.map((m) => `${m.name} now runs on ${m.to} (was ${m.from || 'its default'})`),
    ...result.fresh.map((f) => `new on ${f.name}: ${few(f.models)}`),
    ...result.skipped.map(
      (s) => `${s.name} stays as it is — ${s.to} did not answer${s.reason ? ` (${s.reason})` : ''}`,
    ),
  ].join(' · ')
}
