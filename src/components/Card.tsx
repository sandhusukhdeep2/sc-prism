// Card — the ONE white panel.
//
// The board, the ledger, the automations list and the stats tiles had each
// grown their own version of the same object: white surface, 22px radius, one
// soft elevation, a small heading with optional controls opposite. Four
// implementations of one idea, drifting apart a pixel at a time — and three
// pages (Training among them) that had no card at all and simply put content
// on the page.
//
// TWO GROUNDS, and the difference matters:
//   · `card` — white, lifted. Content you read.
//   · `card--inset` — a recessed grey well things sit INSIDE, the treatment
//     the crew board uses so its white column stacks lift out of it. Recesses
//     darker on the light theme and lighter on the dark ones, because a darker
//     well on a dark page is not a well.
//
// The heading is optional on purpose: a card wrapping one self-titled thing
// should not grow a second title above it.
import type { ReactNode } from 'react'
import './Card.css'

export default function Card({
  title,
  hint,
  actions,
  inset = false,
  flush = false,
  className = '',
  children,
}: {
  /** The card's own heading. Omit when what is inside already names itself. */
  title?: ReactNode
  /** A quiet mono line beside the heading — the caveat, the count, the source. */
  hint?: ReactNode
  /** Controls opposite the heading. */
  actions?: ReactNode
  /** Recessed grey ground instead of a lifted white surface. */
  inset?: boolean
  /** No padding — for a card whose child owns its own edges (a table, a list). */
  flush?: boolean
  className?: string
  children: ReactNode
}) {
  const cls = [
    'card',
    inset ? 'card--inset' : '',
    flush ? 'card--flush' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={cls}>
      {(title || actions) && (
        <div className="card__head">
          {title && <h2 className="card__title">{title}</h2>}
          {hint && <span className="card__hint mono">{hint}</span>}
          <span className="card__spacer" />
          {actions && <div className="card__actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
