// The one number that is always in view: how much of the measured model work
// stayed on the local model. It is the SAME split Stats, Memory and Console
// read (`localShare` over the engine's cost_by_model, which counts real
// completions only since 2026-11-08), so the rail can never disagree with the
// pages. Four honest states, nothing else:
//   no local provider → "0% local — add one" (the nudge, not a measurement)
//   nothing read yet  → nothing at all (no dashboard: browser, no vault, first load)
//   nothing measured  → "no work yet"
//   measured          → "<pct>% local" + tokens · cloud $ · so far
// "so far", not "today": the shared split has no day window, and a word that
// implies one would be a claim the data does not make.
import { Link } from 'react-router-dom'
import type { LocalShare } from '../lib/engineStats'
import type { DashStatus } from '../lib/liveDashboard'
import './LocalMeter.css'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

function Lock() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export default function LocalMeter({
  share,
  status,
  hasLocalProvider,
}: {
  share: LocalShare | null
  status: DashStatus
  hasLocalProvider: boolean
}) {
  if (!hasLocalProvider) {
    // Not a link to Stats: the one action that matters here is adding a model.
    return (
      <div className="meter meter--none" role="status">
        <span className="meter__num">
          <Lock />
          0% local —{' '}
          <Link to="/providers" className="meter__add">
            add one
          </Link>
        </span>
        <span className="meter__bar" aria-hidden="true" />
        <span className="meter__sub">no local model yet</span>
      </div>
    )
  }
  // No dashboard has been read (first load, a failed read with nothing before
  // it) or there is no engine at all ('none'): nothing is claimed. A loading or
  // stale read WITH a previous share keeps showing that share.
  if (!share || status === 'none') return null
  if (!share.measured) {
    return (
      <Link to="/stats" className="meter meter--empty" aria-label="no work yet — open Stats">
        <span className="meter__num">
          <Lock />
          no work yet
        </span>
        <span className="meter__bar" aria-hidden="true" />
      </Link>
    )
  }
  const sub = `${compact.format(share.totalTokens)} tokens · $${share.cloudCost.toFixed(2)} cloud · so far`
  return (
    <Link to="/stats" className="meter" aria-label={`${share.pct}% local — open Stats`}>
      <span className="meter__num">
        <Lock />
        {share.pct}% local
      </span>
      <span className="meter__bar" aria-hidden="true">
        <span className="meter__fill" style={{ width: `${share.pct}%` }} />
      </span>
      <span className="meter__sub mono">{sub}</span>
    </Link>
  )
}
