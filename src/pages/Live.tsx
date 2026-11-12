// THE LIVE PAGE (2026-11-12).
//
// The owner: "I need one page just showing the animation when it's working."
// This is the room pane's Stage tab given the whole window: the run that is
// executing now, drawn to be watched, with who is speaking and the task in
// the user's own words. When nothing is running it is the last team run as a
// still picture — and with nothing to show at all, it says so.
//
// No new data and no new claims: the same spans, selected by the same rules
// the Work room uses (`currentRunSpans` is [] whenever two runs are in flight,
// so a crew is never attributed to the wrong run; `lastFinishedRunSpans` is
// only drawn when it really was a crew).
import { Link } from 'react-router-dom'
import RunStage from '../components/RunStage'
import { useSpanTail } from '../lib/engineConsole'
import { activeRuns, crewSize, currentRunSpans, lastFinishedRunSpans } from '../lib/liveRuns'
import { agentsInRun } from '../lib/agentDossier'
import { useSettings } from '../lib/settings'
import { useApp } from '../store/AppStore'
import './Live.css'

export default function Live() {
  const { state } = useApp()
  const { settings } = useSettings()
  const executing = activeRuns(state.liveRuns)
  const anyLive = executing.length > 0
  const tail = useSpanTail(settings.vaultPath, anyLive)
  const liveSpans = currentRunSpans(tail.spans, executing)
  const finished = lastFinishedRunSpans(tail.spans)
  const spans = anyLive ? liveSpans : crewSize(finished) > 1 ? finished : []
  const drawn = agentsInRun(spans).length > 0
  // The one run this page can honestly name: with two in flight it names none.
  const run = executing.length === 1 ? executing[0] : null

  return (
    <div className="live">
      <header className="live__head">
        <Link to="/" className="live__back">
          Back to the room
        </Link>
        <span className="live__spacer" />
        {anyLive ? (
          <span className="live__state is-live">
            <i aria-hidden="true" />
            working now
          </span>
        ) : (
          drawn && <span className="live__state">the last team run · nothing is running now</span>
        )}
      </header>

      {run && drawn && <p className="live__task">{run.intent}</p>}

      {drawn ? (
        <RunStage spans={spans} live={anyLive} />
      ) : (
        <div className="live__empty">
          <p className="live__emptyhead">
            {anyLive ? 'A run is under way, with no crew to draw yet.' : 'Nothing is running.'}
          </p>
          <p>
            {executing.length > 1
              ? 'Two runs are in flight, so no seat can be attributed to either.'
              : 'When a team works, it is drawn here.'}
          </p>
        </div>
      )}
    </div>
  )
}
