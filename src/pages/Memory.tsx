import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../store/AppStore'
import { isCliProvider, isCustomProvider, useSettings } from '../lib/settings'
import { costDirection, costFloorSeries } from '../lib/costTrend'
import {
  isNative,
  resolveVaultDir,
  runNativeOkf,
  type EngineSpan,
  type OkfReport,
} from '../lib/nativeEngine'
import { okfGroups, whereLine, type OkfGroup } from '../lib/okfReport'
import DrawerSection from '../components/DrawerSection'
import { heroSaves, localShare, pendingHero } from '../lib/engineStats'
import { staleNote, useLiveDashboard } from '../lib/liveDashboard'
import { useSpanTail } from '../lib/engineConsole'
import { activeRuns } from '../lib/liveRuns'
import './Memory.css'
import PageHead from '../components/PageHead'

// P8: the OKF badge state is a pure function of (in-flight, errored, report) so
// the "failure is a distinct outcome, not a stuck 'checking…'" contract is unit-
// testable. `error` is reached when a validation completed but produced no
// readable report (runNativeOkf returned null) or threw.
export type OkfStatus = 'checking' | 'error' | 'ok' | 'issues'
export function okfStatus(loading: boolean, errored: boolean, report: OkfReport | null): OkfStatus {
  if (loading) return 'checking'
  if (errored) return 'error'
  if (!report) return 'checking'
  return report.ok ? 'ok' : 'issues'
}

// A path the validator reported is a note in the vault unless it is the vault
// folder itself (not-a-directory / empty-bundle report the folder's own path).
function isVaultNote(path: string): boolean {
  return path.endsWith('.md') && !path.startsWith('/')
}

function OkfGroupRow({ group, level }: { group: OkfGroup; level: 'err' | 'warn' }) {
  return (
    <DrawerSection title={group.title} summary={whereLine(group)} className={`okf__group okf__group--${level}`}>
      <ul className="okf__files">
        {group.items.map((it, n) => (
          <li key={n} className="okf__file">
            {isVaultNote(it.path) ? (
              <Link className="okf__path mono" to={`/library?tab=vault&file=${encodeURIComponent(it.path)}`}>
                {it.path}
              </Link>
            ) : (
              <span className="okf__path mono">{it.path}</span>
            )}
            {group.showReasons && it.message && <span className="okf__reason">{it.message}</span>}
          </li>
        ))}
      </ul>
    </DrawerSection>
  )
}

// What the validator found, said once per cause (2026-11-11): a count, the
// cause as a sentence, and where the files sit. The files themselves stay
// folded until a cause is opened; each one opens in the Vault.
export function OkfIssues({ report }: { report: OkfReport }) {
  const errors = useMemo(() => okfGroups(report.issues), [report])
  const warnings = useMemo(() => okfGroups(report.warnings), [report])
  if (errors.length + warnings.length === 0) return null
  return (
    <div className="okf__groups">
      {errors.map((g) => (
        <OkfGroupRow key={`e-${g.code}`} group={g} level="err" />
      ))}
      {warnings.map((g) => (
        <OkfGroupRow key={`w-${g.code}`} group={g} level="warn" />
      ))}
    </div>
  )
}

