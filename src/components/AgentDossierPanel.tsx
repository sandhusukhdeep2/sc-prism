// AgentDossierPanel — what ONE coworker is actually doing, on demand.
//
// The crew cluster could always be looked at and never opened. Sukhdeep asked
// for exactly this: "when I click on that agent, I can see what that specific
// agent is working on." So every seat on the board is now a button, and this is
// what it opens.
//
// AGENTS ARE NOT PEOPLE — the same rule the board keeps. The reference design
// this borrows its shape from (a CRM journey board) puts a photograph on every
// card, because those cards are human colleagues. These are models. A stock
// face here would make the most convincing element on the page the only false
// one, so a coworker is a MONOGRAM in the colour of the model that answered.
//
// EVERY LINE IS A SPAN ATTR. The derivation is agentDossier.ts and it invents
// nothing; this file only lays it out. In particular the routing sentence is
// the ENGINE's own `reason`, quoted — "vault content read -> kept local (no
// egress)" is a thing the UI could never work out for itself, and it is the
// single most useful line on the panel.
import { useEffect, useRef } from 'react'
import {
  dossierCostLine,
  routingLine,
  type AgentDossier,
  type DossierTool,
} from '../lib/agentDossier'
import { stageLabel } from '../lib/pipeline'
import './AgentDossierPanel.css'
import Icon from './Icon'

/** Plain words for how a tool call ended, and the tone it earns.
 *  A BLOCK is a win — the gate did its job — so it never reads as an error. */
const ENDINGS: Record<DossierTool['ending'], { text: string; tone: string }> = {
  ok: { text: 'ran', tone: 'ok' },
  blocked: { text: 'refused by a gate', tone: 'gate' },
  held: { text: 'waiting on you', tone: 'held' },
  withheld: { text: 'result kept off the cloud', tone: 'gate' },
  failed: { text: 'failed', tone: 'bad' },
}

function ms(v: number): string {
  if (!v) return ''
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`
}

export default function AgentDossierPanel({
  dossier,
  onClose,
}: {
  dossier: AgentDossier
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, and focus lands on the close button when it opens — the
  // panel covers the board, so it must be dismissable without a mouse.
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const routing = routingLine(dossier)
  const cost = dossierCostLine(dossier)

  return (
    <div className="dossier" role="dialog" aria-modal="true" aria-label={`What ${dossier.agent} is doing`}>
      <div className="dossier__scrim" onClick={onClose} />
      <div className="dossier__sheet">
        <header className="dossier__head">
          <span
            className={'dossier__mono' + (dossier.live ? ' is-live' : '')}
            style={{ background: dossier.color }}
            aria-hidden="true"
          >
            {dossier.agent.charAt(0).toUpperCase()}
          </span>
          <span className="dossier__who">
            <span className="dossier__name">{dossier.agent}</span>
            {/* The AI that answered its LATEST turn — what it is on right now. */}
            {dossier.ai && <span className="dossier__ai mono">{dossier.ai}</span>}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="dossier__close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        {/* State first, because it is the question the click was asking. */}
        <div className={'dossier__state' + (dossier.live ? ' is-live' : '')}>
          {dossier.live ? (
            <>
              <i className="dossier__pip" aria-hidden="true" />
              Working now
            </>
          ) : (
            'Not running right now'
          )}
        </div>

        {routing && (
          <p className="dossier__routing">
            {dossier.allLocal && <span className="dossier__lock">🔒</span>}
            {routing}
          </p>
        )}

        {cost && <p className="dossier__cost mono">{cost}</p>}

        {dossier.turns.length > 0 && (
          <section className="dossier__block">
            <h3 className="dossier__kicker mono">Turns</h3>
            <ol className="dossier__turns">
              {dossier.turns.map((t, i) => (
                <li key={i} className={'dossier__turn' + (t.open ? ' is-open' : '')}>
                  <span className="dossier__turnstage mono">{stageLabel(t.stage)}</span>
                  <span className="dossier__turnai mono">{t.ai || 'model not named'}</span>
                  <span className="dossier__turnmeta mono">
                    {/* Real numbers only — a turn that reported none says nothing. */}
                    {t.tokensIn || t.tokensOut ? `${t.tokensIn}/${t.tokensOut}` : ''}
                    {t.ms ? ` · ${ms(t.ms)}` : ''}
                  </span>
                  {/* A stand-in is named as one. It is the difference between a
                      model answering and the app pretending it did. */}
                  {!t.real && <span className="dossier__standin">stand-in, not a real reply</span>}
                  {/* A cut-off reply from a reasoning model reads as gibberish —
                      it is the model's own monologue, returned because it never
                      reached the answer. Saying so is the difference between
                      "my agent is broken" and "it ran out of room". */}
                  {t.truncated && (
                    <span className="dossier__cut">cut off at the output cap — not a finished answer</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {dossier.tools.length > 0 && (
          <section className="dossier__block">
            <h3 className="dossier__kicker mono">What it touched</h3>
            <ul className="dossier__tools">
              {dossier.tools.map((t, i) => {
                const e = ENDINGS[t.ending]
                return (
                  <li key={i} className={`dossier__tool is-${e.tone}`}>
                    <span className="dossier__toolname mono">{t.name}</span>
                    {t.target && <span className="dossier__tooltarget mono">{t.target}</span>}
                    <span className="dossier__toolend">{e.text}</span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* An agent with turns but no tools read nothing — worth saying, since
            "what it touched" being absent could otherwise read as missing data. */}
        {dossier.tools.length === 0 && dossier.turns.length > 0 && (
          <p className="dossier__none">It read nothing on this run — it answered from the brief alone.</p>
        )}
      </div>
    </div>
  )
}
