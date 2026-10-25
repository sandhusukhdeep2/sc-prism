import { useMemo, useState } from 'react'
import { useApp } from '../store/AppStore'
import type { DashHook, Verdict } from '../engine/types'
import { isNative, resolveVaultDir, runNativeExport } from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import { fmtMoney } from '../lib/money'
import { bucketProviders, localShare, type ProviderBurn } from '../lib/engineStats'
import { staleNote, useLiveDashboard } from '../lib/liveDashboard'
import { activeRuns } from '../lib/liveRuns'
import './Console.css'
import PageHead from '../components/PageHead'

// Finding 3a's provider bucketing now lives in lib/engineStats (Memory needs
// the same measurement); re-exported here because this page's honesty test and
// the rest of the app import it from the Console.
export { bucketProviders }
export type { ProviderBurn }

// Governance Console. On native (Tauri) the burn, hook fire-rate, eval trend, and
// drift are the REAL engine observability dashboard; in the browser they fall back
// to the live store (verdicts + stats). The old hardcoded "agent execution graph"
// SVG was deleted in the 2026-08-09 honesty pass: fixed coordinates and a fixed
// topology are a picture, not a measurement (ADR-007's ◆-hub rule constrained how
// that graph must LOOK; it never required us to draw one we had not measured).

function pctHeight(val: number, max: number): string {
  if (max <= 0) return '6%'
  return `${Math.max(6, Math.round((val / max) * 100))}%`
}

const BAR_CLASSES = [
  'console__bar--dark',
  'console__bar--gold',
  'console__bar--tan',
  'console__bar--blue',
  'console__bar--purple',
]

// --- Finding 3b/3c: hook health that cannot hide errors or average in dispatch ---
// `dispatch` wraps the WHOLE model call (687s on the user's install), so folding
// it into one average produced "170039.5ms avg latency" for the enforcement layer.
// It is reported on its own line instead, and `errors` is surfaced so the badge
// can never read "healthy" over a hook that genuinely broke.
//
// What "error" means was itself wrong, though: the badge read a red "53 errors"
// over an enforcement layer that was working perfectly. A `stop` span's
// `status: "error"` records "compliance ratchet: FAIL — task not done" — the
// hook ran, judged correctly, and reported a failing run. The engine now splits
// the two (`errors` vs `failed_outcomes`) and ONLY a hook that could not do its
// job is badged.

export const LATENCY_EXCLUDED = ['dispatch']

export interface HookHealth {
  fires: number
  blocks: number
  /** hooks that could not do their job — the only thing badgeable as broken. */
  errors: number
  /** hooks that ran and recorded a FAILING run: the ratchet working, not breaking. */
  failedOutcomes: number
  /** avg ms over the gate hooks only (dispatch excluded); null when none ran. */
  avgMs: number | null
  /** the dispatch hook's own avg ms — a model-call duration, not a gate cost. */
  dispatchAvgMs: number | null
  /** per-hook averages for the sparkline, dispatch excluded. */
  latencies: number[]
}

export function hookHealth(hooks: Record<string, DashHook>): HookHealth {
  let fires = 0
  let blocks = 0
  let errors = 0
  let failedOutcomes = 0
  let gateMs = 0
  let gateFires = 0
  let dispatchAvgMs: number | null = null
  const latencies: number[] = []
  for (const [name, h] of Object.entries(hooks ?? {})) {
    fires += h.fires || 0
    blocks += h.blocks || 0
    errors += h.errors || 0
    failedOutcomes += h.failed_outcomes || 0
    if (LATENCY_EXCLUDED.includes(name)) {
      dispatchAvgMs = h.avg_ms ?? null
      continue
    }
    gateMs += h.total_ms || 0
    gateFires += h.fires || 0
    latencies.push(h.avg_ms || 0)
  }
  return {
    fires,
    blocks,
    errors,
    failedOutcomes,
    avgMs: gateFires ? gateMs / gateFires : null,
    dispatchAvgMs,
    latencies,
  }
}

