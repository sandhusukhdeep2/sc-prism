// RunLedger — "Recent runs" + "This week", the measured ledger on Work
// (visual system v2 spec, 2026-08-18; region model + one-source fix the same
// day). It lives in the right rail: an app-height region that scrolls
// internally, so it can never lengthen the page.
//
// RULE 7, which this file exists to keep: every number here is MEASURED.
//  · a recent-runs row is a real recorded `Verdict` — its own task, the
//    outcome the ENGINE recorded, what its checks really did, the route it
//    really took and its measured `durationMs`. No row is ever produced for a
//    run that did not run.
//  · the arcs count only verdicts that carry a REAL engine timestamp inside
//    the last seven days. A verdict with no timestamp cannot be placed in a
//    week, so it is reported separately and never folded in.
//  · an empty week SAYS SO. It does not draw an empty arc, because a ring at
//    zero still looks like a measurement.
//
// ONE SOURCE (2026-08-18). This component takes exactly ONE array. Both panels
// derive from it, so the pair that used to render "no runs yet" beside
// "1 passed · 14 needed a look" — one reading the session-only `finishedRuns`,
// the other the persisted verdicts — is now structurally impossible. See
// `recentRuns` in lib/pipeline.ts for the full account of that bug.
import { arcFraction, recentRuns, todaySpend, weekArcs, weekEmptyLine } from '../lib/pipeline'
import type { Verdict } from '../engine/types'
import './RunLedger.css'

/**
 * The outcome tag's class, three ways: blue for a pass, a QUIET neutral chip
 * for a replied chat turn, coral for everything that needs eyes. A reply is
 * conversation — before this class existed it fell into the coral bucket, and
 * the Recent runs table wore a red badge for every good chat answer.
 */
function tagClass(tone: string): string {
  if (tone === 'passed') return 'ledger__tag ledger__tag--ok'
  if (tone === 'replied') return 'ledger__tag ledger__tag--said'
  return 'ledger__tag ledger__tag--att'
}

function Arc({ n, label, frac, tone }: { n: number; label: string; frac: number; tone: 'blue' | 'coral' }) {
  return (
    <div className="ledger__arc">
      <div
        className={`ledger__donut ledger__donut--${tone}`}
        style={{ ['--sweep' as string]: `${Math.round(frac * 100)}%` }}
        role="img"
        aria-label={`${n} ${label}`}
      />
      <div className="ledger__arcn">{n}</div>
      <div className="ledger__arcl">{label}</div>
    </div>
  )
}

export default function RunLedger({
  verdicts,
  now = Date.now(),
  layout = 'rail',
}: {
  /** The app's ONE measured record of finished runs. Both panels read it. */
  verdicts: readonly Verdict[]
  now?: number
  /**
   * Which shape Recent runs takes.
   *
   * 'row'  — a real table with headers (task, outcome, checks, ran on, took),
   *          for the full-width evidence row under the work.
   * 'rail' — the same facts stacked into a list, because five columns in a
   *          320px rail would truncate every one of them.
   *
   * The CALLER decides, because the caller is the thing that knows how much
   * room it is giving this component. The first attempt let CSS pick by
   * container query and rendered BOTH shapes — which meant a screen reader read
   * every run twice. A layout choice is not worth an accessibility bug.
   */
  layout?: 'rail' | 'row'
}) {
  const rows = recentRuns(verdicts)
  const week = weekArcs(verdicts, now)
  // Derived from the SAME array as the card above — see todaySpend for the
  // screenshot this prevents. An accumulator prop can lie; a derivation can't.
  const spentToday = todaySpend(verdicts, now)
  const empty = weekEmptyLine(week)
  // Audit fix (2026-08-30): the local-share % DERIVES from the same array as
  // every other number here — the file's own one-source rule, which its
  // footer used to break by reading an accumulator prop (demo: '61%' beside
  // one run). A verdict counts local when its recorded route says so.
  const localShare = Math.round(
    (verdicts.filter((v) => (v as { route?: { target?: string } }).route?.target === 'local').length /
      Math.max(1, verdicts.length)) * 100,
  )
  const nonPass = week.attention + week.failed
  // The footer states measured stats only once SOMETHING is measured — and it
  // reads the same array the rows and the arcs come from, so it cannot claim a
  // history the panels above deny.
  const hasRuns = verdicts.length > 0

  // A brand-new install gets ONE quiet line, not two panels of empty chrome
  // (UI pass 2026-08-29). The full ledger appears with the first real run.
  if (!hasRuns) {
    return (
      <div className="ledger ledger--blank mono">
        no runs yet — your first run's story lands here
      </div>
    )
  }

  return (
    <div className={'ledger' + (layout === 'row' ? ' ledger--row' : '')}>
      <section className="ledger__panel" aria-label="Recent runs">
        <div className="ledger__head">
          <span className="ledger__title">Recent runs</span>
        </div>
        {rows.length === 0 ? (
          <div className="ledger__empty">
            no runs yet — a row appears here the moment one finishes
          </div>
        ) : (
          /* TWO SHAPES, ONE SOURCE — see `layout`. The row already carries
             exactly the five facts the design note wants as columns, so a wide
             ledger draws them as a real table; a rail stacks them. */
          layout === 'row' ? (
            <table className="ledger__table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Ran on</th>
                  <th scope="col">Took</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="ledger__ctask">{r.task}</td>
                    <td>
                      <span className={tagClass(r.tone)}>{r.outcome}</span>
                    </td>
                    {/* Only what was recorded — an em dash where the verdict
                        carried nothing, never an invented check line. */}
                    <td className="ledger__cdetail mono">{r.detail || '—'}</td>
                    <td className="ledger__cran mono">{r.ranOn || '—'}</td>
                    <td className="ledger__ctook mono">{r.took || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ol className="ledger__rows">
              {rows.map((r) => (
                <li key={r.key} className="ledger__row">
                  <div className="ledger__rowtop">
                    <span className="ledger__task">{r.task}</span>
                    <span className={tagClass(r.tone)}>{r.outcome}</span>
                  </div>
                  {(r.detail || r.ranOn || r.took) && (
                    <div className="ledger__rowmeta mono">
                      {[r.detail, r.ranOn, r.took].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )
        )}
        <div className="ledger__note">Every row is a real run. Nothing here is an estimate.</div>
      </section>

      <section className="ledger__panel" aria-label="This week">
        <div className="ledger__head">
          <span className="ledger__title">This week</span>
        </div>
        {empty ? (
          <div className="ledger__empty">{empty}</div>
        ) : (
          <div className="ledger__arcs">
            <Arc n={week.passed} label="passed" frac={arcFraction(week.passed, week.dated)} tone="blue" />
            <Arc
              n={nonPass}
              label="needed a look"
              frac={arcFraction(nonPass, week.dated)}
              tone="coral"
            />
          </div>
        )}
        <div className="ledger__note">
          {hasRuns
            ? `${localShare}% of runs ran on your own Mac · ${spentToday > 0 ? `$${spentToday.toFixed(2)} spent on cloud today` : 'nothing spent on cloud today'}`
            : 'nothing measured yet — these fill in as you work'}
        </div>
      </section>
    </div>
  )
}
