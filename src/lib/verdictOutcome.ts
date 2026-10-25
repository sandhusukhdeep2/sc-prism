// SC Prism — the ONE place the app reads a verdict's recorded outcome.
//
// The engine records `Verdict.outcome` as `passed` | `replied` | `attention` |
// `failed` (engine/scprism_engine/writeback.py :: build_verdict). ATTENTION is
// the run whose deterministic Tier-1 gate genuinely EXECUTED the project's
// checks over real written files and PASSED, while the Tier-2 LLM reviewer
// dissented on score — "the checks passed, the reviewer wasn't satisfied". It
// is not a pass (the reviewer still denies it, and `passed` stays the strict
// conjunction that gates project.py's git checkpoint and training rewards) and
// it is not the flat failure it used to be recorded as.
//
// REPLIED is a chat turn's pass: the Work page's conversation, judged by
// conversational criteria (contract mode 'converse') and cleared. Its `passed`
// is TRUE — a good reply is a success — but it is conversation, not task work,
// and the counting rule below holds it out of every pass rate the same way
// attention is held out. Folding replies into the failures is what put 32 red
// badges and "3% pass" on a team card; folding them into the passes would
// inflate the same rate with turns that verified nothing.
//
// Two rules every caller inherits by using these helpers:
//
//  1. ATTENTION (and REPLIED) ARE NEVER SYNTHESISED. Each is returned only
//     when the engine literally wrote that `outcome`. Nothing here infers one
//     from `passed`, a Tier-1 result or a score.
//  2. AN OLD VERDICT STAYS UNKNOWN. Verdicts written before the field existed
//     (and every browser-sim verdict) carry no `outcome`. A non-passing one is
//     reported as 'unknown-nonpass', NOT as 'failed': the app knows it did not
//     pass and knows nothing more, so every surface renders it exactly the way
//     it did before this change instead of back-filling a guess.

import type { Verdict } from '../engine/types'

/** The engine's own four values, as written on the verdict. */
export type VerdictOutcome = 'passed' | 'replied' | 'attention' | 'failed'

/**
 * How a surface should DRAW a verdict.
 *  - 'passed'         — the engine said passed (identical to today's pass).
 *  - 'replied'        — the engine said replied: a chat turn the judge
 *                       cleared. Quiet and neutral — never the pass gold,
 *                       never the non-pass coral.
 *  - 'attention'      — the engine said attention. The third state.
 *  - 'failed'         — the engine said failed.
 *  - 'unknown-nonpass'— `passed === false` with no recorded outcome. Renders
 *                       exactly as a non-pass rendered before this change;
 *                       surfaces deliberately draw it the same as 'failed',
 *                       which is what they already did — never as attention.
 */
export type VerdictTone = 'passed' | 'replied' | 'attention' | 'failed' | 'unknown-nonpass'

/** The subset of a Verdict these helpers need (so view-models can use them too). */
export interface OutcomeCarrier {
  passed: boolean
  outcome?: VerdictOutcome
}

/** The engine's recorded outcome, or undefined when it recorded none. Never guesses. */
export function recordedOutcome(v: OutcomeCarrier): VerdictOutcome | undefined {
  return v.outcome
}

/**
 * TRUE only when the engine itself recorded `attention`. This is the single
 * predicate every "is this the third state?" check in the app goes through, so
 * the rule "never synthesised" is enforced in one place.
 */
export function isAttention(v: OutcomeCarrier): boolean {
  return v.outcome === 'attention'
}

/**
 * TRUE only when the engine itself recorded `replied` — same never-synthesised
 * rule as `isAttention`. In particular `passed: true` alone is never a reply:
 * a replied verdict carries `passed: true`, but not the other way round.
 */
export function isReplied(v: OutcomeCarrier): boolean {
  return v.outcome === 'replied'
}

/** How to draw this verdict — see `VerdictTone`. */
export function verdictTone(v: OutcomeCarrier): VerdictTone {
  if (v.outcome === 'attention') return 'attention'
  if (v.outcome === 'replied') return 'replied'
  if (v.outcome === 'passed') return 'passed'
  if (v.outcome === 'failed') return 'failed'
  // No recorded outcome: all the app knows is `passed`.
  return v.passed ? 'passed' : 'unknown-nonpass'
}

