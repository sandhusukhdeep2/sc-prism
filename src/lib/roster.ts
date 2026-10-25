// SC Prism — who may take a seat on a team, and what to SAY about anyone who
// may not (2026-08-12).
//
// THE BUG THIS EXISTS TO KILL. A team run gave every enabled agent a seat and
// never asked whether that agent's model mapped to a provider the app could
// actually reach. A live run recorded
//   models_used: ['claude-cli · opus', 'local · gemma…', 'gemini-cli · opus']
// with the gemini-cli call `is_real: false`, 13 tokens out — an hour AFTER the
// gemini-cli provider was switched off in Settings, because Google had closed
// that login for individual accounts. The agent sat at the table and its
// contribution was an offline stub the board rendered as a real seat.
//
// AGENT-ENABLED AND PROVIDER-CONNECTED ARE DIFFERENT FACTS. This module holds
// the second one and turns it into a sentence a person can act on. Two rules
// it will not break:
//   1. No silent shrinking. An excluded seat is REPORTED with its reason —
//      dropping an agent quietly is the same dishonesty as stubbing it.
//   2. No empty team. If every seat is excluded, the launch is REFUSED and
//      says why, instead of running a one-stub "team".
//
// "Usable" is not defined here. It is `providerUsable` in lib/settings.ts —
// the exact "real + configured" test `buildEngineProviders` applies to the
// primary (its `primaryReal`) — plus live health when we have it.

import {
  CLI_PROVIDERS,
  brandViews,
  cachedCliProbe,
  isCliProvider,
  isCustomProvider,
  providerUsable,
  type CliProbe,
  type ProviderConfig,
  type ProviderStatus,
  type Settings,
} from './settings'

/** A settled-or-in-flight health reading, shaped like connectivity's
 *  `ServiceHealth` so the live map can be passed straight in. */
export interface ProviderHealth {
  status: 'checking' | ProviderStatus
  detail?: string
}

/** Health keyed by provider id (connectivity's `health`). Absent = unknown. */
export type ProviderHealthMap = Record<string, ProviderHealth | undefined>

/** One roster pair, split. `role` is the name before the colon. */
export interface RosterPair {
  role: string
  token: string
}

/** A seat that was NOT given, and the honest reason it was not. */
export interface SitOut {
  role: string
  token: string
  reason: string
}

/**
 * A roster token → '' when that provider may take the seat, else the reason it
 * may not, phrased for a person ("Gemini CLI (Google login) isn't connected").
 */
export type RosterGate = (token: string) => string

/**
 * The provider a roster token actually runs on.
 *
 * A token is normally a provider id ('local', 'claude-cli', 'custom-1'), and an
 * agent's `model` ('claude' | 'gemini' | 'local') is one too. But the cloud
 * brands are PAIRED — Claude is either the API key half or the Pro/Max CLI
 * half, never both — so the token 'claude' means "Claude", and the provider it
 * runs on is whichever half the user has switched on. Resolving that here is
 * what stops an agent on 'claude' being thrown off a team whose user is signed
 * in through the subscription CLI.
 *
 * Falls back to the literal id (enabled or not) so callers can still NAME the
 * provider in a refusal.
 */
export function resolveProviderToken(
  settings: Settings,
  token: string,
): ProviderConfig | undefined {
  const exact = settings.providers.find((p) => p.id === token)
  if (exact?.enabled) return exact
  const brand = brandViews(settings).find((v) => v.brand === token)
  if (brand?.enabled) return brand.active
  return exact
}

/** The live status we hold for a provider, or undefined when unknown. A CLI's
 *  cached liveness probe counts: it is the only thing that tells "installed"
 *  from "installed and able to answer". */
function settledStatus(
  p: ProviderConfig,
  health: ProviderHealthMap,
  probe: (id: string) => CliProbe | undefined,
): { status: ProviderStatus; detail: string } | undefined {
  const cli = isCliProvider(p.id) ? probe(p.id) : undefined
  if (cli) return { status: cli.status, detail: cli.detail }
  const h = health[p.id]
  if (!h || h.status === 'checking') return undefined
  return { status: h.status, detail: h.detail ?? '' }
}

/**
 * Why this token cannot take a seat — '' when it can.
 *
 * Order matters: the most specific true thing first, so the sentence tells the
 * user what to DO (switch it on / install it / sign in again / paste a key).
 */
export function seatReason(
  settings: Settings,
  token: string,
  opts?: { health?: ProviderHealthMap; probe?: (id: string) => CliProbe | undefined },
): string {
  const health = opts?.health ?? {}
  const probe = opts?.probe ?? cachedCliProbe
  const t = token.trim()
  if (!t) return 'no model was named for this seat'
  const p = resolveProviderToken(settings, t)
  if (!p) return `no “${t}” provider is set up`
  if (!p.enabled) return `${p.name} is switched off in Settings`

  // Credential/config — the same test the engine's own `primaryReal` uses.
  if (!providerUsable(p)) {
    if (p.id === 'local' || isCustomProvider(p.id)) return `${p.name} has no server URL`
    return `${p.name} has no API key`
  }

  // Live health. Unknown is NOT a reason — we never exclude on a guess.
  const live = settledStatus(p, health, probe)
  if (!live || live.status === 'ok') return ''
  if (isCliProvider(p.id)) {
    if (live.status === 'unreachable') {
      return `${p.name} isn't installed on this Mac`
    }
    // Installed but cannot answer — signed out, or a login the vendor closed.
    // Their words, not ours.
    return live.detail
      ? `${p.name} is installed but can't answer — ${live.detail}`
      : `${p.name} is installed but can't answer`
  }
  return live.status === 'auth'
    ? `${p.name} rejected its key`
    : `${p.name} is unreachable right now`
}

