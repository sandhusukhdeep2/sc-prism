import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../store/AppStore'
import type { Verdict } from '../engine/types'
import { heroSaves, localShare, pendingHero, type HeroSaves } from '../lib/engineStats'
import { staleNote, useLiveDashboard } from '../lib/liveDashboard'
import { activeRuns } from '../lib/liveRuns'
import { useSettings } from '../lib/settings'
import { costDirection, costFloorSeries } from '../lib/costTrend'
import { fmtMoney } from '../lib/money'
import LearningPanel from '../components/LearningPanel'
import './Stats.css'
import PageHead from '../components/PageHead'

// --- tiny sparkline helpers: map a numeric series into an SVG path within a viewBox ---

type Pt = [number, number]

function toPoints(vals: number[], w: number, h: number, pad = 6): Pt[] {
  const n = vals.length
  if (n === 0) return []
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  return vals.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w
    const y = pad + (1 - (v - min) / span) * (h - pad * 2)
    return [x, y]
  })
}

function toLine(pts: Pt[], w: number): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) {
    const y = pts[0][1].toFixed(1)
    return `M0 ${y} L${w} ${y}` // single sample → flat line so the spark is visible
  }
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
}

function toArea(line: string, w: number, h: number): string {
  return line ? `${line} L${w} ${h} L0 ${h} Z` : ''
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `${Math.round(n)}`
}

function tokensOf(v: Verdict): number {
  return v.tokensIn + v.tokensOut
}

// Finding 4's hero projection now lives in lib/engineStats (Memory reports the
// same Tier-1 saves); re-exported here because this page's hero test and the
// rest of the app import it from Stats.
export { heroSaves }
export type { HeroSaves }

