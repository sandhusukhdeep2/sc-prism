// OrbView — Manager View's "feel it" depth (MV4): the team as model-colored
// orbs. A compact cluster lives in the project rail; an "expand" button opens
// a full-screen "command view" with the same orbs, larger. Reuses `agentOrbs`
// (pure, lib/orbs.ts) for the data and `modelColor` for the color language
// already established by RunStream.
//
// HONESTY (paramount): every orb comes from agentOrbs, i.e. a REAL model_call
// span — no span, no orb, no fabricated agent. The pulse is the ONE animation
// this view shows, and it is gated on `running` alone (a real signal): we
// don't yet emit per-agent lifecycle spans, so a fabricated per-agent
// "working" glow would be a lie. A whole-cluster pulse while running is the
// only honest live signal available today.
import { useEffect, useState } from 'react'
import { agentDossier } from '../lib/agentDossier'
import AgentDossierPanel from './AgentDossierPanel'
import { agentOrbs } from '../lib/orbs'
import type { EngineSpan } from '../lib/nativeEngine'
import './OrbView.css'

const MANAGER_COLOR = 'var(--gold-deep)'

function Orb({
  label,
  color,
  outcome,
  model,
  size,
  pulse,
}: {
  label: string
  color: string
  // 'running' (in-flight) deliberately yields no colored ring — pulse only —
  // so an in-flight agent is never painted as a passed one.
  outcome?: 'ok' | 'failed' | 'running'
  model?: string
  size: 'sm' | 'lg'
  pulse: boolean
}) {
  const ringCls = outcome === 'ok' ? ' orb__dot--ok' : outcome === 'failed' ? ' orb__dot--failed' : ''
  const pulseCls = pulse ? ' orb__dot--pulse' : ''
  return (
    <div className={`orb orb--${size}`}>
      <span className={'orb__dot' + ringCls + pulseCls} style={{ background: color }}>
        {outcome === 'failed' && <span className="orb__x">✕</span>}
      </span>
      <span className="orb__label">{label}</span>
      {size === 'lg' && model && (
        <span className="orb__modelchip" style={{ color, borderColor: color }}>
          {model}
        </span>
      )}
    </div>
  )
}

export default function OrbView({ spans, running }: { spans: EngineSpan[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // The same click-through the board has, on the same derivation — one
  // coworker, one file, wherever you happen to be looking at them.
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const orbs = agentOrbs(spans)
  const dossier = openAgent ? agentDossier(spans, openAgent, running) : null

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Honest empty: nothing has run yet (or nothing had an agent) — no orbs,
  // not even the Manager anchor, so this view never implies a team is
  // present when it isn't.
  if (orbs.length === 0) return null

  return (
    <div className="orbview">
      <div className="orbview__header">
        <span className="orbview__kicker">Team orbs</span>
        <button
          type="button"
          className="orbview__expand"
          onClick={() => setExpanded(true)}
          aria-label="Expand to full-screen command view"
          title="Expand to full-screen command view"
        >
          ⤢
        </button>
      </div>
      {/* THE CREW, AS A LIST — not a wrapping grid of blank 22px blobs with
          truncated labels under them ("researc…"), which is what this was and
          what it looked like: a row of coloured dots you could not tell apart.

          A narrow rail is a COLUMN. Given one, each coworker gets a monogram in
          its own model's colour (the same mark the board draws, so one agent is
          one shape everywhere in the app), its full name, and the AI that
          really answered it. And it opens the same file the board opens,
          because a crew you can see and cannot ask about is decoration. */}
      <ul className="orbview__list">
        {orbs.map((o, i) => (
          <li key={o.agent}>
            <button
              type="button"
              className="orbview__seat"
              style={{ ['--seat' as string]: String(i), ['--tint' as string]: o.color }}
              aria-label={`What ${o.agent} is doing`}
              onClick={() => setOpenAgent(o.agent)}
            >
              <span
                className={
                  'orbview__mono' +
                  (running && o.outcome === 'running' ? ' is-live' : '')
                }
                style={{ background: o.color }}
                aria-hidden="true"
              >
                {o.agent.charAt(0).toUpperCase()}
              </span>
              <span className="orbview__who">
                <span className="orbview__name">{o.agent}</span>
                <span className="orbview__ai mono">{o.model || o.provider || 'model not named'}</span>
              </span>
              {/* The outcome is a PIP, not a ring around the monogram. A red
                  ring drawn around a green mark read as neither. */}
              <span
                className={`orbview__pip orbview__pip--${o.outcome}`}
                title={
                  o.outcome === 'ok' ? 'answered' : o.outcome === 'failed' ? 'did not answer' : 'working'
                }
              />
            </button>
          </li>
        ))}
      </ul>

      {dossier && <AgentDossierPanel dossier={dossier} onClose={() => setOpenAgent(null)} />}

      {expanded && (
        <div className="orbview__overlay" role="dialog" aria-modal="true" aria-label="Live command view">
          <button
            type="button"
            className="orbview__close"
            onClick={() => setExpanded(false)}
            aria-label="Close command view"
            title="Close (Esc)"
          >
            ✕
          </button>
          <div className="orbview__title">Live command view</div>
          <div className="orbview__stage">
            <Orb label="Manager" color={MANAGER_COLOR} size="lg" pulse={running} />
            <div className="orbview__ring">
              {orbs.map((o) => (
                <Orb key={o.agent} label={o.agent} color={o.color} outcome={o.outcome} model={o.model || o.provider} size="lg" pulse={running} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
