// SC Prism — the token budget, made visible.
//
// This module exists because of a specific failure. A live three-agent board
// spent 110,873 tokens against the 100,000 default: the researcher did real
// web research, the analyst ran ten tool turns, the third agent never got a
// turn, and the manager returned an EMPTY answer. The budget worked exactly as
// designed — and it was invisible, so there was no way to see it coming, no
// way to raise it, and no explanation afterwards.
//
// A limit the user cannot see is indistinguishable from a bug.

/** The engine's own default (engine/scprism_engine/contract.py). */
export const DEFAULT_TOKEN_BUDGET = 100_000

/** Below this, a run breaches before the first agent can answer. */
const MIN_BUDGET = 10_000

/** Above this, one run could eat a plan. */
const MAX_BUDGET = 2_000_000

/**
 * A budget the engine will accept.
 *
 * 0 round-trips as 0 on purpose: it is the documented "let the engine decide"
 * value on the CLI, and coercing it to a number would silently override a
 * default the user never chose to change.
 */
export function clampBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(value)))
}

export type BudgetLevel = 'ok' | 'warn' | 'over'

export interface BudgetStatus {
  level: BudgetLevel
  /** 0-100, clamped — the bar can't overflow even when the spend did. */
  pct: number
  label: string
  note: string
}

/**
 * Where this run (or today's spend) sits against the budget.
 *
 * The engine breaches on `>=`, so reaching the budget is already over, not
 * "just at it". Warning starts at 80% — the point of a warning is to arrive
 * while there is still something to do about it.
 */
export function budgetStatus(used: number, budget: number): BudgetStatus {
  const effective = clampBudget(budget) || DEFAULT_TOKEN_BUDGET
  const spent = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0
  const ratio = spent / effective
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)))

  const level: BudgetLevel = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok'
  const label = `${spent.toLocaleString()} of ${effective.toLocaleString()} tokens`
  const note =
    level === 'over'
      ? 'This run stopped at the budget. The crew still reports what it finished.'
      : level === 'warn'
        ? 'Close to the budget — a run that reaches it will stop and report partial work.'
        : 'A run that reaches the budget will stop and report what it finished.'
  return { level, pct, label, note }
}

export interface DailyUsage {
  label: string
}

/**
 * Today's spend, reported as its OWN fact.
 *
 * Deliberately has no percentage and no bar. Found on the real screen
 * 2026-09-03: the card showed "3,570,818 of 100,000 tokens today · This run
 * stopped at the budget", comparing a cumulative daily total against a PER-RUN
 * limit. The bar was pinned red forever and asserted a run had stopped when
 * none had.
 *
 * There is no daily budget, so there is nothing for the total to be a
 * percentage "of". Showing one would invent a limit that does not exist —
 * exactly the failure the per-run budget card was built to end.
 */
export function dailyUsage(tokensToday: number, runsToday: number): DailyUsage {
  const tokens = Number.isFinite(tokensToday) && tokensToday > 0 ? Math.floor(tokensToday) : 0
  const runs = Number.isFinite(runsToday) && runsToday > 0 ? Math.floor(runsToday) : 0
  if (runs === 0 && tokens === 0) return { label: 'No runs yet today.' }
  const word = runs === 1 ? '1 run ' : `${runs.toLocaleString()} runs `
  return { label: `${tokens.toLocaleString()} tokens today, across ${word}` }
}
