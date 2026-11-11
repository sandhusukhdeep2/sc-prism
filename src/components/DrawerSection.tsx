// One line of the project sidebar: a title, a summary of what is inside, and
// a chevron — open on demand (2026-11-11, "the sidebar is totally cluttered").
// Folded means NOT RENDERED: nothing of the body is in the page until it is
// asked for, so the sidebar reads as a short list of facts.
import { useEffect, useId, useState, type ReactNode } from 'react'
import './DrawerSection.css'

export default function DrawerSection({
  title,
  summary,
  warn = false,
  defaultOpen = false,
  children,
}: {
  title: string
  /** What is inside, in a few words — counts and states, never a label alone. */
  summary?: string
  /** The summary reports a problem (a seat sits out, nobody can be staffed). */
  warn?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // The default is a fact about the project (a plan folds once it is done), so
  // it follows the project; a click still wins until that fact changes.
  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])
  const bodyId = useId()
  return (
    <section className={'dsec' + (open ? ' is-open' : '')}>
      <button
        type="button"
        className="dsec__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dsec__title">{title}</span>
        {summary && <span className={'dsec__summary' + (warn ? ' is-warn' : '')}>{summary}</span>}
        <span className="dsec__chev" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className="dsec__body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  )
}
