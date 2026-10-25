// Pure projections over the engine's observability dashboard, shared by every
// page that reports on it (Console, Memory, Stats). Extracted in the 2026-08-09
// honesty pass so the same measurement is never re-derived — and re-derived
// WRONGLY — on a second page.
//
// Finding 3a introduced `bucketProviders`: the engine emits provider keys like
// `claude-cli` / `gemini-cli` / `local`, so any comparison against a hardcoded
// 'claude' / 'gemini' silently matches nothing. Finding 2 then found Memory
// reporting "local handles 0%" from session verdict ROUTING while the engine's
// own model_call spans said 75% — so the local share now comes from here too.

import type { Dashboard, DashModelCost, Verdict } from '../engine/types'

export interface ProviderBurn {
  key: string // the engine's own provider key, e.g. 'claude-cli'
  label: string // display name, e.g. 'claude'
  tokens: number
  cost: number
  isLocal: boolean
}

/**
 * Group the dashboard's per-model costs by the provider keys the engine
 * ACTUALLY returns, biggest burn first. Nothing is invented: an unknown key
 * keeps its own name, and `-cli` is stripped for display only (it is a
 * transport detail — the tokens are still Claude's / Gemini's).
 */
export function bucketProviders(costByModel: Record<string, DashModelCost>): ProviderBurn[] {
  const byProvider = new Map<string, { tokens: number; cost: number }>()
  for (const m of Object.values(costByModel ?? {})) {
    const key = m.provider || 'unknown'
    const prev = byProvider.get(key) ?? { tokens: 0, cost: 0 }
    byProvider.set(key, { tokens: prev.tokens + (m.tokens || 0), cost: prev.cost + (m.cost || 0) })
  }
  return [...byProvider.entries()]
    .map(([key, m]) => ({
      key,
      label: key.replace(/-cli$/, ''),
      tokens: m.tokens,
      cost: m.cost,
      isLocal: key === 'local' || key.startsWith('local'),
    }))
    .sort((a, b) => b.tokens - a.tokens)
}

export interface LocalShare {
  localTokens: number
  cloudTokens: number
  totalTokens: number
  localCost: number
  cloudCost: number
  totalCost: number
  /** 0..100, rounded. 0 when nothing has been measured — never a guess. */
  pct: number
  /** false when the engine measured no tokens at all, so callers can say so. */
  measured: boolean
}

/**
 * The share of MEASURED tokens that ran on a local model — the engine's own
 * model_call spans, not top-level verdict routing. `local`-prefixed provider
 * keys are local (so a future `local-mlx` still counts); everything else is
 * cloud.
 */
export function localShare(costByModel: Record<string, DashModelCost>): LocalShare {
  const providers = bucketProviders(costByModel)
  let localTokens = 0
  let cloudTokens = 0
  let localCost = 0
  let cloudCost = 0
  for (const p of providers) {
    if (p.isLocal) {
      localTokens += p.tokens
      localCost += p.cost
    } else {
      cloudTokens += p.tokens
      cloudCost += p.cost
    }
  }
  const totalTokens = localTokens + cloudTokens
  return {
    localTokens,
    cloudTokens,
    totalTokens,
    localCost,
    cloudCost,
    totalCost: localCost + cloudCost,
    pct: totalTokens ? Math.round((localTokens / totalTokens) * 100) : 0,
    measured: totalTokens > 0,
  }
}

// --- Finding 4: the hero comes from MEASURED engine data, not the session ---
// `stats.tier1Saves` counted verdicts inside ONE app launch, and only ever
// incremented on a Tier-1 pass — which never happened while the verify command
// was unreachable (Finding 0). The engine's tier1 span history is the real
// record: how many runs the free gate blocked (each one short-circuits Tier-2,
// so the judge's tokens are never spent), over how many runs, and why.

export interface HeroSaves {
  /** blocked runs — the hero number. Runs the gate could not RUN are excluded. */
  saves: number
  /** how many runs the gate actually ran on. */
  ran: number
  /** true when this is the engine's full history, false when session-only. */
  engineScoped: boolean
  /** true while the first engine read is still in flight — nothing measured YET. */
  pending: boolean
  /** what the number is, or why it is zero. Always shown. */
  note: string
  /** runs where the gate could not run at all — nothing was verified. */
  unrunnable: number
  /** failed runs recorded before the app distinguished blocked from unrunnable. */
  unknown: number
  /** the unrunnable/unknown runs said out loud, or '' when there are none. */
  unverifiedNote: string
  /** per-check attribution of the saves. */
  caught: { tests: number; lint: number; build: number; other: number }
  /** eval tokens a save avoided, priced from measured judge spend. Null = unpriceable. */
  avoidedTokens: number | null
  avoidedBasis: string
}

const NO_CAUGHT = { tests: 0, lint: 0, build: 0, other: 0 }

/** The hero while the engine has not answered yet: a number, but not a claim. */
export function pendingHero(): HeroSaves {
  return {
    saves: 0,
    ran: 0,
    engineScoped: true,
    pending: true,
    note: 'reading the engine…',
    unrunnable: 0,
    unknown: 0,
    unverifiedNote: '',
    caught: { ...NO_CAUGHT },
    avoidedTokens: null,
    avoidedBasis: 'reading the engine…',
  }
}

