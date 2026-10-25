import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../store/AppStore'
import { isNative } from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import { useInterview } from '../lib/interview'
import { useSchedules, useScheduleActions, scheduleKind, type Schedule } from '../lib/schedules'
import {
  COMPANION_MANAGER_ID,
  agoLabel,
  cadenceLabel,
  jobKind,
  lastRunLabel,
  managerDisplayName,
  nextDueLabel,
  useManagerActions,
  useManagers,
  type Manager,
  type ManagerJob,
  type ManagersState,
} from '../lib/managers'
import { activeRuns, elapsedLabel, kindLabel, shortIntent } from '../lib/liveRuns'
import './Automations.css'
import './Agents.css'
import Icon from '../components/Icon'

// AUTOMATIONS (was "Loop mission-control"). Rebuilt in the 2026-08-09 honesty
// pass — Finding 1, the user's #1 complaint ("I am not able to see anything on
// a automation page").
//
// What used to be here: a build-loop SIMULATOR. `runLoop` invented a 5-12 step
// plan from a seeded RNG over a canned pool ("scaffold repo", "router module")
// with no relation to what the user typed, and its state was deliberately never
// persisted — so the page was blank on every launch BY CONSTRUCTION. Both the
// generator and the loop state slice are deleted.
//
// What is here now: the user's REAL recurring work, and nothing else —
//   · manager jobs (title, manager, cadence, last run ✓/✕ and when, next due),
//   · the companion heartbeat, when one is enabled,
//   · standing loops (schedules), which the user creates and manages here,
//   · anything running RIGHT NOW, off `state.liveRuns` (the single live-run
//     source of truth; a row can only exist while its run is genuinely live).
// With none of it configured, the page says so AND says where it comes from.

// One row's worth of a live run — a real registration, never a projection.
function LiveRow({ intent, kind, startedAt, now }: { intent: string; kind: string; startedAt: number; now: number }) {
  return (
    <div className="auto__row">
      <span className="auto__pulse" />
      <span className="auto__rowtitle">{shortIntent(intent, 70)}</span>
      <span className="auto__kind mono">{kind}</span>
      <span className="auto__spacer" />
      <span className="auto__meta mono">running {elapsedLabel(startedAt, now)}</span>
    </div>
  )
}

/** A manager job row: real title, manager, cadence, last outcome, next due. */
function JobRow({
  job,
  manager,
  managerName,
  now,
}: {
  job: ManagerJob
  manager: Manager | undefined
  managerName: string
  now: number
}) {
  const last = job.runs[0]
  const parked = (job.pendingSince ?? 0) > 0
  const enabled = Boolean(manager?.enabled)
  // WHAT THIS JOB IS DOING, as one state rather than three clauses in a mono
  // run-on. The row used to end in "every 12h · never ran · manager off — will
  // not run", which is three different facts at one weight, right-aligned away
  // from the thing they describe. The words are unchanged — the tests and the
  // Work page's "Up next" rows depend on them — but each now sits where its
  // own kind of fact belongs.
  const state = parked
    ? // The gate itself, not the page that configures jobs.
      { text: 'awaiting your OK on the Approvals page', tone: 'wait' as const }
    : enabled
      ? { text: `next ${nextDueLabel(job, now)}`, tone: 'on' as const }
      : { text: 'manager off — will not run', tone: 'off' as const }
  return (
    <div className={'mgrs__job' + (parked ? ' mgrs__job--pending' : '')}>
      {/* The dot ALWAYS renders, because "off" is a state worth seeing at a
          glance and not only in the sentence at the far end of the row. A job
          that has never run is hollow rather than absent. */}
      <span
        className={
          'mgrs__dot' +
          (last ? (last.ok ? ' mgrs__dot--ok' : ' mgrs__dot--err') : '') +
          (state.tone === 'off' ? ' mgrs__dot--off' : '')
        }
      />
      <span className="mgrs__jobtitle">{job.title}</span>
      <span className="mgrs__dept mono">{managerName}</span>
      {jobKind(job) === 'dispatch' && <span className="mgrs__kind mono">work</span>}
      {jobKind(job) === 'team' && <span className="mgrs__kind mono">team</span>}
      <span className="mgrs__spacer" />
      {/* Same helpers the Work page's "Up next" rows use, so the two surfaces
          can never tell different stories about the same run record. */}
      <span className="mgrs__cadence mono">
        <Icon name="automations" size={13} />
        {cadenceLabel(job.everyMinutes)}
      </span>
      <span className="mgrs__last mono">{lastRunLabel(job, now) || 'never ran'}</span>
      <span className={`mgrs__state mgrs__state--${state.tone} mono`}>{state.text}</span>
    </div>
  )
}