export function hookBadge(h: HookHealth | null): { label: string; cls: string } {
  if (!h || h.fires === 0) return { label: 'no data yet', cls: 'console__badge--muted' }
  // A BROKEN hook is never "healthy" — it outranks everything below.
  if (h.errors > 0) return { label: `${h.errors} errors`, cls: 'console__badge--warn' }
  // A hook that ran and failed a run is enforcement, not breakage: it is the
  // ratchet refusing to call an unfinished task done.
  if (h.blocks > 0 || h.failedOutcomes > 0)
    return { label: 'enforcing', cls: 'console__badge--warn' }
  return { label: 'healthy', cls: 'console__badge--ok' }
}

// Hook-latency sparkline from the REAL per-hook avg_ms series. Empty series
// (no engine hook data) → a flat NEUTRAL baseline, never a fabricated healthy
// EKG. One point is drawn flat (no spread to plot).
function hookSparkPath(ms: readonly number[]): string {
  const w = 240
  if (ms.length <= 1) return `M0 27 L${w} 27`
  const min = Math.min(...ms)
  const max = Math.max(...ms)
  const span = max - min || 1
  return ms
    .map((v, i) => {
      const x = (w * i) / (ms.length - 1)
      const y = 46 - ((v - min) / span) * 38 // 8..46 inside the 54-high viewBox
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

// Eval sparkline path from a chronological score series (oldest→newest).
function evalSparkPath(scores: number[]): string {
  if (scores.length === 0) return 'M0 32 L240 32'
  const w = 240
  const yFor = (s: number) => 32 - s * 24 // 0 → y32, 1 → y8
  if (scores.length === 1) {
    const y = yFor(scores[0])
    return `M0 ${y.toFixed(1)} L${w} ${y.toFixed(1)}`
  }
  return scores
    .map((s, i) => {
      const x = (w * i) / (scores.length - 1)
      const y = yFor(s)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

export default function Console() {
  const { state } = useApp()
  const { verdicts, stats } = state
  const { settings } = useSettings()
  const vaultPath = settings.vaultPath

  // REAL engine dashboard (native only). Re-fetched whenever a verdict lands
  // AND, via the shared hook (Finding 5), every 2.5s while a run is genuinely
  // live — never when idle. `null` in the browser.
  const live = activeRuns(state.liveRuns).length > 0
  // A failed read keeps the LAST measurement and says so, instead of silently
  // collapsing to the session fallback every 2.5s (Finding 4a).
  const dashRead = useLiveDashboard(vaultPath, live, verdicts.length)
  const dash = dashRead.dash
  const dashNote = staleNote(dashRead)

  // Token burn by model — REAL per-model attribution when native, else the
  // store-derived aggregate over verdicts.
  const sumTokens = (v: Verdict) => v.tokensIn + v.tokensOut
  const burn = useMemo(() => {
    if (dash) {
      const providers = bucketProviders(dash.cost_by_model)
      return {
        providers,
        localSharePct: localShare(dash.cost_by_model).pct,
        cost: dash.total_cost,
        tokens: dash.total_tokens,
        real: true,
      }
    }
    // Browser fallback: the same shape, grouped by the model each session
    // verdict actually routed to — no hardcoded provider names here either.
    const byModel = new Map<string, { tokens: number; isLocal: boolean }>()
    for (const v of verdicts) {
      const key = v.route.model
      const prev = byModel.get(key) ?? { tokens: 0, isLocal: v.route.target === 'local' }
      byModel.set(key, { tokens: prev.tokens + sumTokens(v), isLocal: prev.isLocal })
    }
    const providers: ProviderBurn[] = [...byModel.entries()]
      // No per-provider cost in the session store — 0, not an apportioned guess.
      .map(([key, m]) => ({ key, label: key, tokens: m.tokens, cost: 0, isLocal: m.isLocal }))
      .sort((a, b) => b.tokens - a.tokens)
    return {
      providers,
      localSharePct: stats.localSharePct,
      cost: stats.costToday,
      tokens: stats.tokensToday,
      real: false,
    }
  }, [dash, verdicts, stats.localSharePct, stats.costToday, stats.tokensToday])
  const burnMax = Math.max(1, ...burn.providers.map((p) => p.tokens))

  // Hook fire-rate, block-rate, ERRORS and gate latency — REAL from the hook
  // spans when native. `dispatch` is kept out of the latency aggregate (it
  // wraps the whole model call) and reported separately.
  const hookView = useMemo(() => (dash ? hookHealth(dash.hooks) : null), [dash])
  const hookLatencies = hookView?.latencies ?? []
  const hasHookData = (hookView?.fires ?? 0) > 0
  const badge = hookBadge(hookView)

  // Eval trend — REAL eval-score trend when native, else the passed-verdict
  // scores (store is newest-first, so reverse to chronological).
  const evalScores = useMemo(() => {
    if (dash) return dash.eval_trend.map((e) => e.eval_score)
    return verdicts.filter((v) => v.passed).map((v) => v.tier2.evalScore).reverse()
  }, [dash, verdicts])
  const firstEval = evalScores.length ? evalScores[0] : stats.evalAvg
  const lastEval = evalScores.length ? evalScores[evalScores.length - 1] : stats.evalAvg
  const evalCount = dash ? dash.eval_trend.length : verdicts.length
  const evalNote = `${firstEval.toFixed(2)} → ${lastEval.toFixed(2)} · ${evalCount} verdicts`

  // Drift — REAL fired drift signals when native (the top signal wins).
  const drift = dash?.drift[0] ?? null

  // REAL compliance export: runs the engine's hash-chained evidence export and
  // saves <vault>/exports/compliance-export.json.
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')
  const doExport = async () => {
    if (!isNative()) {
      setExportNote('needs the installed app')
      return
    }
    setExporting(true)
    const vault = await resolveVaultDir(vaultPath)
    const json = await runNativeExport(vault)
    setExporting(false)
    setExportNote(json ? '✓ saved to exports/compliance-export.json' : 'export failed — run a task first')
  }

  return (
    <div className="console">
      {/* header */}
      <PageHead
        title="Governance"
        em="console"
        hint="the leadership view · burn, drift and enforcement at a glance"
        actions={
          /* A dropped engine read is STATED, not hidden behind numbers that
             quietly reverted to the session fallback. */
          dashNote ? <span className="console__note mono">{dashNote}</span> : undefined
        }
      />

      {/* grid */}
      <div className="console__grid">
        {/* The "agent execution graph" card used to live here. It was a static
            SVG with fixed coordinates — the same three nodes and two edges no
            matter what ran — so it claimed a topology nobody measured. Deleted
            rather than decorated (2026-08-09 honesty pass); the real per-run
            span tree is on Work, driven by the live span stream. */}

        {/* token burn CEO view */}
        <div className="console__card">
          <div className="console__cardhead">
            <span className="console__kicker">Token burn — the CEO view</span>
            <span className="console__spacer" />
            {burn.real && <span className="console__badge console__badge--ok">live engine</span>}
          </div>
          {burn.providers.length === 0 ? (
            <>
              <div className="console__spacer" />
              <div className="console__foot mono">
                no model calls recorded yet — a bar appears per provider once a run attributes tokens
              </div>
            </>
          ) : (
            <>
              <div className="console__bars">
                {burn.providers.map((p, i) => (
                  <Bar
                    key={p.key}
                    label={p.label}
                    height={pctHeight(p.tokens, burnMax)}
                    cls={p.isLocal ? 'console__bar--gold' : BAR_CLASSES[i % BAR_CLASSES.length]}
                  />
                ))}
              </div>
              {/* The local share is a PERCENTAGE — it lived as a fourth bar on this
                  chart, drawn on the same axis as three TOKEN counts. Mixed
                  units on the card labelled the CEO view; it is a sentence in
                  the footer now, where a share belongs. */}
              <div className="console__foot mono">
                {fmtMoney(burn.cost)} {burn.real ? 'attributed' : 'this session'} · {burn.tokens.toLocaleString()} tok ·{' '}
                {burn.providers.length} provider{burn.providers.length === 1 ? '' : 's'} · {burn.localSharePct}% of runs on your Mac
              </div>
            </>
          )}
        </div>

        {/* hook latency */}
        <div className="console__card">
          <div className="console__cardhead">
            <span className="console__kicker">Hook latency &amp; fire-rate</span>
            <span className="console__spacer" />
            <span className={'console__badge ' + badge.cls}>{badge.label}</span>
          </div>
          <svg width="100%" height="54" viewBox="0 0 240 54" preserveAspectRatio="none" className="console__spark">
            <path
              d={hookSparkPath(hookLatencies)}
              fill="none"
              stroke={hasHookData ? 'var(--ok)' : 'var(--muted-2)'}
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          <div className="console__metrics mono">
            <div>
              <div className="console__metric-val">
                {hookView && hookView.avgMs !== null ? `${hookView.avgMs.toFixed(1)}ms` : '—'}
              </div>
              <div className="console__metric-lbl">avg gate latency</div>
            </div>
            <div><div className="console__metric-val">{hookView ? hookView.fires : '—'}</div><div className="console__metric-lbl">hooks fired</div></div>
            <div><div className="console__metric-val console__metric-val--red">{hookView ? hookView.blocks : '—'}</div><div className="console__metric-lbl">blocked</div></div>
            <div><div className="console__metric-val console__metric-val--red">{hookView ? hookView.errors : '—'}</div><div className="console__metric-lbl">hook errors</div></div>
            {/* Separate tile, separate meaning: these runs were CAUGHT, not
                dropped. Merging them into "errors" reported the ratchet as
                broken on every run it correctly failed. */}
            <div><div className="console__metric-val">{hookView ? hookView.failedOutcomes : '—'}</div><div className="console__metric-lbl">runs failed by a hook</div></div>
          </div>
          {/* Say exactly what the average covers. `dispatch` wraps the whole
              model call, so averaging it in reported the LLM's thinking time as
              enforcement overhead (170,039.5ms on the real vault). */}
          <div className="console__foot mono">
            {hasHookData
              ? `gate hooks only · dispatch excluded${
                  hookView?.dispatchAvgMs != null
                    ? ` (dispatch wraps the model call: ${(hookView.dispatchAvgMs / 1000).toFixed(1)}s avg)`
                    : ''
                }`
              : 'hook health appears after your first native runs'}
          </div>
        </div>

        {/* drift — celebratory amber ONLY on a real drift signal; the good
            ("no drift") and absent ("no data yet") states read calm/neutral (P7). */}
        <div className={'console__card console__card--drift' + (drift ? ' is-alert' : '')}>
          <div className="console__drifthead">
            <span className="console__drift-icon">{drift ? '⚠' : dash ? '✓' : '·'}</span>
            <span className={'console__kicker' + (drift ? ' console__kicker--warn' : '')}>
              Drift {drift ? 'alert' : 'monitor'}
            </span>
          </div>
          {dash ? (
            drift ? (
              <>
                <div className="console__drift-title">{drift.kind.replace(/_/g, ' ')} · {drift.severity}</div>
                <div className="console__drift-desc">{drift.reason}</div>
              </>
            ) : (
              <>
                <div className="console__drift-title">No drift signals</div>
                <div className="console__drift-desc">every run within envelope · eval, cache, and cost stable across {dash.runs} runs</div>
              </>
            )
          ) : (
            <>
              <div className="console__drift-title">No engine data yet</div>
              <div className="console__drift-desc">drift monitoring starts after your first native runs</div>
            </>
          )}
          <div className="console__spacer" />
        </div>

        {/* eval trend + audit export */}
        <div className="console__card">
          <div className="console__kicker">Eval scores · audit export</div>
          <svg width="100%" height="40" viewBox="0 0 240 40" preserveAspectRatio="none" className="console__spark">
            <path d={evalSparkPath(evalScores)} fill="none" stroke="var(--gold-deep)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <div className="console__evalnote mono">{evalNote}</div>
          <div className="console__spacer" />
          <div className="console__export">
            <span className="console__daterange mono">{exportNote || 'hash-chained evidence'}</span>
            <button type="button" className="console__export-btn" disabled={exporting} onClick={() => void doExport()}>
              {exporting ? 'Exporting…' : 'Export compliance report'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Bar({ label, height, cls }: { label: string; height: string; cls: string }) {
  return (
    <div className="console__barcol">
      <div className={'console__bar ' + cls} style={{ height }} />
      <div className="console__barlbl mono">{label}</div>
    </div>
  )
}
