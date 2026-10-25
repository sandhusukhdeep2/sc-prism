import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import './VerdictDetail.css'
import { useApp } from '../store/AppStore'
import type { Verdict } from '../engine/types'
import { contradictionLine, verdictTone } from '../lib/verdictOutcome'
import { attemptLine } from '../components/VerdictCard'
import DelegationTrail from '../components/DelegationTrail'
import { spansForTask } from '../lib/delegation'
import { isNative, readSpansTail, resolveVaultDir, type EngineSpan } from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import PageHead from '../components/PageHead'

// Full detail for a task, bound to REAL verdicts in the store. A selector
// lists recent runs; every field shown comes from the verdict itself — native
// runs surface the true hook decisions, cache stats and span trace, and sim
// runs are labeled as sim. Empty until a task has run.

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function fmtCost(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`
}

export default function VerdictDetail() {
  const { state } = useApp()
  const { settings } = useSettings()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const verdicts = state.verdicts
  const verdict = verdicts.find((v) => v.taskId === selectedId) ?? verdicts[0] ?? null

  // The span tail, so THIS verdict's delegated steps can be shown afterwards.
  // Attribution is by the run span's own `task_id` + parentage (spansForTask) —
  // never by recency, which would pin the newest run's steps on an old verdict.
  // A run whose trace has aged out of the tail simply shows nothing.
  const [spans, setSpans] = useState<EngineSpan[]>([])
  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    void (async () => {
      try {
        const vault = await resolveVaultDir(settings.vaultPath)
        const tail = await readSpansTail(vault, 400)
        if (!cancelled) setSpans(tail)
      } catch {
        // unreadable tail — show no trail rather than a guessed one
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settings.vaultPath])

  if (!verdict) {
    return (
      <div className="vd">
        <header className="vd__header">
          <div>
            <Link to="/" className="vd__back">← Workspace</Link>
            <div className="vd__title">No verdict yet</div>
          </div>
        </header>
        <div className="vd__empty">
          <div className="vd__emptytitle">Nothing verified yet</div>
          <p className="vd__emptybody">
            Verdicts appear here once a task has been routed and verified.{' '}
            <Link to="/" className="vd__emptylink">Run a task in the Workspace ›</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="vd">
      {/* recent runs selector */}
      {verdicts.length > 1 && (
        <div className="vd__picker mono">
          {verdicts.slice(0, 8).map((v) => {
            // Three-valued: an ATTENTION run gets its own amber ⚠ chip so the
            // picker can't file "checks passed, reviewer dissented" under the
            // same ✕ as a run whose tests actually failed.
            const tone = verdictTone(v)
            return (
              <button
                key={v.taskId}
                type="button"
                className={
                  'vd__pick' +
                  (v.taskId === verdict.taskId ? ' vd__pick--on' : '') +
                  (tone === 'attention' ? ' vd__pick--attention' : tone === 'passed' ? '' : ' vd__pick--fail')
                }
                onClick={() => setSelectedId(v.taskId)}
              >
                {tone === 'passed' ? '✓' : tone === 'attention' ? '⚠' : '✕'} #{v.taskId}
              </button>
            )
          })}
        </div>
      )}
      <VerdictBody v={verdict} spans={spans} />
    </div>
  )
}

function VerdictBody({ v, spans }: { v: Verdict; spans: readonly EngineSpan[] }) {
  const tokens = v.tokensIn + v.tokensOut
  const blocked = v.native?.blocks ?? v.hooks.blocked
  const durationS = (v.durationMs / 1000).toFixed(1)
  const metrics = v.tier2.metrics
  const breaches = v.tier2.breaches ?? []
  const isNativeRun = !!v.native
  const decisions = v.native?.hookDecisions ?? []
  // The engine's three-valued outcome. 'unknown-nonpass' (a verdict written
  // before the field existed) renders EXACTLY as it did before — a non-pass and
  // nothing more; nothing here back-fills a classification the engine never made.
  const tone = verdictTone(v)
  const attention = tone === 'attention'
  const contradiction = contradictionLine(v)

  return (
    <>
      {/* page header */}
      {/* The verdict badge and the provenance note are ACTIONS-BAR items, not
          parts of the title — they were three spans at three sizes wedged into
          one header row, which is why this page kept its own header rules while
          every other page shares one. The back link stays above the title,
          where a detail page's way out belongs. */}
      <Link to="/" className="vd__back">← Workspace</Link>
      <PageHead
        title="Task"
        em={`#${v.taskId}`}
        hint={isNativeRun ? 'fully reconstructable from spans' : 'simulated run (browser demo)'}
        actions={
          <span
            className={
              'vd__badge' +
              (attention ? ' vd__badge--attention' : v.passed ? '' : ' vd__badge--fail')
            }
          >
            {attention ? '⚠ NEEDS A LOOK' : v.passed ? '✓ VERIFIED' : '⚠ REVIEW'}
          </span>
        }
      />

      <div className="vd__panels">
        {/* LEFT: execution detail */}
        <div className="vd__agent">
          <div className="vd__agenthead">
            <span className="vd__orb vd__orb--lg" />
            <div>
              <div className="vd__role">{v.task}</div>
              <div className="vd__sub">
                answered by <span className="mono">{v.route.model}</span>
              </div>
            </div>
            <span className="vd__spacer" />
            <div className="vd__metric">
              <div className="mono vd__metricval is-eval">{v.tier2.evalScore.toFixed(2)}</div>
              <div className="vd__metriclabel is-eval">eval</div>
            </div>
            <div className="vd__metric vd__metric--gap">
              <div className="mono vd__metricval">{fmtTokens(tokens)}</div>
              <div className="vd__metriclabel">tokens</div>
            </div>
          </div>

          {/* WHO DID WHAT (2026-08-15) — the delegated steps of THIS run, from
              its own spans. Renders nothing when nothing was delegated, or when
              this run's trace has aged out of the tail. */}
          <DelegationTrail spans={spansForTask(spans, v.taskId)} />

          {/* real execution facts */}
          <div className="vd__timeline">
            <div className="vd__kicker">Execution</div>
            <div className="vd__facts mono">
              <div className="vd__factrow">
                <span className="vd__factk">route</span>
                <span>{v.route.routeLabel} — {v.route.reason}</span>
              </div>
              <div className="vd__factrow">
                <span className="vd__factk">time</span>
                <span>{durationS}s wall · {fmtTokens(v.tokensIn)} in / {fmtTokens(v.tokensOut)} out</span>
              </div>
              {isNativeRun && (
                <div className="vd__factrow">
                  <span className="vd__factk">cache</span>
                  <span>
                    {v.native!.cacheHits} hit{v.native!.cacheHits === 1 ? '' : 's'} ·{' '}
                    {v.native!.cacheMisses} miss{v.native!.cacheMisses === 1 ? '' : 'es'}
                  </span>
                </div>
              )}
              {isNativeRun && v.native!.memoryInjected > 0 && (
                <div className="vd__factrow">
                  <span className="vd__factk">memory</span>
                  <span>{v.native!.memoryInjected} item{v.native!.memoryInjected === 1 ? '' : 's'} injected</span>
                </div>
              )}
              {isNativeRun && v.native!.disclosed.length > 0 && (
                <div className="vd__factrow">
                  <span className="vd__factk">read</span>
                  <span>{v.native!.disclosed.join(' · ')}</span>
                </div>
              )}
            </div>
            <Link to="/console" className="vd__link">view trace ›</Link>
          </div>

          {/* governance decisions — REAL hook trail on native runs */}
          <div>
            <div className="vd__kicker vd__kicker--mb">
              Governance {isNativeRun ? `· ${v.native!.hooksFired.length} hooks fired` : ''}
            </div>
            <div className="vd__hooks mono">
              {!isNativeRun && (
                <div className="vd__hook">
                  <span className="vd__hookname vd__dim">(sim run — no hook trace)</span>
                </div>
              )}
              {isNativeRun && decisions.length === 0 &&
                v.native!.hooksFired.map((h) => (
                  <div key={h} className="vd__hook is-ok">
                    <span className="vd__hookmark">✓</span>
                    <span className="vd__hookname">{h}</span>
                  </div>
                ))}
              {decisions.map((d, i) => (
                <div key={i} className={'vd__hook ' + (d.action === 'block' ? 'is-block' : 'is-ok')}>
                  <span className={'vd__hookmark' + (d.action === 'block' ? ' is-block' : '')}>
                    {d.action === 'block' ? '■' : '✓'}
                  </span>
                  <span className="vd__hookname">{d.hook}</span>
                  <span className="vd__spacer" />
                  <span className={'vd__hookmeta' + (d.action === 'block' ? ' is-block' : '')}>
                    {d.action}{d.reason ? ` — ${d.reason}` : ''}
                  </span>
                </div>
              ))}
              {blocked > 0 && decisions.length === 0 && (
                <div className="vd__hook is-block">
                  <span className="vd__hookmark is-block">■</span>
                  <span className="vd__hookname">{blocked} blocked</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: full verdict trail */}
        <div className="vd__trail">
          <div className="vd__trailhead">
            <span className="vd__kicker vd__kicker--dark">Full verdict trail</span>
            <span className="vd__spacer" />
            <span
              className={
                'vd__trailbadge' +
                (attention ? ' vd__trailbadge--attention' : v.passed ? '' : ' vd__trailbadge--fail')
              }
            >
              {attention ? '⚠ CHECKS PASSED · REVIEWER DISSENTED' : v.passed ? '✓ PASSED' : '✕ NOT PASSED'}
            </span>
          </div>
          <div className="vd__trailbody mono">
            {/* The engine's OWN sentence for why this outcome — e.g. "tier-1 ran
                `npm test` and passed; the tier-2 reviewer dissented at 0.5
                (threshold 0.7)". Shown verbatim, directly under the badge it
                explains, and only when the engine wrote one. */}
            {v.outcomeReason && (
              <TrailRow label="Outcome">
                <span className={attention ? 'vd__attention' : undefined}>{v.outcomeReason}</span>
              </TrailRow>
            )}
            {/* The engine catching its own reviewer in a factual error. It never
                edits the judge's marks, so if this isn't shown here the user
                never finds out at all. */}
            {contradiction && (
              <TrailRow label="Judge contradiction">
                <span className="vd__attention">⚠ {contradiction}</span>
              </TrailRow>
            )}
            <TrailRow label="Task">
              <span className="vd__strong">{v.task}</span>
            </TrailRow>
            {/* Which attempt at ONE logical step this was. A verified refine
                loop's entire claim is that attempt N+1 beats attempt N — so the
                number belongs on the record, next to the outcome it produced.
                Every attempt keeps its own verdict; this row is what tells you
                which one you are reading. Absent when the run was never tracked
                as part of a refine loop, which is NOT "attempt 1". */}
            {attemptLine(v) && (
              <TrailRow label="Attempt">
                {attemptLine(v)}
                {v.attempt?.previousTaskId && (
                  <span className="vd__dim"> · after {v.attempt.previousTaskId}</span>
                )}
              </TrailRow>
            )}
            <TrailRow label="Route">
              {v.route.routeLabel} <span className="vd__tag">{v.route.reason}</span>{' '}
              <span className="vd__dim">{v.route.via}</span>
            </TrailRow>
            <TrailRow label="Model">
              {v.route.model} · {v.modelRoute} · {durationS}s wall
            </TrailRow>
            <TrailRow label="Tier 1 · deterministic · 0 tokens" dim>
              {/* A skipped gate ran NOTHING. Ticks here would claim tests, lint
                  and build all passed on a run that never executed one — the
                  silent pass the honesty rules forbid. Say what happened. */}
              {v.tier1.skipped ? (
                <span className="vd__dim">
                  — skipped · {v.tier1.skipReason ?? 'nothing to verify on this run'}
                </span>
              ) : (
                <>
                  {v.tier1.pass ? '✓' : '✕'} tests {v.tier1.tests} &nbsp;
                  {v.tier1.lint ? '✓' : '✕'} lint &nbsp;
                  {v.tier1.build ? '✓' : '✕'} build
                </>
              )}
            </TrailRow>
            <TrailRow label={`Tier 2 · ${v.tier2.judge}`} accent>
              {v.tier2.passed ? '✓' : '✕'} eval {v.tier2.evalScore.toFixed(2)} · {v.tier2.trajectory}
              {v.tier2.envelopeOk !== undefined && (
                <> · envelope {v.tier2.envelopeOk ? 'ok' : 'BREACHED'}</>
              )}
              {metrics && (
                <span className="vd__metricsline">
                  {' '}·{' '}
                  {Object.entries(metrics)
                    .map(([k, val]) => `${k} ${val.toFixed(2)}`)
                    .join(' · ')}
                </span>
              )}
            </TrailRow>
            {v.tier2.judgeNotes && (
              <TrailRow label="Judge notes" dim>
                {v.tier2.judgeNotes}
              </TrailRow>
            )}
            <TrailRow label="Hooks">
              {v.hooks.passed ? '✓ passed' : '✕ failed'}
              {blocked > 0 ? ` · ${blocked} blocked` : ' · none blocked'}
              {breaches.length > 0 && ` · breaches: ${breaches.join(', ')}`}
            </TrailRow>
            <TrailRow label="Cost">
              {fmtCost(v.cost)} · {fmtTokens(tokens)} tokens
              {v.route.target === 'local' && <span className="vd__saved"> · ran locally — zero cloud spend</span>}
            </TrailRow>
            <TrailRow label="Write-back" last>
              {v.writeback.committed ? '✓' : '·'} vault: {v.writeback.path}{' '}
              {v.writeback.validated ? (
                <span className="vd__saved">(validated)</span>
              ) : (
                <span className="vd__dim">(not written)</span>
              )}
            </TrailRow>
            <div className="vd__span">
              {v.native?.spansPath ? (
                <>
                  span trace: <span className="vd__dim">{v.native.spansPath}</span> ·{' '}
                </>
              ) : null}
              <Link to="/vault" className="vd__spanlink">open the vault ›</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function TrailRow({ label, children, dim, accent, last }: {
  label: string; children: React.ReactNode; dim?: boolean; accent?: boolean; last?: boolean
}) {
  return (
    <div className={'vd__trow' + (dim ? ' is-dim' : '') + (last ? ' is-last' : '')}>
      <div className={'vd__tlabel' + (accent ? ' is-accent' : '')}>{label}</div>
      <div className={'vd__tval' + (accent ? ' is-accent' : '')}>{children}</div>
    </div>
  )
}
