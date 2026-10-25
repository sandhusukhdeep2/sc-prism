// SC Prism — pure skill-usage stats aggregator.
//
// Turns the verdict history + skill library into per-skill usage stats: how
// often a skill was actually injected into a run (honest attribution via
// `verdict.native.disclosed`, not just "matched"), its pass rate, whether it
// is underperforming, and its most recent outcomes. Every function here is a
// pure, deterministic projection of its inputs — no store singletons, no
// React, no imports beyond types (mirrors desk.ts's aggregator style). A
// later UI task renders this; the exported surface is load-bearing.
//
// Verdicts are assumed newest-first (the store PREPENDS on every new
// verdict — see desk.ts's `passRate` comment) — `lastUsedAt`/`recent` lean on
// that order and never sort.

import type { Verdict } from '../engine/types'
import type { StoredSkill } from './skills'
import { isAttention, tally, type VerdictOutcome } from './verdictOutcome'

/** One run that used a skill — the trimmed-down shape the UI lists. */
export interface SkillRunOutcome {
  taskId: string
  task: string
  passed: boolean
  // The engine's three-valued outcome, carried verbatim so a renderer can tell
  // "the reviewer dissented" apart from "the checks failed". Undefined when the
  // verdict predates the field — unknown, never guessed.
  outcome?: VerdictOutcome
  at: string
}

/**
 * Per-skill usage stats, keyed by skill id in `skillStats`'s returned map.
 *
 * THE COUNTING RULE (verdictOutcome.ts :: OutcomeTally): an ATTENTION run — the
 * deterministic checks ran over real written files and PASSED, and only the LLM
 * reviewer dissented — is NOT a pass, and is NOT counted as a failure either.
 * It leaves the pass-rate denominator and is reported on its own as
 * `attention`. Every label built from these numbers names its denominator, so
 * `passRate` can never be read as "of all uses".
 */
export interface SkillStat {
  uses: number // every run that disclosed this skill
  passes: number // uses the engine recorded as passed
  attention: number // uses the engine recorded as attention (held out of the rate)
  decided: number // uses - attention — the pass-rate denominator
  passRate: number // passes / decided; 0 when decided === 0
  lastUsedAt: string // '' when never used
  // decided >= 3 && passRate < 0.5. Gated on DECIDED, not uses: a skill whose
  // runs all produced working, test-passing code and merely failed to satisfy
  // the reviewer must not be dragged to the AI-improve gate as if it were
  // failing — and it must not reach the gate on a denominator of 0 either.
  underperforming: boolean
  recent: SkillRunOutcome[] // newest-first, max 3
}

const UNDERPERFORMING_MIN_USES = 3
const UNDERPERFORMING_MAX_PASS_RATE = 0.5
const RECENT_MAX = 3

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * A verdict "uses" a skill when its native `disclosed` list (the skills the
 * engine actually injected, not merely matched) contains the skill name —
 * case-insensitive, trimmed. Sim verdicts have no `native` and never count.
 */
function usesSkill(verdict: Verdict, skillName: string): boolean {
  const disclosed = verdict.native?.disclosed
  if (!disclosed) return false
  const target = normalize(skillName)
  return disclosed.some((name) => normalize(name) === target)
}

function toOutcome(verdict: Verdict): SkillRunOutcome {
  return {
    taskId: verdict.taskId,
    task: verdict.task,
    passed: verdict.passed,
    ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
    at: verdict.at ?? '',
  }
}

// NOTE (2026-08-09 honesty pass): `allVerdicts` — the session + loop-run merge —
// is deleted with the loop simulator it existed for. `state.verdicts` (the
// session log, newest-first) is now the only real verdict stream a page can
// project over, so the pages pass it straight in.

/**
 * Per-skill usage stats over the verdict history. Every skill in `skills`
 * gets an entry (even at 0 uses) so the caller never has to special-case a
 * missing key.
 */
export function skillStats(
  verdicts: readonly Verdict[],
  skills: readonly Pick<StoredSkill, 'id' | 'name'>[],
): Map<string, SkillStat> {
  const result = new Map<string, SkillStat>()

  for (const skill of skills) {
    const used: Verdict[] = []
    let lastUsedAt = ''
    let sawFirstUse = false
    const recent: SkillRunOutcome[] = []

    // Newest-first input, no sorting: the first match encountered is the
    // most recent use.
    for (const verdict of verdicts) {
      if (!usesSkill(verdict, skill.name)) continue
      used.push(verdict)
      if (!sawFirstUse) {
        lastUsedAt = verdict.at ?? ''
        sawFirstUse = true
      }
      if (recent.length < RECENT_MAX) recent.push(toOutcome(verdict))
    }

    // ONE counting rule for the whole app (verdictOutcome.ts :: tally):
    // attention leaves the denominator and is reported on its own.
    const t = tally(used)
    result.set(skill.id, {
      uses: t.runs,
      passes: t.passes,
      attention: t.attention,
      decided: t.decided,
      passRate: t.passRate,
      lastUsedAt,
      underperforming:
        t.decided >= UNDERPERFORMING_MIN_USES && t.passRate < UNDERPERFORMING_MAX_PASS_RATE,
      recent,
    })
  }

  return result
}

/**
 * The FAILING runs (only) that used the given skill, newest-first, capped at
 * `max`. These are quoted to the model in the AI-improve prompt as this skill's
 * failures, so the word has to mean it: an ATTENTION run is excluded. Its
 * deterministic checks ran over real files and passed — handing it to an
 * "improve this skill, here is what went wrong" prompt would ask the model to
 * fix work that demonstrably works, on the say-so of the reviewer the engine
 * itself flags as the dissenting party.
 */
export function recentFailures(
  verdicts: readonly Verdict[],
  skillName: string,
  max = RECENT_MAX,
): SkillRunOutcome[] {
  const out: SkillRunOutcome[] = []
  for (const verdict of verdicts) {
    if (verdict.passed || isAttention(verdict)) continue
    if (!usesSkill(verdict, skillName)) continue
    out.push(toOutcome(verdict))
    if (out.length >= max) break
  }
  return out
}