export default function Stats() {
  const { state } = useApp()
  const { stats, verdicts } = state
  const { settings } = useSettings()
  const vaultPath = settings.vaultPath

  // REAL engine observability (native only). Re-fetched when a verdict lands
  // AND, via the shared hook (Finding 5), every 2.5s while a run is genuinely
  // live — never when idle. `null` in-browser.
  const live = activeRuns(state.liveRuns).length > 0
  // A failed read keeps the last measurement and says so; the first read is a
  // distinct 'loading' state, so the hero never paints the session fallback
  // (and its "engine history unavailable here") before the engine has answered.
  const dashRead = useLiveDashboard(vaultPath, live, verdicts.length)
  const dash = dashRead.dash
  const dashNote = staleNote(dashRead)

  // verdicts are stored newest-first; charts read oldest→newest.
  const chron = useMemo(() => [...verdicts].reverse(), [verdicts])

  // Token burn by model — REAL per-model cost attribution when native, else the
  // store split (cloud vs local by tokens, apportioning today's cost).
  const burn = useMemo(() => {
    if (dash) {
      // The ONE local/cloud split, shared with Memory and Console. This page
      // used to re-implement the provider rule inline; two copies of "what
      // counts as local" is exactly how the pages came to disagree about the
      // same measurement in the first place.
      const s = localShare(dash.cost_by_model)
      return {
        localW: s.pct,
        cloudW: 100 - s.pct,
        cloudCost: s.cloudCost,
        localCost: s.localCost,
        total: dash.total_cost,
        tokens: s.totalTokens,
        localTok: s.localTokens,
        cloudTok: s.cloudTokens,
      }
    }
    let localTok = 0
    let cloudTok = 0
    for (const v of verdicts) {
      if (v.route.target === 'local') localTok += tokensOf(v)
      else cloudTok += tokensOf(v)
    }
    const total = localTok + cloudTok
    const localW = total ? (localTok / total) * 100 : 0
    const cloudW = 100 - localW
    return {
      localW,
      cloudW,
      cloudCost: stats.costToday * (cloudW / 100),
      localCost: stats.costToday * (localW / 100),
      total: stats.costToday,
      tokens: total,
      localTok,
      cloudTok,
    }
  }, [dash, verdicts, stats.costToday])

  // Hero + its breakdown — the engine's whole Tier-1 history when the installed
  // app can read it, otherwise the session, said out loud.
  const hero = useMemo(
    () => (dashRead.status === 'loading' ? pendingHero() : heroSaves(dash, verdicts)),
    [dash, verdicts, dashRead.status],
  )

  // Eval score trend — REAL eval-score trend when native, else verified verdicts.
  const evalSeries = useMemo(() => {
    if (dash) return dash.eval_trend.map((e) => e.eval_score)
    return chron.filter((v) => v.passed).map((v) => v.tier2.evalScore)
  }, [dash, chron])
  const evalLine = useMemo(() => toLine(toPoints(evalSeries, 240, 52), 240), [evalSeries])
  const evalArea = useMemo(() => toArea(evalLine, 240, 52), [evalLine])
  const evalFrom = evalSeries.length ? evalSeries[0] : stats.evalAvg
  const evalTo = evalSeries.length ? evalSeries[evalSeries.length - 1] : stats.evalAvg
  const evalAvg = useMemo(() => {
    if (!dash || evalSeries.length === 0) return stats.evalAvg
    return evalSeries.reduce((s, n) => s + n, 0) / evalSeries.length
  }, [dash, evalSeries, stats.evalAvg])

  // Cache hit-rate + warmth — REAL from the engine's span stream when native.
  const cacheView = useMemo(() => {
    if (!dash) return null
    const c = dash.cache
    const line = toLine(toPoints([...c.warmth_curve], 240, 46), 240)
    const cold = c.warmth < 0.5
    return {
      hitRatePct: Math.round(c.hit_rate * 100),
      warmthLine: line,
      warmthLabel: cold ? 'warming' : 'warm',
      cold,
    }
  }, [dash])

  // Cost over time: marginal cost per task (the "cost floor") walked across verdicts.
  const costSeries = useMemo(() => costFloorSeries(dash, chron.map((v) => v.cost)), [dash, chron])
  const costLine = useMemo(() => toLine(toPoints(costSeries, 240, 52), 240), [costSeries])
  const costArea = useMemo(() => toArea(costLine, 240, 52), [costLine])
  const costTrendPct = useMemo(() => {
    if (costSeries.length < 2) return 0
    const first = costSeries[0]
    // No baseline → no percentage. `first || 1` used to fabricate a % against
    // an invented $1 baseline when the first run cost $0.
    if (!Number.isFinite(first) || first <= 0) return 0
    const last = costSeries[costSeries.length - 1]
    return ((first - last) / first) * 100
  }, [costSeries])
  // Shared honest deadband (same as Memory): the direction only claims what the
  // real series shows — no "falling" on zero data, no "holding" while it rises,
  // and 'none' when the last run cost $0 (an absent measurement, not a victory).
  const costDir = useMemo(() => costDirection(costSeries), [costSeries])
  const costTrendLabel =
    costDir === 'flat' || costDir === 'none'
      ? '—'
      : `${costDir === 'down' ? '↓' : '↑'} ${Math.abs(Math.round(costTrendPct))}%`

  return (
    <div className="stats">
      {/* header */}
      {/* `hint` carries dashNote: a dropped engine read is STATED, not silently
          rendered as a session number captioned "engine history unavailable". */}
      <PageHead
        title="Provably done,"
        em="at falling cost"
        hint={dashNote || undefined}
        actions={
          <div className="stats__range">
            <span className="stats__range-item is-active">All activity</span>
          </div>
        }
      />

      {/* dashboard grid */}
      <div className="stats__grid">
        {/* Tier-1 saves HERO */}
        <div className="stats__hero">
          <div className="stats__hero-glow" />
          <div className="stats__hero-kicker">
            <span className="stats__hero-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="#4a3a00"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>
            </span>
            <span className="stats__kicker-dark">
              Tier-1 saves ·{' '}
              {hero.pending ? 'reading the engine' : hero.engineScoped ? 'all engine runs' : 'this session'}
            </span>
          </div>
          {/* A number the page has not read yet is not a measurement. */}
          <div className="stats__hero-num mono">{hero.pending ? '—' : hero.saves}</div>
          <div className="stats__hero-desc">failures blocked by free, deterministic checks <span className="stats__dim">before spending a single eval token</span></div>
          {/* An honest zero says WHY it is zero; a real number says over what. */}
          <div className="stats__hero-desc stats__dim">{hero.note}</div>
          {/* Runs where the gate could not RUN are never saves — they are their
              own line, because "nothing was verified" is the opposite of
              "something was caught". */}
          {hero.unverifiedNote && (
            <div className="stats__hero-desc stats__dim">{hero.unverifiedNote}</div>
          )}
          <div className="stats__grow" />
          <div className="stats__hero-list mono">
            <div className="stats__hero-row"><span className="stats__dim">tests caught</span><span className="stats__on-dark">{hero.caught.tests}</span></div>
            <div className="stats__hero-row"><span className="stats__dim">lint caught</span><span className="stats__on-dark">{hero.caught.lint}</span></div>
            <div className="stats__hero-row"><span className="stats__dim">build caught</span><span className="stats__on-dark">{hero.caught.build}</span></div>
            {hero.caught.other > 0 && (
              <div className="stats__hero-row"><span className="stats__dim">uncategorised</span><span className="stats__on-dark">{hero.caught.other}</span></div>
            )}
            <div className="stats__hero-hr" />
            <div className="stats__hero-row">
              <span className="stats__dim">eval tokens avoided</span>
              <span className="stats__green-2">
                {hero.avoidedTokens === null ? '—' : `~${fmtK(hero.avoidedTokens)}`}
              </span>
            </div>
            <div className="stats__hero-row"><span className="stats__dim">{hero.avoidedBasis}</span></div>
          </div>
        </div>

        {/* token burn by model */}
        <div className="stats__card">
          {/* The bar measures TOKEN SHARE, so it is labelled with token share —
              it used to print a $0.00 cost inside a 75%-wide segment. Cost is
              stated separately, under its own heading. */}
          <div className="stats__kicker">Token share by route · cost attributed</div>
          <div className="stats__big-row"><span className="stats__big mono">{fmtMoney(burn.total)}</span><span className="stats__unit">{dash ? 'attributed' : 'total'}</span></div>
          {burn.tokens === 0 ? (
            <>
              <div className="stats__grow" />
              <div className="stats__note">no tokens attributed yet — the split appears after your first run</div>
            </>
          ) : (
            <>
              <div className="stats__stack">
                <div className="stats__seg stats__seg--cloud" style={{ width: `${burn.cloudW}%` }}><span className="stats__seg-txt mono">cloud {Math.round(burn.cloudW)}%</span></div>
                <div className="stats__seg stats__seg--local" style={{ width: `${burn.localW}%` }}><span className="stats__seg-txt stats__seg-txt--dark mono">local {Math.round(burn.localW)}%</span></div>
              </div>
              <div className="stats__legend mono">
                <span><span className="stats__sw stats__sw--cloud" />cloud {fmtK(burn.cloudTok)} tok · {fmtMoney(burn.cloudCost)}</span>
                <span><span className="stats__sw stats__sw--gold" />local {fmtK(burn.localTok)} tok · {fmtMoney(burn.localCost)}</span>
              </div>
              <div className="stats__grow" />
              {burn.localTok > 0 && burn.localW >= 50 && (
                <div className="stats__green">most tokens stayed local ↓</div>
              )}
            </>
          )}
        </div>

        {/* cache — REAL hit-rate + warmth from the span stream when native */}
        <div className="stats__card">
          <div className="stats__kicker">Cache</div>
          <div className="stats__big-row"><span className="stats__big mono">{cacheView ? `${cacheView.hitRatePct}%` : '—'}</span><span className="stats__unit">hit rate</span></div>
          <svg width="100%" height="46" viewBox="0 0 240 46" preserveAspectRatio="none" className="stats__spark">
            <path d={cacheView ? cacheView.warmthLine : 'M0 40 L240 40'} fill="none" stroke="var(--gold-deep)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <div className="stats__grow" />
          <div className="stats__note">{cacheView ? <>cache warmth: <span className="stats__warm">{cacheView.warmthLabel}</span> from the live span stream</> : 'cache stats appear after your first native runs'}</div>
        </div>

        {/* eval trend */}
        <div className="stats__card">
          <div className="stats__kicker">Eval score trend</div>
          <div className="stats__big-row">
            <span className="stats__big stats__big--gold mono">
              {evalSeries.length === 0
                ? '—'
                : evalSeries.length >= 2
                  ? `${evalFrom.toFixed(2)} → ${evalTo.toFixed(2)}`
                  : stats.evalAvg.toFixed(2)}
            </span>
          </div>
          <svg width="100%" height="52" viewBox="0 0 240 52" preserveAspectRatio="none" className="stats__spark">
            <path d={evalLine} fill="none" stroke="var(--gold-deep)" strokeWidth="2.5" strokeLinecap="round" />
            <path d={evalArea} fill="rgba(131, 162, 219,.12)" />
          </svg>
          <div className="stats__grow" />
          <div className="stats__note">
            {evalSeries.length === 0
              ? 'eval scores appear after your first verified run'
              : `DeepEval judge · avg ${evalAvg.toFixed(2)} across all verified tasks`}
          </div>
        </div>

        {/* cost falling */}
        <div className="stats__card stats__card--gold">
          <div className="stats__kicker stats__kicker--gold">Cost over time</div>
          {/* 'none' = the last run cost $0, so there is NOTHING to claim: no
              arrow, no "falling". One free local run must not read as a win. */}
          <div className="stats__big-row"><span className="stats__big mono">{costTrendLabel}</span>{costSeries.length > 1 && costDir !== 'none' && <span className={costDir === 'down' ? 'stats__green' : costDir === 'up' ? 'stats__warn' : 'stats__neutral'}>{costDir === 'down' ? 'cost floor falling' : costDir === 'up' ? 'cost floor rising' : 'cost floor holding'}</span>}</div>
          <svg width="100%" height="52" viewBox="0 0 240 52" preserveAspectRatio="none" className="stats__spark">
            <path d={costLine} fill="none" stroke="var(--chart-dark)" strokeWidth="2.5" strokeLinecap="round" />
            <path d={costArea} fill="var(--area-soft)" />
          </svg>
          <div className="stats__grow" />
          <div className="stats__note">
            {costSeries.length === 0 ? (
              'cost trend appears after your first runs'
            ) : costDir === 'none' ? (
              'the last run cost $0 (no priced call) — no trend can be read from it'
            ) : (
              <>local models take over routine work · <Link to="/memory" className="stats__inlink">see learning ›</Link></>
            )}
          </div>
        </div>
      </div>

      {/* Model training — the honest "Run learning step" panel, shared with
          the first-class /training page (P4-1). See LearningPanel.tsx. */}
      <div className="stats__learn-card">
        <LearningPanel />
      </div>
    </div>
  )
}