/** The gate for one settings snapshot: token → '' or the reason it sits out. */
export function rosterGate(
  settings: Settings,
  opts?: { health?: ProviderHealthMap; probe?: (id: string) => CliProbe | undefined },
): RosterGate {
  return (token: string) => seatReason(settings, token, opts)
}

/** A gate that lets everything through — for the browser/sim paths and for
 *  tests that are about roster SHAPE, not connectivity. Named so a caller has
 *  to say out loud that it is skipping the check. */
export const allowAllProviders: RosterGate = () => ''

/** Split `role:token,role:token` into pairs (blank/rubbish entries dropped). */
export function splitRoster(roster: string): RosterPair[] {
  return roster
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':')
      const role = (i < 0 ? part : part.slice(0, i)).trim()
      const token = (i < 0 ? '' : part.slice(i + 1)).trim() || 'local'
      return { role, token }
    })
    .filter((p) => !!p.role)
}

/**
 * Drop the seats whose provider cannot work, KEEPING the reasons. The kept
 * tokens are rewritten to the provider that will really run them (the brand
 * pairing above), so the roster the engine receives names providers the app can
 * actually reach — an unreachable name in that string is exactly how a stub got
 * onto the board in the first place.
 *
 * A roster where every provider is connected comes back byte-identical.
 */
/** One seat moved off its preferred provider onto one that can answer. */
export interface Reassigned {
  role: string
  from: string
  to: string
  reason: string
}

export function filterRoster(
  roster: string,
  gate: RosterGate,
  settings?: Settings,
): { roster: string; sitOut: SitOut[]; reassigned: Reassigned[] } {
  const kept: string[] = []
  const sitOut: SitOut[] = []
  const reassigned: Reassigned[] = []
  // NO SEAT DIES WITH ITS BRAND (Sukhdeep, 2026-08-29: "if we don't have
  // Gemini set up, let the manager choose another way — use the cloud for
  // research"). A gated seat is REASSIGNED to the best provider that can
  // answer — the user's PRIMARY first (their chosen center of gravity), then
  // the brands in preference order — with the reason carried so every surface
  // that announces the crew announces the move. The approve-team gate showing
  // the resolved roster is the "ask me". A seat only sits out when NOTHING on
  // this install can answer, and the empty-roster refusal is unchanged.
  const primaryTok = settings?.providers.find((p) => p.primary && p.enabled)?.id ?? ''
  const candidates = [primaryTok, 'claude', 'local', 'gemini', 'openai'].filter(Boolean)
  for (const { role, token } of splitRoster(roster)) {
    const reason = gate(token)
    if (reason) {
      const to = candidates.find((c) => c !== token && !gate(c))
      if (to) {
        const resolvedTo = (settings ? resolveProviderToken(settings, to)?.id : undefined) || to
        kept.push(`${role}:${resolvedTo}`)
        reassigned.push({ role, from: token, to: resolvedTo, reason })
        continue
      }
      sitOut.push({ role, token, reason })
      continue
    }
    const resolved = settings ? resolveProviderToken(settings, token)?.id : undefined
    kept.push(`${role}:${resolved || token}`)
  }
  return { roster: kept.join(','), sitOut, reassigned }
}

/** One line naming every seat that MOVED and why — announced wherever the
 *  crew is announced, so a reassignment can never be a silent surprise. */
export function reassignLine(reassigned: Reassigned[]): string {
  if (reassigned.length === 0) return ''
  return reassigned
    .map((r) => `${r.role} reassigned ${r.from} → ${r.to} (${r.reason})`)
    .join(' · ')
}

/** One line naming everyone who sat out and why — the thing the user must be
 *  able to read instead of quietly getting a smaller team. */
export function sitOutLine(sitOut: SitOut[]): string {
  if (sitOut.length === 0) return ''
  return sitOut.map((s) => `${s.role} sits out: ${s.reason}`).join(' · ')
}

/**
 * The honest refusal when NOTHING is left. Never "team run failed": the run was
 * never started, nothing was queued, and the reason is the user's own setup.
 *
 * TWO different empties, told apart, because they need different fixes — every
 * seat was excluded (each reason named), or there were no seats at all, which
 * is what an empty default roster means: not one provider is connected. Neither
 * may be quietly swallowed by a caller treating '' as "just use the defaults".
 */
export function emptyRosterRefusal(sitOut: SitOut[]): string {
  if (sitOut.length === 0) {
    return 'No team could be assembled: no AI provider is connected. Connect one in Settings and launch again.'
  }
  return `No agent could run: every seat on this team is on a provider that isn't connected — ${sitOutLine(sitOut)}. Connect one in Settings and launch again.`
}

/** The CLI-bridge providers currently switched on — Settings shows their real
 *  three-state health, and this is who to ask about. */
export function enabledCliProviders(settings: Settings): ProviderConfig[] {
  return settings.providers.filter((p) => p.enabled && p.id in CLI_PROVIDERS)
}
