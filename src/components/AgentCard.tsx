// AgentCard — the Work page's "who is working right now" card.
//
// HISTORY (2026-08-16 honesty pass, Finding 1): this card used to render
// the store's old live-agent slice, whose ONLY producer was the SIMULATOR's
// `agent` events. On a native install with a real primary that code path is
// never reached, so the card was empty 100% of the time — sitting directly
// under LiveRunCards, which was glowing with a real run. It also showed a
// `progress` percentage and a token `burn` the engine never reported.
//
// It now derives from the SAME truth every other live surface on the page
// does: one genuinely executing `LiveRun` (state.liveRuns minus parked runs)
// plus the REAL per-agent model_call spans of that run (agentOrbs). So:
//   * no live run → no card (AgentCardEmpty says exactly that),
//   * the role/model shown is one the engine really reported in a span; with
//     no span yet the card says so rather than naming a guess,
//   * the footer shows ELAPSED time (a real clock over a real start), never a
//     fabricated completion percentage.
import { Link } from 'react-router-dom'
import { elapsedLabel, kindLabel, shortIntent, type LiveRun } from '../lib/liveRuns'
import type { AgentOrb } from '../lib/orbs'
import { useNow } from '../lib/useNow'
import './AgentCard.css'

// Honest idle state: NO agent is running, so we render a true empty state rather
// than a fabricated "implementer · waiting…" card (which claimed a live worker
// that doesn't exist). No orb, no fake role/progress — just the truth + the
// action that starts a real one.
export function AgentCardEmpty() {
  return (
    <div className="agentcard agentcard--empty">
      <div className="agentcard__head">
        <span className="agentcard__kicker">Live agent</span>
        <span className="agentcard__count mono">none</span>
      </div>
      <p className="agentcard__empty">No agent running — describe a task to start one.</p>
    </div>
  )
}

export default function AgentCard({
  run,
  orbs,
  now: fixedNow,
}: {
  /** A run that is genuinely EXECUTING (callers pass activeRuns(...)[0]). */
  run: LiveRun
  /** REAL per-agent model_call spans of THIS run — [] when none can honestly
   *  be attributed to it (2+ runs live, or no span yet). */
  orbs: readonly AgentOrb[]
  /** Injected wall clock (tests). Omitted → a 1s tick while the card is up. */
  now?: number
}) {
  const now = useNow(true, fixedNow)
  const lead = orbs[0]
  return (
    <Link to="/console" className="agentcard">
      <div className="agentcard__head">
        <span className="agentcard__kicker">Live agent</span>
        <span className="agentcard__count mono">{kindLabel(run.kind)}</span>
      </div>
      <div className="agentcard__row">
        <span className="agentcard__orb" style={lead ? { background: lead.color } : undefined} />
        <div>
          {/* The role is a REAL span's agent name, or — before any model_call
              span exists — the kind of run this is. Never an invented role. */}
          <div className="agentcard__role">{lead ? lead.agent : kindLabel(run.kind)}</div>
          <div className="agentcard__meta mono">{shortIntent(run.intent, 60)}</div>
          <div className="agentcard__stat mono">
            {orbs.length > 0
              ? orbs.map((o) => (o.model ? `${o.agent} · ${o.model}` : o.agent)).join(' · ')
              : 'no model call reported yet'}
          </div>
        </div>
      </div>
      <div className="agentcard__foot">
        <span className="mono">console ›</span>
        <span className="mono agentcard__elapsed">{elapsedLabel(run.startedAt, now)}</span>
      </div>
    </Link>
  )
}
