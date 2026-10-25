import { Link } from 'react-router-dom'
import { useApp } from '../store/AppStore'
import { primaryDisplayName, useSettings } from '../lib/settings'
import {
  PARKING_RULE,
  agoLabel,
  cadenceLabel,
  jobCanPark,
  jobKind,
  managerDisplayName,
  useManagerActions,
  useManagers,
  type Manager,
  type ManagerJob,
  type ManagersState,
} from '../lib/managers'
import './ApprovalGate.css'

// A hard governance stop. Until the 2026-08-09 honesty pass this page was bound
// to the loop SIMULATOR's `pendingApproval` — a gate on a fabricated plan step,
// which is now deleted along with the simulator. It is now bound to the app's
// REAL parked work: manager dispatch/team jobs set to "ask me first", which the
// driver parks (pendingSince) until the user decides. Nothing parked → the page
// says so and says where a park would come from.

/** Every job genuinely parked awaiting the user's OK — the real gate queue. */
export function parkedJobs(ms: ManagersState): { job: ManagerJob; manager?: Manager }[] {
  return ms.jobs
    .filter((j) => (j.pendingSince ?? 0) > 0)
    .map((job) => ({ job, manager: ms.managers.find((m) => m.id === job.managerId) }))
}

export default function ApprovalGate() {
  const { state } = useApp()
  const { settings } = useSettings()
  const ms = useManagers()
  const { approve, reject } = useManagerActions()
  const parked = parkedJobs(ms)
  // How many of the user's REAL jobs could ever park here — the difference
  // between "nothing is waiting" and "nothing can wait".
  const parkable = ms.jobs.filter(jobCanPark)
  const latest = state.verdicts[0]
  const companion = primaryDisplayName(settings)
  const now = Date.now()

  return (
    <div className="ag">
      <div className="ag__main">
        <div className="ag__tabs">
          <Link to="/" className="ag__tab">Chat</Link>
          <Link to="/editor" className="ag__tab">Editor</Link>
          <span className="ag__spacer" />
          {parked.length > 0 && (
            <span className="mono ag__task">
              {parked.length} waiting on you
            </span>
          )}
        </div>

        <div className="ag__body">
          {parked.length > 0 ? (
            <>
              <div className="ag__msg ag__msg--ai is-dim">
                <span className="ag__orb ag__orb--msg" />
                <div className="ag__bubble">
                  {companion} held {parked.length === 1 ? 'this job' : 'these jobs'} BEFORE running
                  {parked.length === 1 ? ' it' : ' them'} — you set them to ask first. Nothing has
                  run yet.
                </div>
              </div>

              {parked.map(({ job, manager }) => (
                <div className="gate" key={job.id}>
                  <div className="gate__head">
                    <svg className="gate__shield" width="17" height="17" viewBox="0 0 24 24">
                      <path d="M12 3l8 3v6c0 4.4-3.2 7.4-8 9-4.8-1.6-8-4.6-8-9V6z" />
                      <path d="M12 9v4M12 16.5v.5" />
                    </svg>
                    <span className="gate__title">Confirmation required</span>
                    <span className="mono gate__sub">enforced by the driver — not a suggestion</span>
                    <span className="ag__spacer" />
                    <span className="mono gate__hardstop">HARD STOP</span>
                  </div>
                  <div className="gate__inner">
                    <div className="gate__rule">{job.title}</div>

                    <div className="gate__facts">
                      <div className="gate__fact">
                        <span className="mono gate__factk">Kind</span>
                        <span className="gate__factv">
                          <span className="gate__kind mono gate__kind--write">{jobKind(job)}</span>{' '}
                          {jobKind(job) === 'team'
                            ? 'run — a roster of agents, so it is held for your OK'
                            : 'run — it produces a verified change, so it is held for your OK'}
                        </span>
                      </div>
                      <div className="gate__fact">
                        <span className="mono gate__factk">Owner</span>
                        <span className="gate__factv">
                          {manager ? managerDisplayName(manager, settings) : 'unknown manager'} ·{' '}
                          {job.department} · {cadenceLabel(job.everyMinutes)}
                        </span>
                      </div>
                      <div className="gate__fact">
                        <span className="mono gate__factk">Waiting</span>
                        <span className="gate__factv">
                          parked {agoLabel(job.pendingSince ?? 0, now)} ·{' '}
                          {job.runs[0]
                            ? `last run ${job.runs[0].ok ? 'succeeded' : 'failed'} ${agoLabel(job.lastRun, now)}`
                            : 'never run before'}
                        </span>
                      </div>
                    </div>

                    <div className="gate__actions">
                      <button
                        type="button"
                        className="gate__approve"
                        onClick={() => approve(job.id, Date.now())}
                      >
                        Approve — run it
                      </button>
                      <button
                        type="button"
                        className="gate__reject"
                        onClick={() => reject(job.id, Date.now())}
                      >
                        Reject — skip this turn
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            /* honest empty state — and where a park would come from */
            <div className="ag__empty">
              <div className="ag__emptyicon">✓</div>
              <div className="ag__emptytitle">No approvals waiting</div>
              {/* The empty state must describe the rule the DRIVER actually
                  follows (`jobCanPark`), not a friendlier one. It used to
                  promise that any job set to "ask me first" parks here — which
                  contradicts the config of anyone whose jobs are ALL report
                  jobs on "ask me first", leaving them to wait for a park that
                  can never arrive. */}
              <div className="ag__emptysub">
                {PARKING_RULE} Nothing that does park here ever proceeds on its own. Jobs and
                their approval mode are set up on the Agents page.
              </div>
              {ms.jobs.length > 0 && (
                <div className="ag__emptysub mono">
                  {parkable.length === 0
                    ? `all ${ms.jobs.length} of your jobs are report jobs — none of them can park here`
                    : `${parkable.length} of your ${ms.jobs.length} jobs can park here · none is waiting right now`}
                </div>
              )}
              <Link to="/agents" className="ag__emptycta">open Agents ›</Link>
            </div>
          )}
        </div>
      </div>

      {/* right column — real state */}
      <aside className="ag__side">
        <div className="agblock">
          <div className="agblock__head">
            <span className="agblock__kicker">Driver</span>
            <span className="mono agblock__status">
              <i className={'agblock__statusdot' + (parked.length ? '' : ' agblock__statusdot--idle')} />
              {parked.length ? 'blocked' : 'idle'}
            </span>
          </div>
          <div className="agblock__row">
            <div className="ag__orb ag__orb--lg">
              {parked.length > 0 && <span className="agblock__pause">‖</span>}
            </div>
            <div>
              <div className="agblock__role">deterministic job driver</div>
              <div className="mono agblock__state">
                {parked.length
                  ? `${parked.length} job${parked.length === 1 ? '' : 's'} held for your decision`
                  : 'nothing held'}
              </div>
              {parked[0] && <div className="mono agblock__task">{parked[0].job.title}</div>}
            </div>
          </div>
          <div className="agblock__note">
            The driver holds here until you decide. Nothing proceeds on its own.
          </div>
        </div>

        {latest && (
          <Link to="/verdict" className="agprev">
            <span className={'agprev__dot' + (latest.passed ? '' : ' agprev__dot--fail')} />
            <span className="mono agprev__label">
              latest task #{latest.taskId} · {latest.passed ? '✓ verified' : '✕ failed'}
            </span>
            <span className="ag__spacer" />
            <span className="agprev__chev">›</span>
          </Link>
        )}
      </aside>
    </div>
  )
}