/**
 * The judge claims the deterministic layer disproved, if any were recorded.
 * Empty array when the engine recorded none (or never ran the check) — the
 * caller shows nothing rather than "no contradictions", which would assert a
 * clean bill of health the older verdicts never earned.
 */
export function judgeContradictions(v: { tier2?: { contradictions?: readonly string[] } }): readonly string[] {
  return v.tier2?.contradictions ?? []
}

/**
 * One user-facing sentence naming what a judge contradiction MEANS. Returned
 * only when at least one was recorded; '' otherwise.
 */
export function contradictionLine(v: Pick<Verdict, 'tier2'>): string {
  const items = judgeContradictions(v)
  if (items.length === 0) return ''
  return `the reviewer contradicted measured evidence — ${items.join('; ')} — so its score is unreliable for this run`
}

// ---------------------------------------------------------------------------
// Counting three outcomes without lying about two
// ---------------------------------------------------------------------------

/**
 * The tally every pass-rate in this app is built from.
 *
 * THE RULE (one rule, used everywhere): an ATTENTION run is excluded from the
 * pass-rate DENOMINATOR, and its count is stated everywhere the rate is shown.
 * A REPLIED run — a chat turn the judge cleared — leaves the denominator the
 * same way, for the mirror-image reason below.
 *
 * Why, in full: attention means the measurement passed and only an LLM opinion
 * dissented. Counting it as a pass would claim a pass the engine explicitly
 * refuses to give. Counting it as a failure — which is what the app did until
 * now — lets that opinion silently pull down a statistic about measured work,
 * the exact inversion of the tier hierarchy this whole change exists to fix.
 * A ratio has no honest slot for a third value, so the undecided case leaves
 * the ratio and is REPORTED SEPARATELY. It is never dropped in silence: every
 * label that shows `rate` also shows `attention`, and every rate names its own
 * denominator ("of N decided runs") so it can't be misread as "of all runs".
 *
 * Replied is the same shape from the other side: its `passed` is TRUE (a good
 * reply is a success), so counting it naively would INFLATE a rate about task
 * work with conversation — after 32 chat turns already spent months deflating
 * that same rate to 3% as inferred write-task failures. Chat is neither a pass
 * nor a failure of work; it leaves the ratio and is reported separately.
 */
export interface OutcomeTally {
  runs: number // every run counted
  passes: number // runs the engine recorded as passed
  attention: number // runs the engine recorded as attention (NOT passes)
  replied: number // chat turns the engine recorded as replied (NOT passes)
  decided: number // runs - attention - replied: the pass-rate denominator
  passRate: number // passes / decided; 0 when decided === 0
}

/** Tally a set of verdicts under the rule above. */
export function tally(verdicts: readonly OutcomeCarrier[]): OutcomeTally {
  let passes = 0
  let attention = 0
  let replied = 0
  for (const v of verdicts) {
    if (isAttention(v)) attention++
    else if (isReplied(v)) replied++
    else if (v.passed) passes++
  }
  const runs = verdicts.length
  const decided = runs - attention - replied
  return {
    runs,
    passes,
    attention,
    replied,
    decided,
    passRate: decided === 0 ? 0 : passes / decided,
  }
}

/**
 * The suffix every pass-rate label carries: what the percentage is OF, plus the
 * runs held out of it. '' for an empty tally (the caller hides the rate).
 */
export function tallyLabel(t: OutcomeTally): string {
  // Chat replies held out of the rate, named like every other held-out count.
  const chat =
    t.replied > 0 ? ` · ${t.replied} repl${t.replied === 1 ? 'y' : 'ies'} (chat, not counted)` : ''
  if (t.decided === 0) {
    if (t.attention > 0) return `no decided runs · ${t.attention} needed a look${chat}`
    // Only conversation so far: claiming any task-work rate (or "no runs yet",
    // over runs that plainly happened) would both be false.
    if (t.replied > 0) return `no task runs · ${t.replied} repl${t.replied === 1 ? 'y' : 'ies'}`
    return 'no runs yet'
  }
  const base = `${Math.round(t.passRate * 100)}% pass of ${t.decided} decided run${t.decided === 1 ? '' : 's'}`
  return t.attention > 0 ? `${base} · ${t.attention} needed a look (not counted)${chat}` : `${base}${chat}`
}
