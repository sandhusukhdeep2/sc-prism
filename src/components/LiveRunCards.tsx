// LiveRunCards — Mission Control's "where did my task go" surface on the Work
// page (2026-08-05 spec §Live task cards).
//
// One card per run the app has in flight: what it is, which kind, how long it
// has been going, and — when the engine really reported them — the models
// actually on it. When a run ends, its card collapses to a compact outcome row
// with a click-through to the trace.
//
// HONESTY (the rule this component exists to keep):
//   * The glow/pulse class comes from ONE place: membership in `live`, which
//     is `state.liveRuns` — the store's single source of live-run truth. There
//     is no other input to it, so a card cannot glow without a live run behind
//     it, and a finished row can never glow.
//   * A run PARKED on a human answer (`run.paused`) is registered but is not
//     executing — its subprocess has already exited — so it does not glow
//     either. It says "waiting on you" instead of pretending to work.
//   * Model/agent names come from REAL model_call spans (agentOrbs), and only
//     when they can be honestly attributed to this card (see `runSpans`: with
//     two runs in flight the engine's spans can't be told apart, so nothing is
//     claimed). Never a client-side guess about routing.
//   * `run.models` is labelled "asked for" because that is what it is — the
//     roster the app requested, not a claim about who answered.
//   * The pulse respects prefers-reduced-motion (CSS).
import { Link } from 'react-router-dom'
import { agentOrbs } from '../lib/orbs'
import { useNow } from '../lib/useNow'
import {
  elapsedLabel,
  kindLabel,
  outcomeDetail,
  outcomeLabel,
  runSpans,
  type FinishedRun,
  type LiveRun,
} from '../lib/liveRuns'
import type { EngineSpan } from '../lib/nativeEngine'
import './LiveRunCards.css'

// The 1s wall clock lives in ../lib/useNow now — the Work page's Live agent
// card shows elapsed time off the SAME hook (one clock, one behaviour).

function LiveCard({
  run,
  spans,
  liveCount,
  now,
}: {
  run: LiveRun
  spans: EngineSpan[]
  liveCount: number
  now: number
}) {
  // REAL per-agent models for THIS run, or [] when they cannot honestly be
  // attributed to it (see runSpans). No spans → no chips, never a placeholder.
  const orbs = agentOrbs(runSpans(spans, run, liveCount))
  // Parked on the user: registered, but NOTHING is executing behind it.
  const paused = run.paused === true
  return (
    <div
      className={'lrun__card' + (paused ? ' lrun__card--paused' : ' lrun__card--glow')}
      aria-label={`${kindLabel(run.kind)} ${paused ? 'waiting on you' : 'running'}: ${run.intent}`}
    >
      <div className="lrun__top">
        <span className={`lrun__badge lrun__badge--${run.kind}`}>{kindLabel(run.kind)}</span>
        <span className="lrun__intent">{run.intent}</span>
        {paused && <span className="lrun__waiting mono">waiting on you</span>}
        <span className="lrun__elapsed mono">{elapsedLabel(run.startedAt, now)}</span>
      </div>
      {orbs.length > 0 && (
        <div className="lrun__models">
          {/* "on it now" only while something really is: a parked run has no
              model working on anything. */}
          <span className="lrun__modelslabel mono">{paused ? 'was on it' : 'on it now'}</span>
          {orbs.map((o) => (
            <span key={o.agent} className="lrun__model mono" style={{ borderColor: o.color }}>
              <span className="lrun__modeldot" style={{ background: o.color }} />
              {o.agent}
              {o.model ? ` · ${o.model}` : ''}
            </span>
          ))}
        </div>
      )}
      {orbs.length === 0 && run.models.length > 0 && (
        <div className="lrun__models">
          {/* "asked for" — the roster the app requested. NOT a claim about who
              actually answered; that only appears once real spans say so. */}
          <span className="lrun__modelslabel mono">asked for</span>
          {run.models.map((m) => (
            <span key={m} className="lrun__model lrun__model--asked mono">
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function FinishedRow({ run }: { run: FinishedRun }) {
  const label = outcomeLabel(run)
  // The chip already says the outcome word, so the detail drops a leading
  // repeat of it (A3): "stopped · stopped at 240s…" → "stopped · at 240s…".
  const detail = outcomeDetail(run)
  return (
    <Link to="/console" className={`lrun__row lrun__row--${run.outcome}`}>
      <span className={`lrun__badge lrun__badge--${run.kind}`}>{kindLabel(run.kind)}</span>
      <span className="lrun__intent">{run.intent}</span>
      <span className={`lrun__outcome lrun__outcome--${run.outcome}`}>{label}</span>
      {detail && <span className="lrun__detail mono">{detail}</span>}
      {/* Honest label: this goes to the global engine console, which shows the
          most recent spans — NOT a stored trace of this particular run (the
          app keeps none). It said "trace ›", which promised one. */}
      <span className="lrun__trace mono">console ›</span>
    </Link>
  )
}

export default function LiveRunCards({
  live,
  finished,
  spans,
  now: fixedNow,
}: {
  live: readonly LiveRun[]
  finished: readonly FinishedRun[]
  spans: EngineSpan[]
  /** Injected wall clock (tests). Omitted → a 1s tick while anything is live. */
  now?: number
}) {
  const now = useNow(live.length > 0, fixedNow)
  // Honest empty: nothing running and nothing finished this session → render
  // nothing at all, rather than an empty "activity" shell implying otherwise.
  if (live.length === 0 && finished.length === 0) return null

  return (
    <section className="lrun" aria-label="Live tasks">
      {live.map((run) => (
        <LiveCard key={run.id} run={run} spans={spans} liveCount={live.length} now={now} />
      ))}
      {finished.map((run) => (
        <FinishedRow key={`${run.id}-${run.endedAt}`} run={run} />
      ))}
    </section>
  )
}