// OKF (Open Knowledge Format) health of the vault — the knowledge layer the
// engine already validates; this surfaces it. Native only.
function OkfCard() {
  const { settings } = useSettings()
  const [report, setReport] = useState<OkfReport | null>(null)
  const [loading, setLoading] = useState(false)
  // P8: a failed/unparseable validation is a DISTINCT outcome from "in-flight".
  // runNativeOkf swallows errors and returns null, so without this flag a failure
  // reads 'checking…' forever. Track it so a failure looks like a failure.
  const [errored, setErrored] = useState(false)

  const check = async () => {
    setLoading(true)
    setErrored(false)
    try {
      const vault = await resolveVaultDir(settings.vaultPath)
      const r = await runNativeOkf(vault)
      setReport(r)
      setErrored(r === null) // null = the engine returned no readable report
    } catch {
      setReport(null)
      setErrored(true)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (isNative()) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!isNative()) return null
  const errs = report?.issues.length ?? 0
  const warns = report?.warnings.length ?? 0
  const status = okfStatus(loading, errored, report)

  return (
    <div className="okf">
      {/* A CARD's heading, not the page's — this sits inside Memory. It uses
          the shared card head so it matches every other panel in the app, and
          the live validity badge sits in the actions slot rather than being
          wedged into the title row as a second span at a second size. */}
      <div className="card__head">
        <h2 className="card__title">Knowledge vault</h2>
        <span className="card__hint mono">OKF v0.1</span>
        <span className="card__spacer" />
        <div className="card__actions">
          <span className={`okf__badge okf__badge--${status}`} role="status" aria-live="polite">
            {status === 'checking'
              ? 'checking…'
              : status === 'error'
                ? "couldn't validate — re-check"
                : report?.ok
                  ? '✓ valid bundle'
                  : `${errs} issue${errs === 1 ? '' : 's'}`}
          </span>
          <button type="button" className="okf__recheck" disabled={loading} onClick={() => void check()}>
            {loading ? 'checking…' : 'Re-check'}
          </button>
        </div>
      </div>
      {status === 'error' ? (
        <div className="okf__errnote">
          couldn&apos;t validate the vault — the engine returned no readable report. Re-check to try
          again.
        </div>
      ) : (
      <div className="okf__stats">
        <span>{report?.doc_count ?? 0} notes checked</span>
        <span className={errs ? 'okf__err' : ''}>
          {errs} error{errs === 1 ? '' : 's'}
        </span>
        <span className={warns ? 'okf__warn' : ''}>
          {warns} warning{warns === 1 ? '' : 's'}
        </span>
      </div>
      )}
      {report && status !== 'error' && <OkfIssues report={report} />}
      {report?.ok && errs === 0 && warns === 0 && (
        <div className="okf__clean">
          every concept has frontmatter + a body, links resolve, history is dated — your vault is
          clean, retrievable knowledge.
        </div>
      )}
    </div>
  )
}

// Memory & learning — the three-tier memory model, the token-budget gauge, and the learning
// flywheel (local-vs-cloud share, Tier-1 saves, cost floor).
//
// Finding 2 of the 2026-08-09 honesty pass: this page never called the engine
// dashboard, so it stated the OPPOSITE of the truth on the user's own install —
// "local now handles 0%" while the engine's model_call spans said 75%, a budget
// gauge pinned at "over cap!" because it compared cumulative session tokens to a
// PER-INJECTION cap, and a four-bar weekly "ramp" that was hardcoded. All three
// are gone. Every number here now comes from a measurement, and each one SAYS
// whether it is engine-scoped (every run ever recorded in the vault) or
// session-scoped (this app launch only).
// The REAL "Run learning step" honest gate lives on the dedicated Training page (see
// LearningPanel.tsx) — this page only links to it, it never states a fake measured outcome.

/** The real memory-injection reading: budget + injected tokens for ONE run. */
export interface MemInjection {
  budget: number
  injected: number
  /** how many items were injected, when the span recorded it. */
  items: number | null
  pct: number
  under: boolean
}

/**
 * The newest REAL memory-injection measurement in the span tail. The engine
 * writes one `memory` retrieval span per run carrying `budget` and
 * `injected_tokens` (loop.py's mem_s.set) — that pair, and nothing else, is
 * what the gauge may show. Returns null when no run in the tail injected
 * memory, so the page can say so instead of drawing a full bar over a
 * cumulative session total against a per-injection cap (the old bug).
 */
export function memInjection(spans: readonly EngineSpan[]): MemInjection | null {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]
    if (s.name !== 'memory') continue
    const a = s.attrs ?? {}
    const budget = typeof a.budget === 'number' ? a.budget : null
    const injected = typeof a.injected_tokens === 'number' ? a.injected_tokens : null
    if (budget === null || injected === null || budget <= 0) continue
    return {
      budget,
      injected,
      items: typeof a.injected === 'number' ? a.injected : null,
      pct: Math.min(100, (injected / budget) * 100),
      under: injected <= budget,
    }
  }
  return null
}