/** Standing loops (schedules): create, enable/disable, remove — real records. */
function StandingLoops({ schedules, now }: { schedules: Schedule[]; now: number }) {
  const { add, update, remove } = useScheduleActions()
  const [task, setTask] = useState('')
  const [mins, setMins] = useState(60)

  if (!isNative()) return null

  return (
    <section className="auto__card">
      <div className="auto__cardhead">
        <span className="auto__kicker">Standing loops</span>
        <span className="auto__hint mono">
          a saved task re-run on a timer · fires while the app is open
        </span>
      </div>
      <div className="stand__form">
        <input
          className="stand__task mono"
          value={task}
          placeholder='a task to repeat — e.g. "summarize new vault notes since yesterday"'
          onChange={(e) => setTask(e.target.value)}
        />
        <label className="stand__every mono">
          every
          <input
            type="number"
            min={1}
            className="stand__mins"
            value={mins}
            onChange={(e) => setMins(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
          min
        </label>
        <button
          type="button"
          className="stand__add"
          disabled={!task.trim()}
          onClick={() => {
            add(task.trim(), mins, '')
            setTask('')
          }}
        >
          + Add loop
        </button>
      </div>
      {schedules.length === 0 ? (
        <div className="mgrs__empty mono">
          no standing loops yet — add one above and it runs on its timer while the app is open
        </div>
      ) : (
        <div className="stand__list">
          {schedules.map((s) => (
            <div key={s.id} className={'stand__row' + (s.enabled ? '' : ' stand__row--off')}>
              <span
                className={'stand__toggle' + (s.enabled ? ' stand__toggle--on' : '')}
                role="switch"
                aria-checked={s.enabled}
                aria-label={`Enable ${s.task}`}
                tabIndex={0}
                onClick={() => update(s.id, { enabled: !s.enabled })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    update(s.id, { enabled: !s.enabled })
                  }
                }}
              >
                <span className="stand__knob" />
              </span>
              <span className="stand__rowtask">{s.task}</span>
              <span className="stand__spacer" />
              <span className="stand__meta mono">
                {scheduleKind(s)} · {cadenceLabel(s.everyMinutes)} ·{' '}
                {s.runs[0] ? `last ${s.runs[0].ok ? '✓' : '✕'} ` : 'last '}
                {agoLabel(s.lastRun, now)} ·{' '}
                {s.enabled ? `next ${nextDueLabel(s, now)}` : 'paused'}
              </span>
              {s.runs[0] && (
                <span className={'stand__dot ' + (s.runs[0].ok ? 'stand__dot--ok' : 'stand__dot--err')} />
              )}
              <button
                type="button"
                className="stand__del"
                aria-label={`Remove ${s.task}`}
                onClick={() => remove(s.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Every job, grouped by its manager — read straight off the managers store. */
function jobsByManager(ms: ManagersState): { manager: Manager; jobs: ManagerJob[] }[] {
  return ms.managers
    .map((manager) => ({ manager, jobs: ms.jobs.filter((j) => j.managerId === manager.id) }))
    .filter((g) => g.jobs.length > 0)
}

export default function Automations() {
  const { state } = useApp()
  const { settings } = useSettings()
  const { interview } = useInterview()
  const ms = useManagers()
  const { ensure } = useManagerActions()
  const schedules = useSchedules()
  const live = activeRuns(state.liveRuns)
  const [now, setNow] = useState(() => Date.now())

  // Seeded exactly like the Agents page does (idempotent; no-op after the
  // first call) so opening Automations first does not show an empty page that
  // Agents would have filled.
  useEffect(() => {
    ensure(settings, interview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A 1s clock ONLY while something is live — it drives the elapsed timers on
  // live rows. Nothing ticks that fast when the app is idle.
  useEffect(() => {
    if (live.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live.length])

  // A slow clock ALWAYS. `now` also feeds "last ✓ 2m ago" and "next in 5m" on
  // the job and schedule rows — and nothing running is the NORMAL state of this
  // page, so gating every tick on `live` froze those labels at mount time and
  // let them quietly age into wrong numbers while the user watched them. 30s is
  // well under the one-minute resolution they print.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const groups = jobsByManager(ms)
  const jobCount = ms.jobs.length
  const heartbeats = ms.managers.filter((m) => m.heartbeat?.enabled)
  const nothing = jobCount === 0 && schedules.length === 0 && heartbeats.length === 0

  return (
    <div className="auto">
      <div className="auto__head">
        <h1 className="auto__title">
          Automations <b>· recurring work</b>
        </h1>
        <span className="auto__hint mono">
          every piece of work this app repeats on a timer — and anything running right now
        </span>
        {/* This page is only about work on a TIMER. The deleted /loop composer
            was where one-off multi-step work was started, and it was removed
            without a successor being pointed at, so that need had nowhere to
            go. It has a real home. */}
        <span className="auto__hint mono">
          for a one-off piece of multi-step work, use <Link to="/">Work</Link> or a{' '}
          <Link to="/projects">project</Link> — this page is only for things that repeat
        </span>
      </div>

      {/* RUNNING NOW — real registrations only (state.liveRuns). */}
      <section className="auto__card">
        <div className="auto__cardhead">
          <span className="auto__kicker">Running now</span>
          <span className="auto__hint mono">
            {live.length === 0
              ? 'nothing is running — this fills the moment a run starts'
              : `${live.length} run${live.length === 1 ? '' : 's'} in flight`}
          </span>
        </div>
        {live.map((r) => (
          <LiveRow key={r.id} intent={r.intent} kind={kindLabel(r.kind)} startedAt={r.startedAt} now={now} />
        ))}
      </section>

      {/* STANDING JOBS — real manager jobs. */}
      <section className="auto__card">
        <div className="auto__cardhead">
          <span className="auto__kicker">Standing jobs</span>
          <span className="auto__hint mono">
            manager jobs · created and edited on the Agents page · a job only runs while its
            manager is ON
          </span>
          <span className="auto__spacer" />
          <Link to="/agents" className="auto__link">
            Agents ›
          </Link>
        </div>
        {jobCount === 0 ? (
          <div className="mgrs__empty mono">
            no standing jobs — they are created on the Agents page, under a manager
          </div>
        ) : (
          groups.map(({ manager, jobs }) => {
            const name = managerDisplayName(manager, settings)
            return (
              <div key={manager.id} className="auto__group">
                <div className="auto__grouphead">
                  <span className="auto__groupname">{name}</span>
                  <span className="auto__meta mono">
                    {manager.enabled ? 'on' : 'off'} · {jobs.length} job
                    {jobs.length === 1 ? '' : 's'}
                  </span>
                </div>
                {jobs.map((j) => (
                  <JobRow key={j.id} job={j} manager={manager} managerName={name} now={now} />
                ))}
              </div>
            )
          })
        )}
        {heartbeats.map((m) => {
          const hb = m.heartbeat!
          const name = managerDisplayName(m, settings)
          const last = hb.beats[0]
          return (
            <div key={`hb-${m.id}`} className="mgrs__job">
              <span
                className={
                  'mgrs__dot ' + (last ? (last.ok ? 'mgrs__dot--ok' : 'mgrs__dot--err') : '')
                }
              />
              <span className="mgrs__jobtitle">{name} · heartbeat</span>
              <span className="mgrs__dept mono">
                {m.id === COMPANION_MANAGER_ID ? 'companion' : 'manager'}
              </span>
              <span className="mgrs__spacer" />
              <span className="mgrs__meta mono">
                {cadenceLabel(hb.everyMinutes)} ·{' '}
                {last ? `last ${last.ok ? '✓' : '✕'} ${agoLabel(hb.lastBeat, now)}` : 'never woken'}
              </span>
            </div>
          )
        })}
      </section>

      {/* STANDING LOOPS — real schedules. */}
      <StandingLoops schedules={schedules} now={now} />

      {nothing && (
        <div className="auto__empty">
          <div className="auto__emptytitle">Nothing is automated yet</div>
          <div className="auto__emptysub">
            This page only shows work that genuinely repeats, so it is empty because none is set
            up. Standing jobs are created on the <Link to="/agents">Agents</Link> page (add a job
            under a manager, then switch that manager ON); the companion heartbeat is enabled on
            the same page; standing loops are added right here.
          </div>
        </div>
      )}
    </div>
  )
}
