import { Link } from 'react-router-dom'
import type { Tier1Result, Verdict as EngineVerdict } from '../engine/types'
import { contradictionLine, verdictTone, type VerdictOutcome, type VerdictTone } from '../lib/verdictOutcome'
import './VerdictCard.css'

/**
 * The card's Tier-1 line, honest in all three states.
 *
 * A SKIPPED gate ran nothing — no verify command, or no project directory to
 * run one against (chat, a manager report, a heartbeat wake). It must not
 * render as "✓ tests skipped ✓ lint ✓ build": that paints a pass over checks
 * that never executed, which is exactly the laundering the honesty rules ban.
 * The engine's own reason is shown instead, leading sentence first.
 *
 * `passed` is "did TIER 1 pass" — callers hand it the overall verdict pass,
 * which matches for every state except ATTENTION, where Tier-1 genuinely ran
 * and passed and only the reviewer dissented (see `toVerdictView`).
 *
 * Shared by Workspace and Projects so the two cards cannot drift.
 */
export function tier1Line(t1: Tier1Result, passed: boolean): string {
  if (t1.skipped) {
    const why = (t1.skipReason ?? '').split('.')[0].trim() || 'skipped — nothing to verify on this run'
    return `${why} · deterministic · 0 tokens`
  }
  return passed
    ? `✓ tests ${t1.tests} ${t1.lint ? '✓' : '✕'} lint ${t1.build ? '✓' : '✕'} build · deterministic · 0 tokens`
    : `✕ tests ${t1.tests} · short-circuited · deterministic · 0 tokens`
}

// The Verdict — the product's signature artifact. Tier-1 is the muted "free" tier;
// Tier-2 carries the accent. A failed Tier-1 short-circuits before Tier-2 (not shown here).
export type Verdict = {
  task: string
  route: string
  routeVia?: string
  model: string
  tier1: string
  tier2: string
  hooks: string
  cost: string
  writeback: string
  passed?: boolean
  // The engine's three-valued outcome + its own sentence explaining it.
  // Undefined on sim runs and on verdicts predating the field — the card then
  // renders exactly as it always did (see `Badge`).
  outcome?: VerdictOutcome
  outcomeReason?: string
  // Judge claims the deterministic layer disproved. Non-empty = the reviewer
  // got a fact wrong; the card says so out loud.
  contradiction?: string
  // Which attempt at ONE logical step this run was ("attempt 2 · refined from
  // the failure of attempt 1"). Undefined when the run was never tracked as part
  // of a refine loop — which is NOT "attempt 1" and is rendered as nothing.
  attempt?: string
  to?: string
}

/**
 * The attempt line, or undefined when there is no recorded attempt history.
 *
 * A refine loop's whole claim is that the second attempt is better than the
 * first. That claim is unreadable if every attempt renders identically, so the
 * number goes on the card itself. Only a REAL recorded number prints: an
 * untracked run says nothing rather than calling itself attempt 1.
 */
export function attemptLine(v: EngineVerdict): string | undefined {
  const a = v.attempt
  if (!a || !(a.number > 0)) return undefined
  if (a.number === 1) return 'attempt 1 · first try'
  return a.isRefine
    ? `attempt ${a.number} · refined after the previous attempt failed verification`
    : `attempt ${a.number}`
}

/**
 * The engine Verdict → the card's flat view model. ONE implementation, imported
 * by both the Workspace thread and the Projects run list (it used to be
 * copy-pasted into each, which is how a surface drifts into lying).
 */
export function toVerdictView(v: EngineVerdict): Verdict {
  const tone = verdictTone(v)
  const attention = tone === 'attention'
  // ATTENTION means Tier-1 genuinely ran and PASSED. Feeding `v.passed`
  // (false, because the reviewer denies the pass) would print
  // "✕ tests … · short-circuited" over a gate that ran green.
  const tier1 = tier1Line(v.tier1, v.passed || attention)
  const tier2 = v.passed
    ? `✓ eval ${v.tier2.evalScore.toFixed(2)} · ${v.tier2.trajectory} · ${v.tier2.judge}`
    : attention
      ? // Tier 2 DID run here and dissented — saying "skipped (Tier 1 failed)"
        // would be false twice over.
        `✕ eval ${v.tier2.evalScore.toFixed(2)} · the reviewer dissented · ${v.tier2.judge}`
      : '— skipped (Tier 1 failed)'
  const contradiction = contradictionLine(v)
  const attempt = attemptLine(v)
  return {
    task: v.task,
    route: v.route.routeLabel,
    routeVia: v.route.via,
    model: v.modelRoute,
    tier1,
    tier2,
    hooks: `${v.hooks.passed ? '✓' : '✕'} · ${v.hooks.blocked} blocked`,
    cost: `$${v.cost.toFixed(3)} · ${(v.durationMs / 1000).toFixed(1)}s`,
    writeback: v.writeback.committed
      ? `✓ validated · ${v.writeback.path}`
      : `blocked · ${v.writeback.path}`,
    passed: v.passed,
    ...(v.outcome ? { outcome: v.outcome } : {}),
    ...(v.outcomeReason ? { outcomeReason: v.outcomeReason } : {}),
    ...(contradiction ? { contradiction } : {}),
    ...(attempt ? { attempt } : {}),
    to: '/verdict',
  }
}

