import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../store/AppStore'
import { useSettings } from '../lib/settings'
import {
  isNative,
  resolveVaultDir,
  runNativeOkf,
  type EngineSpan,
  type OkfReport,
} from '../lib/nativeEngine'
import { okfGroups, whereLine, type OkfGroup } from '../lib/okfReport'
import DrawerSection from '../components/DrawerSection'
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

/** What the check covered: the notes it read, and the project files it left
 *  out on purpose (work products are counted, not checked). */
export function okfChecked(report: OkfReport): string {
  const n = report.doc_count
  const notes = `${n} note${n === 1 ? '' : 's'} checked`
  const w = report.workProducts
  return w > 0 ? `${notes} · ${w} project file${w === 1 ? '' : 's'} not checked` : notes
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
        <span>{report ? okfChecked(report) : '0 notes checked'}</span>
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

// Memory — the vault's health check, the three-tier memory model, and the
// token-budget gauge.
//
// THE PAGE IS ABOUT MEMORY (2026-11-14, the once-only pass). It used to carry a
// "learning flywheel" under the tiers: the local-versus-cloud share (also the
// rail's meter, Stats and Console), Tier-1 saves (Stats' own hero card), a
// cost line (Stats), a count of recorded runs, and two cards about the
// learning gate that only pointed at the Training tab beside this one. Each
// of those figures has one page that owns it; none is repeated here.
//
// What remains is measured: the budget gauge reads the engine's own `memory`
// span for ONE run (it once compared a cumulative session total to a
// per-injection cap and sat at "over cap!"), or says nothing has been measured.

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
  const { settings } = useSettings()
  // The span tail is followed only while a run is genuinely live; it already
  // carries the `memory` retrieval span the budget gauge needs.
  const live = activeRuns(state.liveRuns).length > 0
  const { spans } = useSpanTail(settings.vaultPath, live)

  // Token-budget gauge — the REAL memory-injection span of the newest run that
  // injected anything (budget + injected_tokens), or nothing at all.
  const injection = useMemo(() => memInjection(spans), [spans])

  return (
    <div className="memory">
      {/* A dropped engine read is STATED via `hint`, not silently rendered
          as "0%". */}
      <PageHead title="Memory" hint="three tiers · measured from your own runs" />

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
              {/* What L2 really holds since 2026-11-11: a project build's
                  step outcomes, recorded by the engine and shown to the next
                  step. Nothing wrote to this tier before. */}
              <div className="tier__desc">each step of a project build records what it did · the next step reads it</div>
              <div className="tier__meta">kept apart per project · starts clean with each build</div>
            </div>
            <div className="tier tier--l3">
              <div className="tier__label">L3 · Vault</div>
              {/* "git-synced" only when a repo is configured, and it names the
                  repo: the card said it on an install whose vault was not a
                  git repository at all (2026-11-11). */}
              <div className="tier__desc">
                single source of truth ·{' '}
                {settings.githubRepo ? `git-synced to ${settings.githubRepo}` : 'markdown files on this Mac'}
              </div>
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
      </div>
    </div>
  )
}
