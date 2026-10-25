// SC Prism — adaptive live-primary interview questions (2026-07-29 spec).
//
// After the seed answers (business description + company/research) the PRIMARY
// generates each next interview question through ONE governed engine run —
// the same buildEngineProviders → runNativeTask → Promise.race → isRealCompletion
// idiom the research brief uses. Everything here is pure or injected-deps
// (the `projectInterview.ts` idiom) so the page never drifts from the honesty
// rules and the whole seam is unit-testable without React or the native bridge.
//
// HONESTY (binding, from the spec):
// - The interview NEVER blocks on a provider — every generation races a
//   timeout, and any failure drops to the scripted questions immediately.
// - A scripted fallback question is visibly marked with
//   STANDARD_FALLBACK_MARKER — a canned question is never presented as
//   generated, and a generated question is only attributed to the REAL model
//   the Verdict recorded (no meta → no attribution, never fabricated).

import type { EngineImage, EngineProviders } from './nativeEngine'

/** Cap on the adaptive phase — at most this many generated questions. */
export const ADAPTIVE_MAX = 5

/** Hard token cap per question-generation run (rides `--token-budget`). */
export const ADAPTIVE_TOKEN_BUDGET = 4_000

/** Race cap per generation. One sentence with a 4k budget needs far less than
 * the research brief's 120s, but a subscription-CLI cold start is slow — 60s
 * is generous without ever wedging the interview for minutes. */
export const ADAPTIVE_TIMEOUT_MS = 60_000

/** The exact honest marker a scripted fallback question carries on screen. */
export const STANDARD_FALLBACK_MARKER = '(standard question — no live model)'

/** How a scripted fallback question reads in the chat — the question plus the
 * honest marker. Pinned here (and in tests) so the page can never drift. */
export function scriptedFallbackDisplay(question: string): string {
  return `${question} ${STANDARD_FALLBACK_MARKER}`
}

/** The seed answers + adaptive Q&A gathered so far — the generation context. */
export interface AdaptiveAnswers {
  business: string
  companyName: string
  qa: { q: string; a: string }[]
}

/**
 * The generation prompt: interview goal + answers so far + the one-question
 * ask. The reply contract ("ONLY the question text, one sentence") is what
 * `sanitizeGeneratedQuestion` enforces on the way back.
 */