/**
 * The head badge, four-valued.
 *
 *   passed          → the gold "✓ PASSED" pill, unchanged.
 *   replied         → a QUIET neutral "REPLIED" pill. A chat turn the judge
 *                     cleared: not the gold pass (it verified no work), and
 *                     nothing like a warning (nothing is wrong) — just the
 *                     record saying a conversation happened.
 *   attention       → an AMBER "⚠ NEEDS A LOOK" pill. Visually nowhere near the
 *                     gold pass, and visually nowhere near a bare failure.
 *   failed / unknown→ no pill, exactly as every non-pass has always rendered.
 *
 * The last line is deliberate. A verdict written before `outcome` existed says
 * only "did not pass"; drawing it a "✕ FAILED" pill would assert a
 * classification the engine never made. Recorded 'failed' is drawn the same way
 * because that IS the rendering it already had — this change adds a state, it
 * does not restyle the old ones.
 */
function Badge({ tone }: { tone: VerdictTone }) {
  if (tone === 'passed') return <span className="verdict__badge">✓ PASSED</span>
  if (tone === 'replied') return <span className="verdict__badge verdict__badge--replied">REPLIED</span>
  if (tone === 'attention') return <span className="verdict__badge verdict__badge--attention">⚠ NEEDS A LOOK</span>
  return null
}

export default function VerdictCard({ v }: { v: Verdict }) {
  const Row = ({ label, children, muted, accent }: {
    label: string; children: React.ReactNode; muted?: boolean; accent?: boolean
  }) => (
    <div className={'verdict__row' + (muted ? ' is-muted' : '')}>
      <span className="verdict__label mono">{label}</span>
      <span className={'verdict__val mono' + (accent ? ' is-accent' : '')}>{children}</span>
    </div>
  )

  // `passed !== false` was the old test for the gold pill; `verdictTone` keeps
  // that behaviour for a view with no `passed` at all (the static demo cards).
  const tone = verdictTone({ passed: v.passed !== false, outcome: v.outcome })

  return (
    <Link to={v.to ?? '/verdict'} className="verdict">
      <div className="verdict__head">
        <span className="verdict__kicker">Verdict</span>
        <span className="verdict__task">{v.task}</span>
        <span className="verdict__spacer" />
        <Badge tone={tone} />
      </div>
      <div className="verdict__body">
        <Row label="Route">{v.route} {v.routeVia && <span className="verdict__dim">{v.routeVia}</span>}</Row>
        <Row label="Model">{v.model}</Row>
        <Row label="Tier 1" muted>{v.tier1}</Row>
        <Row label="Tier 2" accent>{v.tier2}</Row>
        <Row label="Hooks">{v.hooks}</Row>
        <Row label="Cost">{v.cost} <span className="verdict__ok">{v.writeback}</span></Row>
        {/* Attempt N of one logical step. Rendered only when the engine
            recorded a number — an untracked run is not "attempt 1". */}
        {v.attempt && <Row label="Attempt" muted>{v.attempt}</Row>}
        {/* The engine's own sentence for WHY this outcome. Rendered only when
            it wrote one — never composed here out of the other fields. */}
        {v.outcomeReason && (
          <div className={'verdict__why' + (tone === 'attention' ? ' is-attention' : '')}>
            {v.outcomeReason}
          </div>
        )}
        {/* The engine telling you its own reviewer was demonstrably wrong. It
            records these and never edits the judge's marks, so this line is the
            only way a user ever finds out. */}
        {v.contradiction && (
          <div className="verdict__contradiction">⚠ judge contradiction — {v.contradiction}</div>
        )}
      </div>
    </Link>
  )
}