/**
 * The Tier-1 hero, correct in all three states: real saves, zero-with-a-reason,
 * and a gate that could not run at all.
 *
 * A "save" is a run the gate BLOCKED — the checks ran and caught something, so
 * Tier-2 short-circuited and the judge's tokens were never spent. It is not
 * every failed Tier-1. On the user's install every one of the 53 failures was
 * the gate itself failing to run (`npm` could not find a project), and counting
 * those produced a gold "53 saves · tests caught 53 · ~61k eval tokens avoided"
 * over 53 runs that verified NOTHING and avoided nothing. Unrunnable and
 * not-yet-classified runs are therefore excluded from `saves`, from `caught`,
 * and from the pricing, and are reported on their own line instead.
 */
export function heroSaves(dash: Dashboard | null, verdicts: readonly Verdict[]): HeroSaves {
  const t1 = dash?.tier1
  if (t1) {
    const unrunnable = t1.not_found ?? 0
    // `unknown`/`blocked` arrive from a current engine; derive them honestly
    // from the fields an older dashboard does carry.
    const unknown = t1.unknown ?? 0
    const blocked = t1.blocked ?? Math.max(0, t1.failed - unrunnable - unknown)
    const unverified = unrunnable + unknown
    const c = t1.caught ?? {}
    const caught = {
      tests: c.tests ?? 0,
      lint: c.lint ?? 0,
      build: c.build ?? 0,
      other: c.other ?? 0,
    }
    // Pricing is a claim about avoided judge spend. A run that never verified
    // anything never reached the judge decision, so it cannot be priced — and
    // with zero real saves there is nothing to price at all.
    const priced = blocked > 0 && t1.judged_runs > 0 && t1.avg_judge_tokens > 0

    const unverifiedNote =
      unrunnable > 0 && unknown > 0
        ? `${unrunnable} run${unrunnable === 1 ? '' : 's'} could not run the verify command — nothing was verified · ${unknown} older run${unknown === 1 ? '' : 's'} failed the gate before the app recorded why`
        : unrunnable > 0
          ? `${unrunnable} run${unrunnable === 1 ? '' : 's'} could not run the verify command — nothing was verified`
          : unknown > 0
            ? `${unknown} older run${unknown === 1 ? '' : 's'} failed the gate before the app recorded why — not counted either way`
            : ''

    // The two honest halves of "skipped". Telling a user who configured
    // `npm test` that they configured no verify command is a lie — the gate
    // skipped because those runs (chat, manager reports, heartbeat wakes) had
    // no project directory, i.e. no code to check.
    const nothingToVerify = t1.skipped_nothing_to_verify ?? 0
    const noCommand = t1.skipped_no_commands ?? Math.max(0, t1.skipped - nothingToVerify)
    const skipNote =
      nothingToVerify > 0 && noCommand > 0
        ? `${nothingToVerify} had no project bound (nothing to verify) and ${noCommand} had no verify command`
        : nothingToVerify > 0
          ? 'no project was bound, so there was nothing to verify'
          : 'no verify command configured'

    let note: string
    if (t1.runs === 0) note = 'no run has reached the Tier-1 gate yet'
    else if (t1.ran === 0)
      note = `the gate was skipped on all ${t1.runs} runs — ${skipNote}`
    else if (blocked === 0 && unverified > 0)
      note = `nothing has been verified yet: the gate could not run on ${unverified} of ${t1.ran} checked runs`
    else if (blocked === 0)
      note = `nothing to block: all ${t1.ran} checked runs passed Tier-1`
    else note = `${blocked} blocked across ${t1.ran} checked runs`

    return {
      saves: blocked,
      ran: t1.ran,
      engineScoped: true,
      pending: false,
      note,
      unrunnable,
      unknown,
      unverifiedNote,
      caught,
      avoidedTokens: priced ? Math.round(blocked * t1.avg_judge_tokens) : null,
      avoidedBasis: priced
        ? `est. from ${Math.round(t1.avg_judge_tokens)} avg judge tokens over ${t1.judged_runs} judged runs`
        : blocked === 0
          ? 'nothing was blocked, so nothing was avoided'
          : 'no judged run yet to price a save',
    }
  }
  // Session-scoped fallback (browser, or an engine build with no tier1 block).
  // Same definition — a blocked run — but said out loud to be session-only.
  const blocked = verdicts.filter((v) => !v.tier1.pass)
  const caught = { tests: 0, lint: 0, build: 0, other: 0 }
  for (const v of blocked) {
    if (!v.tier1.lint) caught.lint++
    else if (!v.tier1.build) caught.build++
    else caught.tests++
  }
  return {
    saves: blocked.length,
    ran: verdicts.length,
    engineScoped: false,
    pending: false,
    note: verdicts.length
      ? `${blocked.length} blocked across ${verdicts.length} runs in THIS session (engine history unavailable)`
      : 'no runs in this session yet — engine history unavailable here',
    unrunnable: 0,
    unknown: 0,
    unverifiedNote: '',
    caught,
    avoidedTokens: null,
    avoidedBasis: 'judge spend is only measured by the installed app',
  }
}