export function buildAdaptiveQuestionPrompt(ctx: AdaptiveAnswers): string {
  return [
    '[SETUP INTERVIEW] You are onboarding a business owner onto SC Prism — an AI workbench with governance (routing, sign-off gates, never-touch lists, local-first privacy).',
    'Interview goal: learn enough about their business to set up their AI workbench well — how they work, what to automate first, and where the risks are.',
    `Business description: ${ctx.business || '(none given)'}`,
    ctx.companyName ? `Company: ${ctx.companyName}` : '',
    ctx.qa.length ? 'Answers so far:' : '',
    ...ctx.qa.map((x) => `Q: ${x.q}\nA: ${x.a}`),
    '',
    'Ask the ONE next most useful question for setting up their AI workbench; reply with ONLY the question text, one sentence.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Reduce a raw model reply to one clean question line, or `null` when the
 * reply is unusable (empty, or multiple non-empty lines — the model ignored
 * "one sentence", so the caller falls back to a scripted question rather than
 * showing a mangled one). Strips list bullets/numbering, chatty prefixes
 * ("Question:", "Q:"), wrapping quotes/asterisks, and caps length at ~200
 * chars so a runaway sentence can't flood the chat bubble.
 */
export function sanitizeGeneratedQuestion(raw: string): string | null {
  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (lines.length !== 1) return null
  let q = lines[0]
  q = q.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '')
  q = q.replace(/^["'“‘`*]+/, '').replace(/["'”’`*]+$/, '')
  q = q.replace(/^(?:next question|question|q)\s*[:.\-–—]\s*/i, '')
  q = q.replace(/^["'“‘`*]+/, '').replace(/["'”’`*]+$/, '').trim()
  if (!q) return null
  if (q.length > 200) q = `${q.slice(0, 199).trimEnd()}…`
  return q
}

/** What the interview does for its next question slot. */
export type AdaptiveStep = { kind: 'generate' } | { kind: 'scripted'; marked: boolean }

/**
 * Decide the next question slot, kept pure so the cap is testable without
 * rendering (the `chatTurnFromOutcome` discipline):
 * - cap reached → the normal scripted flow, NO marker (nothing failed and
 *   nothing pretends to be generated);
 * - not installed / no real primary → scripted WITH the honest marker (a
 *   generated question was the plan, no live model could deliver it);
 * - otherwise → generate. A runtime generation failure is handled by the
 *   caller the same way: scripted, marked.
 */
export function nextAdaptiveStep(
  turnsTaken: number,
  native: boolean,
  primaryReal: boolean,
): AdaptiveStep {
  if (turnsTaken >= ADAPTIVE_MAX) return { kind: 'scripted', marked: false }
  if (!native || !primaryReal) return { kind: 'scripted', marked: true }
  return { kind: 'generate' }
}

/** The structural slice of a Verdict this module reads — the full native
 * Verdict satisfies it, and tests can fabricate just these fields. */
export interface AdaptiveRunVerdict {
  response?: string
  native?: { models_used?: readonly string[] }
  route?: { model?: string; target?: string; reason?: string }
}

/** A successfully generated question with its HONEST attribution — `model` is
 * the real "provider · model" the Verdict recorded ('' = none reported → the
 * page shows no attribution line rather than inventing one). */
export interface GeneratedQuestion {
  q: string
  model: string
  isLocal: boolean
}

/** Injected dependencies (the `runInterviewTurn` idiom — no store import, no
 * React): the page passes the REAL `runNativeTask`, `isRealCompletion` and
 * `messageModelFromVerdict`; tests pass spies. `runTask` matches
 * `runNativeTask`'s positional signature so the token budget lands on the
 * real trailing parameter with no untested adapter hop in between. */
export interface AdaptiveQuestionDeps<V extends AdaptiveRunVerdict = AdaptiveRunVerdict> {
  runTask: (
    intent: string,
    vault: string,
    providers?: EngineProviders,
    runId?: string,
    route?: 'local' | 'cloud' | 'auto',
    image?: EngineImage,
    tokenBudget?: number,
  ) => Promise<V | null>
  isRealCompletion: (s: string | undefined) => s is string
  /** Honest per-message attribution from the REAL Verdict (AppStore's
   * `messageModelFromVerdict`) — null → no attribution, never a placeholder. */
  modelMeta: (v: V) => { model: string; routeReason?: string; isLocal?: boolean } | null
  timeoutMs?: number
}

/**
 * Generate ONE adaptive question through the governed engine. Returns the
 * sanitized question + real attribution, or `null` on ANY failure — timeout,
 * engine error, offline/stub sentinel, or an unusable reply — so the caller
 * falls back to the next unused scripted question (marked) and the interview
 * never blocks.
 *
 * Sensitivity floor unchanged: the answers ride the prompt through the same
 * governed pipeline as every run, so the gateway's force-local floor
 * (`providers.sensitive` + the built-in list) routes a generation that
 * mentions sensitive words to the LOCAL model — nothing rerouted client-side.
 */
export async function generateAdaptiveQuestion<V extends AdaptiveRunVerdict>(
  vault: string,
  providers: EngineProviders,
  ctx: AdaptiveAnswers,
  deps: AdaptiveQuestionDeps<V>,
): Promise<GeneratedQuestion | null> {
  const prompt = buildAdaptiveQuestionPrompt(ctx)
  // Same race idiom as the research brief: the loser is discarded, a late
  // resolution has no continuation and can never surface a stale question.
  const verdict = await Promise.race([
    deps.runTask(prompt, vault, providers, '', undefined, undefined, ADAPTIVE_TOKEN_BUDGET),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), deps.timeoutMs ?? ADAPTIVE_TIMEOUT_MS),
    ),
  ])
  if (!verdict || !deps.isRealCompletion(verdict.response)) return null
  const q = sanitizeGeneratedQuestion(verdict.response)
  if (!q) return null
  const meta = deps.modelMeta(verdict)
  return { q, model: meta?.model ?? '', isLocal: meta?.isLocal === true }
}
