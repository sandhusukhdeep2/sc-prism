// PageHead — the ONE page header.
//
// Before this, the identical rule
//
//     margin: 0; font-size: 32px; font-weight: 300;
//     letter-spacing: -0.025em; color: var(--ink); line-height: 1;
//
// was copy-pasted into six stylesheets (console, settings, vault, stats,
// training, verdict-detail), Automations had its own 21px variant, and the app
// carried twenty-nine different `__head` / `__title` class names. Nothing was
// broken and everything was slightly different, which is exactly what "the
// pages don't feel connected" means when you try to point at it.
//
// THE SHAPE, which every page already half-followed:
//   · a light title whose SECOND half is emphasised — "Improve routing",
//     "Automations · recurring work", "Provably done, at falling cost". The
//     weight change is the emphasis; there is no colour and no accent bar.
//   · an optional `hint`, in mono, sitting on the title's baseline: the one
//     sentence saying what this page is for.
//   · an optional `sub` line beneath, for the caveat that needs a full line.
//   · optional `actions`, pushed right.
//
// A page that needs more than this composes it below the head rather than
// growing the head, so the top of every page stays the same shape.
import type { ReactNode } from 'react'
import './PageHead.css'

export default function PageHead({
  title,
  em,
  hint,
  sub,
  actions,
}: {
  /** The light first half. */
  title: string
  /** The emphasised second half — the word the page is actually about. */
  em?: string
  /** One mono line on the title's baseline: what this page is for. */
  hint?: ReactNode
  /** A full line beneath, when the caveat will not sit on the baseline. */
  sub?: ReactNode
  /** Right-aligned controls. */
  actions?: ReactNode
}) {
  return (
    <header className="phead">
      <div className="phead__row">
        <h1 className="phead__title">
          {title}
          {em && <span className="phead__em"> {em}</span>}
        </h1>
        {hint && <span className="phead__hint mono">{hint}</span>}
        <span className="phead__spacer" />
        {actions && <div className="phead__actions">{actions}</div>}
      </div>
      {sub && <p className="phead__sub">{sub}</p>}
    </header>
  )
}
