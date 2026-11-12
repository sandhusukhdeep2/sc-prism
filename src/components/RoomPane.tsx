// RoomPane — what the work produces, beside the chat (2026-11-12).
//
// The owner wanted the Work room laid out like the coworker app he uses: the
// conversation on the left, and on the right a pane that opens for whatever
// there is to look at — here the run drawn to be watched, the engine's own
// steps, the project's files, its details. This is that pane's frame: tabs, a
// way to give the stage the whole window, a way to close. Which tab is on
// screen is decided by `lib/roomPane.ts`; the content comes from the room.
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { PaneTab } from '../lib/roomPane'
import './RoomPane.css'

const LABEL: Record<PaneTab, string> = {
  stage: 'Stage',
  steps: 'Steps',
  files: 'Files',
  details: 'Details',
}

export default function RoomPane({
  tab,
  tabs,
  onTab,
  onClose,
  children,
}: {
  /** The tab on screen. */
  tab: PaneTab
  /** The tabs this room can show right now. */
  tabs: readonly PaneTab[]
  onTab: (tab: PaneTab) => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <aside className="pane" aria-label="Beside the chat">
      <header className="pane__head">
        <div className="pane__tabs" role="tablist" aria-label="What to show beside the chat">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`pane-tab-${t}`}
              aria-selected={t === tab}
              aria-controls="pane-panel"
              className={'pane__tab' + (t === tab ? ' is-on' : '')}
              onClick={() => onTab(t)}
            >
              {LABEL[t]}
            </button>
          ))}
        </div>
        <span className="pane__spacer" />
        {tab === 'stage' && (
          <Link to="/live" className="pane__tool" aria-label="Open the stage on its own page" title="Open the stage on its own page">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M14 4.5h5.5V10M19.5 4.5l-6.2 6.2M10 19.5H4.5V14M4.5 19.5l6.2-6.2" />
            </svg>
          </Link>
        )}
        <button type="button" className="pane__tool" aria-label="Close the pane" title="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="pane__body" role="tabpanel" id="pane-panel" aria-labelledby={`pane-tab-${tab}`} key={tab}>
        {children}
      </div>
    </aside>
  )
}
