// SC Prism — project run state machine (pure logic, no I/O).
//
// A Project's run is a serial walk through `plan` (one natural-language step
// per array entry): run the step through the REAL engine, and on a failing
// verdict retry with feedback ("refine") up to `maxRefines` times before
// parking to ask the human for one extra attempt. Everything here is a pure
// function of plain data so the whole state machine is unit-testable without
// touching React, the store, or the native bridge — the driver (AppStore.tsx)
// is the only thing that calls the engine and dispatches side effects.

import { guardAnswerText } from './answerText'
import type { Verdict } from '../engine/types'
import type { Project } from './projects'

/** Default cap on refine attempts per step before parking to ask the human. */
export const DEFAULT_MAX_REFINES = 2

// The next thing the driver should do, decided from the outcome of whatever
// was just attempted (a plain step or a refine pass) for the CURRENT step.
export type RunAction =
  | { kind: 'step'; index: number; refine: false }
  | { kind: 'refine'; pass: number }
  | { kind: 'ask-extra-refine' }
  | { kind: 'finish'; status: 'done' | 'attention' }

/**
 * Decide what the driver does next, given the outcome of the most recent
 * attempt at `stepIndex`.
 *
 * - Passed → advance to the next step, or finish 'done' if that was the last
 *   one. `refinePass` doesn't matter on a pass — a step that needed refining
 *   still just moves on once it verifies.
 * - Failed, refines remaining (`refinePass < maxRefines`) → try again with
 *   `refine pass: refinePass + 1`.
 * - Failed, refines exhausted (`refinePass === maxRefines`) → the human
 *   decides: `extraRefineGranted` is `null` while unasked (→ ask), `true`
 *   grants exactly one more refine pass (`maxRefines + 1`), `false` ends the
 *   run right there ('attention').
 * - Failed again after that one extra pass (`refinePass > maxRefines`) →
 *   'attention' outright — the human already spent their one grant, so the
 *   driver never asks a second time for the same step.
 */
export function nextRunAction(
  p: {
    plan: string[]
    stepIndex: number
    refinePass: number
    lastPassed: boolean
    extraRefineGranted: boolean | null
  },
  maxRefines: number = DEFAULT_MAX_REFINES,
): RunAction {
  if (p.lastPassed) {
    const next = p.stepIndex + 1
    if (next >= p.plan.length) return { kind: 'finish', status: 'done' }
    return { kind: 'step', index: next, refine: false }
  }
  if (p.refinePass < maxRefines) {
    return { kind: 'refine', pass: p.refinePass + 1 }
  }
  if (p.refinePass === maxRefines) {
    if (p.extraRefineGranted === true) return { kind: 'refine', pass: p.refinePass + 1 }
    if (p.extraRefineGranted === false) return { kind: 'finish', status: 'attention' }
    return { kind: 'ask-extra-refine' }
  }
  // refinePass > maxRefines: the one extra refine already ran and failed too.
  return { kind: 'finish', status: 'attention' }
}

/** The natural-language intent sent to the engine for a fresh attempt at `plan[index]`. */
export function stepIntent(goal: string, plan: string[], index: number): string {
  return `Project goal: ${goal}\nStep ${index + 1} of ${plan.length}: ${plan[index]}`
}

/** The natural-language intent sent to the engine for a refine retry, carrying forward why the last attempt failed. */
export function refineIntent(goal: string, feedback: string, pass: number): string {
  return (
    `Project goal: ${goal}\n` +
    `Refine attempt ${pass}: the previous attempt did not pass verification. ` +
    `Fix this and complete the step:\n${feedback}`
  )
}

// Offline-stub / sim / rejection sentinels — mirrors AppStore's
// isRealCompletion, kept private/local here so this module stays a leaf (no
// import from the store, which itself will import this module — a cycle
// otherwise). '[rejected:' is the gateway saying the provider refused OUR
// request: an honest diagnostic naming the cause, never file-writable content.
function isRealText(text: string | undefined): text is string {
  return (
    !!text &&
    !text.startsWith('[offline:') &&
    !text.startsWith('[stub:') &&
    !text.startsWith('[rejected:')
  )
}

/** Cap on how much of the raw tier1 log text is quoted back to the model. */
const MAX_LOG_CHARS = 2000

/**
 * The feedback text to hand back to the model on a refine pass, extracted
 * from a FAILED verdict. Tier 1 is deterministic and free — when it failed
 * that is the most actionable signal (no point quoting prose about a check
 * the run never reached). The REAL command output (`tier1.log`) is what the
 * model actually needs to fix the failure — prefer it (truncated so one huge
 * log can't blow the next prompt's budget) over the synthesized "N/M failed"
 * summary; the synthesized line is a fallback when the engine sent no log
 * text (native verdicts always do; older/sim verdicts may not). Otherwise
 * fall back to the real completion text (a Tier 2 / judge rejection, or a
 * blocked write) so the model sees exactly what it said; a verdict with none
 * of the above gets an honest generic message.
 */
export function verdictFeedback(verdict: Verdict): string {
  if (!verdict.tier1.pass) {
    const log = verdict.tier1.log?.trim()
    if (log) {
      return log.length > MAX_LOG_CHARS ? log.slice(0, MAX_LOG_CHARS) : log
    }
    return `Tier-1 checks failed (${verdict.tier1.tests}). Fix the failing checks and try again.`
  }
  // PROJECT ANSWER: this text is shown to the user in the run stage AND fed
  // back to the model as refine feedback. An unexecuted ```tool_call request
  // is neither an answer nor useful feedback — strip it and say so.
  if (isRealText(verdict.response)) return guardAnswerText(verdict.response)
  return 'The previous attempt did not pass verification.'
}

/**
 * The lastNote text for a step, given the base note (the real completion
 * text, or the plan step label as a fallback) and a passing verdict's
 * `project.overwrote` list (existing-mode only — which written paths already
 * existed before this step). Appends a " · changed N existing file(s)"
 * suffix only when `overwrote` is a non-empty array; absent/empty leaves the
 * base note untouched (byte-identical to v1 new-mode, where `overwrote` is
 * never present). Pure so it's unit-testable without the store.
 */
export function stepNote(base: string, overwrote?: readonly string[]): string {
  const n = overwrote?.length ?? 0
  if (n === 0) return base
  const plural = n === 1 ? 'file' : 'files'
  return `${base} · changed ${n} existing ${plural}`
}

/**
 * Whether the Projects page's Merge button should render for `p`, and how:
 * - 'running'   — the driver is actively using this project (status
 *                 'running'/'awaiting'); merging mid-run could race the
 *                 driver's own git checkout on the run branch.
 * - 'no-branch' — no `runBranch` to merge (never run in existing mode yet,
 *                 or already merged/finished — the driver clears it after a
 *                 successful merge), OR no `baseBranch` to merge INTO (the
 *                 merge target guard, v2 final review: a sticky runBranch
 *                 from a run killed mid-step-1 — before base_branch was ever
 *                 recorded — must never offer a Merge button with nothing
 *                 honest to pass as `into`).
 * - 'ready'     — idle with a run branch AND a base branch to merge into.
 * Pure so it's unit-testable without the store.
 */
export function mergeReadiness(p: Project): 'ready' | 'no-branch' | 'running' {
  if (p.status === 'running' || p.status === 'awaiting') return 'running'
  if (!p.runBranch || !p.baseBranch) return 'no-branch'
  return 'ready'
}