export default function Memory() {
  const { state } = useApp()
  const { stats, verdicts } = state
  const { settings } = useSettings() // also drives the cloud-configured caption below
  // Is a cloud provider actually configured? (a CLI bridge, or a cloud provider
  // with a real key). Drives an HONEST reasoning caption — a default local-only
  // setup keeps reasoning local (R2), so "stay on frontier models" would lie.
  const cloudConfigured = settings.providers.some(
    (p) =>
      p.enabled &&
      (isCliProvider(p.id) ||
        (p.id !== 'local' && !isCustomProvider(p.id) && !!p.apiKey?.trim())),
  )

  // REAL engine measurements (native only), refreshed by the ONE shared hook
  // while a run is genuinely live and never polled when idle (Finding 5).
  const live = activeRuns(state.liveRuns).length > 0
  // 'loading' is its own state: the hook used to start at `null`, the SAME value
  // it uses for "no engine here", so every mount painted the session fallback
  // ("local handles 0% of this session's routed work") for a frame before
  // snapping to the measured 86%. A failed read now keeps the last measurement
  // and says so, instead of rewriting a measured number to zero every 2.5s.
  const dashRead = useLiveDashboard(settings.vaultPath, live, verdicts.length)
  const dash = dashRead.dash
  const dashLoading = dashRead.status === 'loading'
  const dashNote = staleNote(dashRead)
  // The same span tail every other narration surface reads — it already carries
  // the `memory` retrieval span the budget gauge needs.
  const { spans } = useSpanTail(settings.vaultPath, live)

  // Local-vs-cloud share — the ENGINE's per-model token split (`claude-cli` /
  // `gemini-cli` / `local`, bucketed by the shared helper). The old page read
  // `stats.localSharePct`, which counts top-level verdict ROUTING inside one app
  // launch: on the user's install that said 0% while the engine said 75%. The
  // session number survives only as the in-browser fallback, labelled as such.
  const share = useMemo(() => {
    if (dash) {
      const s = localShare(dash.cost_by_model)
      return {
        pct: s.pct,
        localTokens: s.localTokens,
        cloudTokens: s.cloudTokens,
        measured: s.measured,
        engineScoped: true,
        loading: false,
      }
    }
    // Nothing has been read yet — not "0%", which is a measurement.
    if (dashLoading) {
      return { pct: 0, localTokens: 0, cloudTokens: 0, measured: false, engineScoped: true, loading: true }
    }
    return {
      pct: Math.max(0, Math.min(100, stats.localSharePct)),
      localTokens: 0,
      cloudTokens: 0,
      measured: verdicts.length > 0,
      engineScoped: false,
      loading: false,
    }
  }, [dash, dashLoading, stats.localSharePct, verdicts.length])

  // Token-budget gauge — the REAL memory-injection span of the newest run that
  // injected anything (budget + injected_tokens), or nothing at all.
  const injection = useMemo(() => memInjection(spans), [spans])

  // Tier-1 saves — the engine's whole gate history when the installed app can
  // read it, else this session, said out loud. Same projection Stats' hero uses.
  const hero = useMemo(
    () => (dashLoading ? pendingHero() : heroSaves(dash, verdicts)),
    [dash, dashLoading, verdicts],
  )

  // Cost floor sparkline — marginal cost per task walked across verdicts (oldest→newest).
  const costLine = useMemo(() => {
    const chron = [...verdicts].reverse()
    const vals = chron.map((v) => v.cost)
    const n = vals.length
    if (n === 0) return 'M0 20 L220 20'
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    if (n === 1) {
      const y = (6 + (1 - (vals[0] - min) / span) * 28).toFixed(1)
      return `M0 ${y} L220 ${y}`
    }
    return vals
      .map((v, i) => {
        const x = (i / (n - 1)) * 220
        const y = 6 + (1 - (v - min) / span) * 28
        return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }, [verdicts])

  // REAL count — no fabricated base. This session's produced verdicts; the
  // real on-disk training-record count (across sessions) is shown honestly
  // on the Training page via LearningPanel's `readTrainingCount`.
  const runsRecorded = verdicts.length

  // Honest cost-trend — only claim a direction the REAL cost series actually
  // shows (first vs last, 2% deadband); otherwise no directional claim. The
  // direction also drives the COLOR: rising cost is a warning, not a success.
  const costDir = useMemo(
    // The SAME series Stats reads (costFloorSeries) — these two pages once
    // told opposite cost stories because each walked its own private series.
    () => costDirection(costFloorSeries(dash, [...verdicts].reverse().map((v) => v.cost))),
    [dash, verdicts],
  )
  const costTrend = costDir === 'down' ? ' · trending down' : costDir === 'up' ? ' · trending up' : ''

  return (
    <div className="memory">
      {/* A dropped engine read is STATED via `hint`, not silently rendered
          as "0%". */}
      <PageHead
        title="Memory"
        em="& learning"
        hint={dashNote || 'three tiers · a flywheel that lowers cost every week'}
      />

      <OkfCard />

      <div className="mem-body">
        {/* TOP: memory tiers + token budget */}
        <div className="mem-top">
          <div className="mem-tiers">
            <div className="tier tier--l1">
              <div className="tier__label">L1 · Profile</div>
              <div className="tier__desc">who you are · roles, sign-offs, never-touch list</div>
              <div className="tier__meta">always loaded</div>
            </div>
            <div className="tier tier--l2">
              <div className="tier__label">L2 · Working memory</div>
              <div className="tier__desc">per-task · session-isolated · discarded on done</div>
              <div className="tier__meta">this task</div>
            </div>
            <div className="tier tier--l3">
              <div className="tier__label">L3 · Vault</div>
              <div className="tier__desc">single source of truth · git-synced markdown</div>
              <div className="tier__meta">
                indexes derived &amp; regenerable ·{' '}
                <Link to="/library?tab=vault" className="tier__link">
                  open ›
                </Link>
              </div>
            </div>
          </div>

          <div className="mem-budget">
            <div className="mem-budget__head">
              <span className="kicker">Token budget · memory injection</span>
              <span className="spacer" />
              {injection && (
                <span
                  className={'mem-budget__ok' + (injection.under ? '' : ' mem-budget__ok--over')}
                >
                  {injection.under ? 'under cap ✓' : 'over cap !'}
                </span>
              )}
            </div>
            {injection ? (
              <>
                <div className="mem-budget__nums">
                  <span className="mem-budget__val">{injection.injected.toLocaleString()}</span>
                  <span className="mem-budget__cap">
                    / {injection.budget.toLocaleString()} tokens injected
                  </span>
                </div>
                <div className="mem-gauge">
                  <div
                    className={
                      'mem-gauge__fill' + (injection.under ? '' : ' mem-gauge__fill--over')
                    }
                    style={{ width: `${injection.pct}%` }}
                  />
                </div>
                <div className="mem-budget__note">
                  the newest run that injected memory
                  {injection.items !== null
                    ? ` · ${injection.items} item${injection.items === 1 ? '' : 's'} selected`
                    : ''}{' '}
                  · measured on that run&apos;s memory span, not a session total
                </div>
              </>
            ) : (
              <div className="mem-budget__note">
                nothing measured yet — the engine records a memory budget and the tokens it
                actually injected on every run; this gauge fills from that span the first time a
                run injects memory.
              </div>
            )}
          </div>
        </div>

        {/* BOTTOM: learning flywheel */}
        <div className="mem-bottom">
          {/* local vs cloud share */}
          <div className="mem-share">
            <div className="kicker">Routine lane · local vs cloud share</div>
            <div className="mem-share__illustrative">
              {share.loading
                ? 'reading the engine…'
                : share.engineScoped
                  ? 'measured by the engine over every recorded run — the model calls themselves, not top-level routing'
                  : 'this app session only — the installed app measures every run'}
            </div>
            {share.measured ? (
              <>
                <div className="mem-share__split" role="img" aria-label={`local ${share.pct}%, cloud ${100 - share.pct}%`}>
                  <div className="mem-share__seg mem-share__seg--local" style={{ width: `${share.pct}%` }} />
                  <div className="mem-share__seg mem-share__seg--cloud" style={{ width: `${100 - share.pct}%` }} />
                </div>
                {share.engineScoped && (
                  <div className="mem-share__tokens mono">
                    {share.localTokens.toLocaleString()} local ·{' '}
                    {share.cloudTokens.toLocaleString()} cloud tokens
                  </div>
                )}
                {/* INSIDE the measured guard. Outside it, this line printed
                    "local handles 0% of this session's routed work" directly
                    under "no model call measured yet" — a percentage of nothing,
                    stated as a fact. */}
                <div className="mem-share__caption">
                  <b>local handles {share.pct}%</b> of{' '}
                  {share.engineScoped ? 'measured model-call tokens' : 'this session’s routed work'} ·{' '}
                  {cloudConfigured
                    ? 'reasoning & planning route to your cloud model'
                    : 'reasoning & planning stay local too — no cloud configured'}
                </div>
              </>
            ) : (
              <>
                <div className="mem-share__empty">
                  {share.loading
                    ? 'reading the engine…'
                    : 'no model call measured yet — nothing to divide'}
                </div>
                <div className="mem-share__caption">
                  {share.loading
                    ? 'the split appears once the engine answers'
                    : cloudConfigured
                      ? 'the split appears on your first measured model call · reasoning & planning route to your cloud model'
                      : 'the split appears on your first measured model call · no cloud configured, so everything stays local'}
                </div>
              </>
            )}
            <div className="mem-legend">
              <span>
                <span className="mem-legend__sw" style={{ background: 'var(--v2-local)' }} />
                local
              </span>
              <span>
                <span className="mem-legend__sw" style={{ background: 'var(--v2-blue)' }} />
                cloud
              </span>
            </div>
          </div>

          {/* middle stack: Tier-1 saves + cost floor */}
          <div className="mem-midcol">
            <div className="mem-saves">
              <div className="mem-saves__head">
                <span className="mem-saves__bolt">
                  <svg width="11" height="11" viewBox="0 0 24 24" style={{ fill: '#4a3a00' }}>
                    <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
                  </svg>
                </span>
                <span className="mem-saves__kicker">
                  Tier-1 saves ·{' '}
                  {hero.pending
                    ? 'reading the engine'
                    : hero.engineScoped
                      ? 'all recorded runs'
                      : 'this session'}
                </span>
              </div>
              <div className="mem-saves__num">{hero.pending ? '—' : hero.saves}</div>
              <div className="mem-saves__sub">failures blocked before eval tokens</div>
              <div className="mem-saves__note">{hero.note}</div>
              {/* Runs the gate could not RUN are not saves — said out loud. */}
              {hero.unverifiedNote && (
                <div className="mem-saves__note">{hero.unverifiedNote}</div>
              )}
            </div>

            <div className="mem-cost">
              <div className="kicker">Cost floor</div>
              <svg
                width="100%"
                height="40"
                viewBox="0 0 220 40"
                preserveAspectRatio="none"
                className="mem-cost__svg"
              >
                <path
                  d={costLine}
                  fill="none"
                  stroke="var(--chart-dark)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
                <path d={`${costLine} L220 40 L0 40 Z`} fill="var(--area-soft)" />
              </svg>
              <div
                className={
                  'mem-cost__trend' +
                  (costDir === 'down'
                    ? ' mem-cost__trend--down'
                    : costDir === 'up'
                      ? ' mem-cost__trend--up'
                      : '')
                }
              >
                marginal cost per task · this session&apos;s verdicts{costTrend}
              </div>
            </div>
          </div>

          {/* right stack: honest link-out to the real learning gate (P4-1) —
              no fabricated fine-tune/promotion claims; the REAL PROMOTE/DISCARD
              decision only ever comes from actually running the dry-run gate,
              which lives on the Training page (see LearningPanel.tsx). */}
          <div className="mem-rightcol">
            <div className="mem-ft">
              <div className="mem-ft__head">
                <span className="kicker">Route-policy learning</span>
              </div>
              <div className="mem-ft__nums">
                <span className="mem-ft__val">{runsRecorded.toLocaleString()}</span>
                <span className="mem-ft__label">runs recorded this session</span>
              </div>
              <div className="mem-ft__meta">
                the router learns route selection (local vs cloud) from real outcomes — never LLM
                fine-tuning; the learning step is a dry-run preview, and adopting a gate-passed
                router is a separate, explicit action
              </div>
              <div className="mem-ft__spacer" />
              <Link to="/library?tab=training" className="mem-ft__run">
                See real learning on the Training page →
              </Link>
            </div>

            <div className="mem-gate">
              <div className="mem-gate__head">
                <span className="mem-gate__kicker">Eval-lift gate</span>
              </div>
              <div className="mem-gate__desc">
                a new router is only ever adopted if it proves lift on your goldens — no
                regressions. Run the real, honest dry-run check on the Training page.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
