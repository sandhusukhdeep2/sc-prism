// RunLines — the work, in the chat (2026-11-14, "Visible agents").
//
// The mockup the owner called "perfect example what I want" writes a run into
// the chat as SEAT-ATTRIBUTED LINES — who · on which AI · what it did — and
// closes it with one outcome strip. Three small pieces draw that:
//
//   RunLines      a live run's lines, from spans (lib/runLines.ts);
//   TurnLines     what each seat contributed, from the saved board — each
//                 line opens the whole turn, exactly as written;
//   OutcomeStrip  how the run ended: the outcome, what each check said, what
//                 it cost, and the way to the full record.
//
// None of them derives anything. A line is here because `runLines`,
// `turnLine`, `verdictOutcome` or `teamOutcome` produced it.
import { Link } from 'react-router-dom'
import { renderChatMarkdown } from '../lib/chatMarkdown'
import { turnLine, type LineChip, type OutcomeView, type RunLine, type SeatTurn } from '../lib/runLines'
import { shortAi } from './CrewBoard'
import './RunLines.css'

/** How many of a live run's lines stay on screen; the rest fold above them. */
const SHOWN = 8

function Lock() {
  return (
    <svg className="rl__lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function Chip({ c }: { c: LineChip }) {
  return <span className={`rl__chip rl__chip--${c.kind}`}>{c.text}</span>
}

/** The three columns of one line — the same in a live run and a saved turn. */
function Cells({ line }: { line: RunLine }) {
  return (
    <>
      <span className="rl__who">{line.who}</span>
      <span className="rl__ai" title={line.ai || undefined}>
        {line.local && line.ai && <Lock />}
        {line.ai ? shortAi(line.ai, 24) : ''}
      </span>
      <span className="rl__text">
        {line.text}
        {line.chips.map((c) => (
          <Chip key={c.text} c={c} />
        ))}
      </span>
    </>
  )
}

function Row({ line }: { line: RunLine }) {
  return (
    <li className={'rl__line' + (line.tone === 'live' ? ' is-live' : '') + (line.tone === 'warn' ? ' is-warn' : '')}>
      <Cells line={line} />
    </li>
  )
}

export default function RunLines({ lines }: { lines: readonly RunLine[] }) {
  if (lines.length === 0) return null
  const earlier = lines.length > SHOWN ? lines.slice(0, lines.length - SHOWN) : []
  const shown = lines.slice(earlier.length)
  return (
    <section className="rl" aria-label="This run, as it happens">
      {earlier.length > 0 && (
        <details className="rl__earlier">
          <summary className="rl__earliersum">
            {earlier.length} earlier step{earlier.length === 1 ? '' : 's'}
          </summary>
          <ul className="rl__list">
            {earlier.map((l) => (
              <Row key={l.key} line={l} />
            ))}
          </ul>
        </details>
      )}
      <ul className="rl__list">
        {shown.map((l) => (
          <Row key={l.key} line={l} />
        ))}
      </ul>
    </section>
  )
}

/** How many saved turns stay on screen; earlier ones fold above them, so a
 *  run's working-out never buries its answer. */
const TURNS_SHOWN = 6

function Turn({ t }: { t: SeatTurn }) {
  return (
    <details className="rl__turn">
      <summary className="rl__line rl__line--open">
        <Cells line={turnLine(t)} />
      </summary>
      <div className="rl__turnbody msg__stream">{renderChatMarkdown(t.text)}</div>
    </details>
  )
}

export function TurnLines({ turns }: { turns: readonly SeatTurn[] }) {
  if (turns.length === 0) return null
  const earlier = turns.length > TURNS_SHOWN ? turns.slice(0, turns.length - TURNS_SHOWN) : []
  const shown = turns.slice(earlier.length)
  return (
    <section className="rl rl--turns" aria-label="What each seat contributed">
      {earlier.length > 0 && (
        <details className="rl__earlier">
          <summary className="rl__earliersum">
            {earlier.length} earlier turn{earlier.length === 1 ? '' : 's'}
          </summary>
          {earlier.map((t) => (
            <Turn key={t.id} t={t} />
          ))}
        </details>
      )}
      {shown.map((t) => (
        <Turn key={t.id} t={t} />
      ))}
    </section>
  )
}

export function OutcomeStrip({
  o,
  to,
  onReveal,
}: {
  o: OutcomeView
  /** The page holding this run's full record. */
  to?: string
  /** Reveal a file the result names (a team run's saved board). */
  onReveal?: (path: string) => void
}) {
  const file = o.path ? (o.path.split('/').pop() ?? o.path) : ''
  return (
    <div className={`outcome outcome--${o.tone}`} role="group" aria-label="How this run ended">
      <div className="outcome__row">
        <span className="outcome__head">{o.head}</span>
        {o.chips.map((c) => (
          <Chip key={c.text} c={c} />
        ))}
        <span className="outcome__cost mono">{o.cost}</span>
        {o.path && onReveal && (
          <button
            type="button"
            className="outcome__file mono"
            title={o.path}
            aria-label={`Reveal ${file}`}
            onClick={() => onReveal(o.path!)}
          >
            {file} ↗
          </button>
        )}
        {to && (
          <Link to={to} className="outcome__more" aria-label="Open the full record of this run">
            full record ›
          </Link>
        )}
      </div>
      {/* The engine's own sentence for WHY — only when it wrote one. */}
      {o.why && <div className="outcome__why">{o.why}</div>}
    </div>
  )
}
