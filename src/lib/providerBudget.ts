// SC Prism — per-brand token alerts.
//
// Sukhdeep asked for a limit per AI, and for the system to lean away from one
// that is running hot. This module is the honest core of that. It is built as
// much from what it REFUSES to claim as from what it computes, and each
// refusal comes from what the code can actually support:
//
// 1. NOT a reading of anyone's plan. No provider exposes remaining quota — no
//    endpoint, no CLI flag, no header. Every number here is the user's own
//    alert level, governing OUR OWN count of what we spent.
//
// 2. An ALERT, not a cap. Nothing checks mid-run, and one run emits many model
//    calls. Clamping the run budget to a brand's headroom would cap the LOCAL
//    half of a run because a cloud brand was near its alert — punishing the
//    cheap side for the expensive one.
//
// 3. Spend through a subscription CLI is a FLOOR, not an estimate with
//    symmetric error. Those bridges report no usage, so tokens are counted
//    from the prompt we handed over and the stdout we got back — while the CLI
//    runs its own agent loop whose every internal turn bills the plan
//    invisibly to us. Real spend is HIGHER by an unknown amount. So no bar is
//    drawn for those brands: a bar renders headroom, and we have none to show.
//
// 4. Nothing moves between cloud providers. The gateway builds a single
//    primary and has no fallback chain, so "shift from Gemini to Claude" is
//    not a capability this product has. The only shed available is toward
//    LOCAL — which is also the only direction that can never weaken privacy.

export type Brand = 'claude' | 'gemini' | 'openai' | 'local' | 'other'

/** Engine provider keys that report no usage, so our count is a floor. */
const CLI_BRIDGES = new Set(['claude-cli', 'gemini-cli', 'codex-cli'])

/**
 * The brand a provider key bills. `claude-cli` and `claude` are one plan from
 * the user's point of view, and a budget the user sets is about the plan.
 */
export function brandOf(providerKey: string): Brand {
  const k = (providerKey || '').toLowerCase()
  if (k.startsWith('local')) return 'local'
  if (k.startsWith('claude')) return 'claude'
  if (k.startsWith('gemini')) return 'gemini'
  // Codex bills an OpenAI plan, so it belongs in that bucket.
  if (k.startsWith('openai') || k.startsWith('codex')) return 'openai'
  return 'other'
}

/** Whether our count for this key is a floor rather than a measurement. */
export function isEstimatedSpend(providerKey: string): boolean {
  return CLI_BRIDGES.has((providerKey || '').toLowerCase())
}

/**
 * Starting points, deliberately round so they read as "someone picked this",
 * which is exactly what they are. A precise-looking default would imply a
 * measurement we did not make. Local gets none: it costs nothing but your own
 * electricity, and an alert there would be noise.
 */
export const DEFAULT_BRAND_BUDGETS: Record<Brand, number> = {
  claude: 10_000_000,
  gemini: 1_000_000,
  openai: 1_000_000,
  local: 0,
  other: 0,
}

/** Below this an alert would fire on ordinary work and be turned off. */
const MIN_BRAND_BUDGET = 50_000

export function clampBrandBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(MIN_BRAND_BUDGET, Math.floor(value))
}

export type BrandLevel = 'none' | 'ok' | 'warn' | 'reached'

export interface BrandBudgetStatus {
  level: BrandLevel
  /** null when no bar may honestly be drawn. */
  pct: number | null
  label: string
  note: string
}

export function brandBudgetStatus(input: {
  brand: Brand
  spent: number
  budget: number
  estimated: boolean
}): BrandBudgetStatus {
  const spent = Number.isFinite(input.spent) && input.spent > 0 ? Math.floor(input.spent) : 0
  const budget = clampBrandBudget(input.budget)
  const counted = `${spent.toLocaleString()} tokens counted`

  if (budget === 0) {
    return {
      level: 'none',
      pct: null,
      label: input.estimated ? `at least ${counted} · no alert set` : `${counted} · no alert set`,
      note: 'Set a number and we will tell you when our count passes it.',
    }
  }

  const ratio = spent / budget
  const level: BrandLevel = ratio >= 1 ? 'reached' : ratio >= 0.8 ? 'warn' : 'ok'

  // A bar renders headroom. Through a subscription bridge we have no headroom
  // to render — only a floor — so we show the number and no bar.
  const pct = input.estimated ? null : Math.max(0, Math.min(100, Math.round(ratio * 100)))
  const label = input.estimated
    ? `at least ${counted} of your ${budget.toLocaleString()} alert`
    : `${counted} of your ${budget.toLocaleString()} alert`

  const note =
    level === 'reached'
      ? 'Your alert level has been passed. Nothing was blocked — we only tell you.'
      : level === 'warn'
        ? 'Approaching your alert level.'
        : 'Your own alert level, counting what we spent.'
  return { level, pct, label, note }
}
