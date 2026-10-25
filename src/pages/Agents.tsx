import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './Agents.css'
import {
  agentActivity,
  agentModelToken,
  agentSlug,
  agentsForProject,
  create as createAgent,
  persistAgentToVault,
  remove as removeAgent,
  removeAgentFromVault,
  persistCompanionCharter,
  syncCompanionFile,
  syncManagerFiles,
  syncVaultAgents,
  systemAgents,
  update as updateAgent,
  useAgents,
  defaultLibraryRoster,
  type AgentModel,
  type StoredAgent,
} from '../lib/agents'
import { splitRoster, filterRoster, rosterGate, sitOutLine, type SitOut } from '../lib/roster'
import RosterPicker from '../components/RosterPicker'
import AgentMonogram from '../components/AgentMonogram'
import { useConnectivity } from '../lib/connectivity'
import { primaryDisplayName, useSettings } from '../lib/settings'
import { revealPath, isNative, type TeamResult } from '../lib/nativeEngine'
import { useInterview } from '../lib/interview'
import { renderChatMarkdown } from '../lib/chatMarkdown'
import {
  COMPANION_MANAGER_ID,
  MAX_CHARTER,
  agoLabel,
  getManagers,
  updateHeartbeat as updateHeartbeatStore,
  beatsTodayTokens,
  heartbeatConsentCopy,
  nextDueLabel,
  defaultTeamRoster,
  jobKind,
  managerDisplayName,
  useManagerActions,
  useManagers,
  type Heartbeat,
} from '../lib/managers'
import {
  TEAM_BUSY_TEXT,
  TEAM_FAILED_TEXT,
  TEAM_TIMEOUT_TEXT,
  TEAM_TOKEN_BUDGET,
  useApp,
  useWakeNow,
} from '../store/AppStore'
import { useProjects, type Project } from '../lib/projects'
import { skillStats, type SkillStat } from '../lib/skillStats'
import { useSkills } from '../lib/skills'
import type { Verdict } from '../engine/types'

// Relative times shared by the manager job rows and the heartbeat beat log —
// the pure labels live in lib/managers so the Automations page renders the same
// recurring work in the same words.
const ago = (t: number) => agoLabel(t, Date.now())
const nextDue = (j: { lastRun: number; everyMinutes: number }) => nextDueLabel(j, Date.now())
// Heartbeat-only next-due label. An OVERDUE beat is honestly "waiting for a
// free engine slot", never "due now": the driver fires a due beat within one
// 30s tick when the engine is free, so a beat that stays overdue is queued
// behind a busy/user-parked engine (a project in 'awaiting' can hold the
// slot for days) — mirrors FloatingPulse's nextCheck.
const nextBeat = (hb: { lastBeat: number; everyMinutes: number }) => {
  const msLeft = hb.lastBeat + hb.everyMinutes * 60_000 - Date.now()
  if (msLeft <= 0) return 'waiting for a free engine slot'
  const m = Math.ceil(msLeft / 60_000)
  return m < 60
    ? `next check in ${m}m`
    : m < 60 * 24
      ? `next check in ${Math.round(m / 60)}h`
      : `next check in ${Math.round(m / (60 * 24))}d`
}

// Manager agents: standing per-AI maintenance managers under Sukh. Jobs run
// on schedule through the real engine (driver lives in AppStore); reports
// land in vault/reports/ and roll up into Sukh's context.
function ManagersPanel() {
  const { settings } = useSettings()
  const { health } = useConnectivity()
  const { interview } = useInterview()
  const ms = useManagers()
  const { ensure, setEnabled, addJob, removeJob, approve, reject } = useManagerActions()
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [dept, setDept] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mins, setMins] = useState(24 * 60)
  const [mgrId, setMgrId] = useState('')
  const [kind, setKind] = useState<'report' | 'dispatch' | 'team'>('report')
  const [approval, setApproval] = useState<'ask' | 'auto'>('ask')
  const [roster, setRoster] = useState('')
  const [tokenBudget, setTokenBudget] = useState(100000)
  // P9 (safety): removing a manager job is permanent, so arm-then-confirm — the
  // ✕ arms this id, an explicit "confirm" removes it, "cancel" (or arming a
  // different job) disarms.
  const [confirmJobId, setConfirmJobId] = useState<string | null>(null)

  useEffect(() => {
    ensure(settings, interview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!isNative()) return null
  const departments = [...new Set([...interview.departments, 'general'])]

  // The default roster this job would really get — built through the SAME
  // provider gate the dispatcher applies, so the placeholder can't promise a
  // seat the run would drop. Empty means nothing is connected, and it says so.
  const selectedManager = ms.managers.find((m) => m.id === mgrId)
  const jobGate = rosterGate(settings, { health })
  const rosterPlaceholder =
    (selectedManager ? defaultTeamRoster(selectedManager.providerId, jobGate) : '') ||
    'no connected provider — connect one in Settings'

  return (
    <div className="mgrs">
      <div className="mgrs__head">
        <span className="mgrs__kicker">Manager agents</span>
        <span className="mgrs__hint mono">
          per-AI maintenance managers under {primaryDisplayName(settings)} · reports →
          vault/reports/ · flip a manager ON to start its jobs
        </span>
        <span className="mgrs__spacer" />
        <button type="button" className="mgrs__addbtn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'close' : '+ Add job'}
        </button>
      </div>

      {showAdd && (
        <div className="mgrs__form">
          <label className="mgrs__field">
            <span className="mgrs__flabel">Manager</span>
            <select className="mgrs__input mono" value={mgrId} onChange={(e) => setMgrId(e.target.value)}>
              <option value="">choose manager…</option>
              {/* the companion takes no jobs (v1: heartbeat only) — a job on
                  its virtual 'primary' provider would never resolve */}
              {ms.managers.filter((m) => !m.heartbeat).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <label className="mgrs__field">
            <span className="mgrs__flabel">Job title</span>
            <input className="mgrs__input" value={title} placeholder="e.g. weekly compliance sweep" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="mgrs__field">
            <span className="mgrs__flabel">Department</span>
            <select className="mgrs__input mono" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">choose…</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="mgrs__field">
            <span className="mgrs__flabel">Job kind</span>
            <select className="mgrs__input mono" value={kind} onChange={(e) => setKind(e.target.value as 'report' | 'dispatch' | 'team')}>
              <option value="report">report (prose summary)</option>
              <option value="dispatch">dispatch work (verified task)</option>
              <option value="team">team run (governed multi-agent)</option>
            </select>
          </label>
          {kind !== 'report' && (
            <label className="mgrs__field">
              <span className="mgrs__flabel">Approval</span>
              <select className="mgrs__input mono" value={approval} onChange={(e) => setApproval(e.target.value as 'ask' | 'auto')}>
                <option value="ask">ask me first</option>
                <option value="auto">auto-run</option>
              </select>
            </label>
          )}
          <label className="mgrs__field mgrs__field--wide">
            <span className="mgrs__flabel">What it does each time</span>
            <input className="mgrs__input" value={prompt} placeholder="in plain words — e.g. summarise open compliance gaps and flag anything overdue" onChange={(e) => setPrompt(e.target.value)} />
          </label>
          {kind === 'team' && (
            <>
              <label className="mgrs__field mgrs__field--wide">
                <span className="mgrs__flabel">Team roster</span>
                <input className="mgrs__input mono" value={roster} placeholder={rosterPlaceholder} onChange={(e) => setRoster(e.target.value)} />
              </label>
              <label className="mgrs__field">
                <span className="mgrs__flabel">Token budget</span>
                <input
                  className="mgrs__input"
                  type="number"
                  min={1000}
                  value={tokenBudget}
                  onChange={(e) => setTokenBudget(Math.max(1000, parseInt(e.target.value, 10) || 100000))}
                />
              </label>
            </>
          )}
          <label className="mgrs__field">
            <span className="mgrs__flabel">Run every (min)</span>
            <input
              className="mgrs__input"
              type="number"
              min={5}
              value={mins}
              onChange={(e) => setMins(Math.max(5, parseInt(e.target.value, 10) || 60))}
            />
          </label>
          <div className="mgrs__formactions">
            <button
              type="button"
              className="mgrs__save"
              disabled={!mgrId || !title.trim() || !prompt.trim()}
              onClick={() => {
                addJob(mgrId, title, dept || 'general', prompt, mins, kind, approval, kind === 'team' ? roster : '', kind === 'team' ? tokenBudget : 0)
                setTitle(''); setPrompt(''); setKind('report'); setApproval('ask'); setRoster(''); setTokenBudget(100000); setShowAdd(false)
              }}
            >
              Save job
            </button>
          </div>
        </div>
      )}

      <div className="mgrs__grid">
        {ms.managers.map((m) => {
          const jobs = ms.jobs.filter((j) => j.managerId === m.id)
          if (m.heartbeat) {
            // The companion card (2026-07-29 spec): no per-AI jobs — its
            // standing work is the heartbeat, behind the section's own
            // explicit consent toggle. The name comes from settings at
            // render time, never from the store.
            const name = managerDisplayName(m, settings)
            const today = beatsTodayTokens(m.heartbeat, Date.now())
            return (
              <div key={m.id} className={'mgrs__card' + (m.heartbeat.enabled ? '' : ' mgrs__card--off')}>
                <div className="mgrs__row">
                  <span className="mgrs__name">{name}</span>
                  <span className="mgrs__spacer" />
                  <span className="mgrs__count mono">
                    today: {today.count} beat{today.count === 1 ? '' : 's'} · {today.tokens.toLocaleString()} tokens
                  </span>
                </div>
                <HeartbeatSection managerId={m.id} name={name} hb={m.heartbeat} />
              </div>
            )
          }
          return (
            <div key={m.id} className={'mgrs__card' + (m.enabled ? '' : ' mgrs__card--off')}>
              <div className="mgrs__row">
                <span
                  className={'stand__toggle' + (m.enabled ? ' stand__toggle--on' : '')}
                  role="switch"
                  aria-checked={m.enabled}
                  aria-label={`Enable ${m.name}`}
                  tabIndex={0}
                  onClick={() => setEnabled(m.id, !m.enabled)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setEnabled(m.id, !m.enabled)
                    }
                  }}
                >
                  <span className="stand__knob" />
                </span>
                <span className="mgrs__name">{m.name}</span>
                <span className="mgrs__spacer" />
                <span className="mgrs__count mono">{jobs.length} job{jobs.length === 1 ? '' : 's'}</span>
              </div>
              {jobs.map((j) => {
                const parked = (j.pendingSince ?? 0) > 0
                return (
                  <div key={j.id} className={'mgrs__job' + (parked ? ' mgrs__job--pending' : '')}>
                    {j.runs[0] && (
                      <span className={'mgrs__dot ' + (j.runs[0].ok ? 'mgrs__dot--ok' : 'mgrs__dot--err')} />
                    )}
                    <span className="mgrs__jobtitle">{j.title}</span>
                    <span className="mgrs__dept mono">{j.department}</span>
                    {jobKind(j) === 'dispatch' && <span className="mgrs__kind mono">work</span>}
                    {jobKind(j) === 'team' && <span className="mgrs__kind mono">team</span>}
                    <span className="mgrs__spacer" />
                    {parked ? (
                      <span className="mgrs__pending mono">
                        awaiting your OK
                        <button type="button" className="mgrs__ok" onClick={() => approve(j.id, Date.now())}>Approve</button>
                        <button type="button" className="mgrs__no" onClick={() => reject(j.id, Date.now())}>Reject</button>
                      </span>
                    ) : (
                      <span className="mgrs__meta mono">
                        {j.runs[0] ? `ran ${ago(j.lastRun)}` : 'never ran'} · {m.enabled ? nextDue(j) : 'off'}
                      </span>
                    )}
                    {confirmJobId === j.id ? (
                      <span className="mgrs__delconfirm mono">
                        <span className="mgrs__delq">Delete “{j.title}”?</span>
                        <button
                          type="button"
                          className="mgrs__delyes"
                          aria-label={`Confirm delete ${j.title}`}
                          onClick={() => {
                            removeJob(j.id)
                            setConfirmJobId(null)
                          }}
                        >
                          confirm
                        </button>
                        <button
                          type="button"
                          className="mgrs__delno"
                          aria-label={`Cancel deleting ${j.title}`}
                          onClick={() => setConfirmJobId(null)}
                        >
                          cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="mgrs__del"
                        aria-label={`Delete ${j.title}`}
                        onClick={() => setConfirmJobId(j.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })}
              {jobs.length === 0 && <div className="mgrs__empty mono">no jobs — add one above</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Heartbeat controls on the companion card. Reworked 2026-08-05 (§Part 3 —
// "always-on manager"): the heartbeat is ON by default once setup completes,
// so the card no longer opens with a big switch inviting the user to keep
// flipping it. It STATES what is true — "On · resting · next check in 12m", or
// the live wake line while one is actually running — and keeps the off switch
// as a quiet text button. Wake-now, the charter (saved on blur), the cadence
// select and the beat log (every row a REAL Beat record, glyphed ✓ worked /
// · rested) are unchanged in substance.
function HeartbeatSection({ managerId, name, hb }: { managerId: string; name: string; hb: Heartbeat }) {
  const { updateHeartbeat } = useManagerActions()
  const { settings } = useSettings()
  const { state } = useApp()
  // The SAME binding the orb's Wake-now uses — one gate, two surfaces.
  const wake = useWakeNow()
  const [charter, setCharter] = useState(hb.charter)
  // Cadence in HOURS (2026-08-15 spec §2). The short options stay for anyone
  // who really wants them, but the list now reaches out to a day: a vault that
  // changes a few times a day gives a 15-minute wake nothing new to act on — it
  // re-reads unchanged state and bills for the reading. 2h is the new default
  // (managers.DEFAULT_CADENCE_MIN); an existing install keeps its own value.
  const cadences = [15, 30, 60, 120, 180, 240, 480, 720, 1440]
  // The state line is the real state and nothing else: a live wake says so
  // (that line comes from the driver, around the real run), else resting +
  // the real next-due, else honestly off.
  const stateLine = !hb.enabled
    ? `Off — ${name} will not wake on its own`
    : state.heartbeatLive
      ? `On · ${state.heartbeatLive}`
      : `On · resting · ${nextBeat(hb)}`
  return (
    <div className="hb">
      <div className="hb__row">
        <span className={'hb__state' + (hb.enabled ? ' hb__state--on' : '')}>{stateLine}</span>
        <span className="mgrs__spacer" />
        {/* One immediate REAL beat — same governed path, same 20k budget, same
            beat record as a scheduled wake. Disabled with the honest reason
            (rendered below) rather than silently doing nothing. */}
        <button
          type="button"
          className="hb__wake"
          disabled={wake.disabled}
          title={wake.reason ?? 'run one governed check now'}
          onClick={() => void wake.fire()}
        >
          {wake.busy ? 'waking…' : 'Wake now'}
        </button>
        <select
          className="mgrs__input mono hb__cadence"
          value={hb.everyMinutes}
          aria-label="Heartbeat cadence"
          onChange={(e) => updateHeartbeat(managerId, { everyMinutes: parseInt(e.target.value, 10) })}
        >
          {/* defensive: keep a stored off-list cadence selectable as-is */}
          {!cadences.includes(hb.everyMinutes) && (
            <option value={hb.everyMinutes}>every {hb.everyMinutes}m</option>
          )}
          <option value={15}>every 15m</option>
          <option value={30}>every 30m</option>
          <option value={60}>every 1h</option>
          <option value={120}>every 2h</option>
          <option value={180}>every 3h</option>
          <option value={240}>every 4h</option>
          <option value={480}>every 8h</option>
          <option value={720}>every 12h</option>
          <option value={1440}>every 24h</option>
        </select>
        {/* The quiet off switch. It stays one click away — always-on is a
            default, never a lock-in — but it is not the loudest thing here. */}
        <button
          type="button"
          className="hb__off"
          aria-label={`${hb.enabled ? 'Turn off' : 'Turn on'} the heartbeat for ${name}`}
          onClick={() => updateHeartbeat(managerId, { enabled: !hb.enabled })}
        >
          {hb.enabled ? 'turn off' : 'turn on'}
        </button>
      </div>
      {wake.reason && !wake.busy && (
        <div className="hb__why mono">can’t wake now — {wake.reason}</div>
      )}
      {/* What he actually does + what it costs. Shown as a standing fact while
          on; as the grant it is while off. Same shared copy the setup-completion
          consent notice shows, so the two can never drift. */}
      <div className="hb__consent mono">
        {hb.enabled
          ? heartbeatConsentCopy(name, hb.everyMinutes)
          : `Turning this on: ${heartbeatConsentCopy(name, hb.everyMinutes)} First check one cadence after you switch it on.`}
      </div>
      <label className="mgrs__field mgrs__field--wide">
        <span className="mgrs__flabel">Charter — what to watch and prepare</span>
        <textarea
          className="mgrs__input hb__charter"
          value={charter}
          rows={3}
          maxLength={MAX_CHARTER}
          onChange={(e) => setCharter(e.target.value)}
          onBlur={() => {
            if (charter !== hb.charter) {
              updateHeartbeat(managerId, { charter })
              // Slice D write-through: an in-app charter edit rewrites
              // agents/companion.md so the file and the store never drift.
              if (managerId === COMPANION_MANAGER_ID) {
                const primaryId = settings.providers.find((pr) => pr.primary)?.id ?? ''
                const brand = primaryId.startsWith('claude')
                  ? ('claude' as const)
                  : primaryId.startsWith('gemini')
                    ? ('gemini' as const)
                    : ('local' as const)
                void persistCompanionCharter(charter, brand, settings.vaultPath).catch(() => {})
              }
            }
          }}
        />
      </label>
      {hb.beats.slice(0, 8).map((b) => (
        <div key={b.at} className="hb__beat">
          <span
            className={
              'hb__glyph' +
              (b.action === 'worked' ? ' hb__glyph--worked' : '') +
              (b.ok ? '' : ' hb__glyph--err')
            }
          >
            {b.action === 'worked' ? '✓' : '·'}
          </span>
          <span className="hb__beatline">{b.line}</span>
          <span className="hb__when mono">{ago(b.at)}</span>
        </div>
      ))}
      {hb.beats.length === 0 && <div className="mgrs__empty mono">no beats yet</div>}
    </div>
  )
}

// Launch a REAL multi-agent team: each agent on its own provider, A2A via the
// orchestrator-relayed board (engine `team`). Results render below the form.
function TeamLauncher() {
  const { settings } = useSettings()
  // Mission Control (2026-08-05): a team launched here is a REAL run the app
  // started, so it registers in the ONE live-run store — that is what makes it
  // visible (and glowing) on the Work page instead of only as an amber line
  // here.
  //
  // 2026-08-06 (§Give a task from Work): the launch itself no longer lives in
  // this component. The Work composer can start a team too, and two copies of
  // "mint a run id, claim the engine slot, register a live run, race a
  // cancelable timeout, always release + end" would drift. `launchTeam` in the
  // store IS that discipline; this page only asks for it and renders the board.
  const { launchTeam } = useApp()
  const { health } = useConnectivity()
  const [intent, setIntent] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TeamResult | null>(null)
  const [error, setError] = useState('')
  const [sitOut, setSitOut] = useState<SitOut[]>([])
  const [tokenBudget, setTokenBudget] = useState(TEAM_TOKEN_BUDGET)

  // The LIBRARY, so the crew is picked from the agents he actually created
  // rather than typed from memory into a text box…
  const library = useAgents()
  const seatGate = useMemo(() => rosterGate(settings, { health }), [settings, health])

  // …and the preset comes from that SAME library — the first three seats that
  // can genuinely play. It used to be the Work composer's provider-generic
  // preset (lead:claude-cli,…), which this panel's own picker then flagged as
  // unknown names: the app arguing with its own default. The composer keeps
  // its provider preset (it launches role-play seats, not library agents);
  // the two surfaces speak different vocabularies on purpose now.
  const [agents, setAgents] = useState(() => defaultLibraryRoster(library, seatGate))

  // Who would sit out if you launched RIGHT NOW — shown before the click, not
  // discovered afterwards. Same gate the launch itself applies, so the warning
  // and the run can never disagree. A pure read of settings + already-cached
  // health: rendering this triggers no probe.
  const preflight = useMemo(
    () => filterRoster(agents, rosterGate(settings, { health }), settings),
    [agents, settings, health],
  )

  const launch = async () => {
    const task = intent.trim()
    if (!task || running) return
    setRunning(true)
    setError('')
    setSitOut([])
    setResult(null)
    try {
      const outcome = await launchTeam({ task, roster: agents, tokenBudget })
      // Busy = the app's one engine slot is held: nothing started, nothing
      // registered. Refuse in the shared words — never queue silently.
      if (outcome.status === 'busy') setError(TEAM_BUSY_TEXT)
      else if (outcome.status === 'ok') {
        setResult(outcome.result)
        setSitOut(outcome.sitOut)
      } else if (outcome.status === 'timeout')
        // The launcher says what the board got done before the wall too — the
        // same salvage line the Work chat shows, from the same spans.
        setError(
          outcome.salvage ? `${TEAM_TIMEOUT_TEXT}\n\n${outcome.salvage}` : TEAM_TIMEOUT_TEXT,
        )
      // Refused: not one seat had a connected provider, so nothing ran. Its own
      // words, never the generic failure line — the fix is in Settings.
      else if (outcome.status === 'refused') {
        setError(outcome.reason)
        setSitOut(outcome.sitOut)
      } else setError(TEAM_FAILED_TEXT)
    } finally {
      setRunning(false)
    }
  }

  if (!isNative()) return null
  return (
    <div className="team">
      <div className="team__head">
        <span className="team__kicker">Launch a team</span>
        <span className="team__hint mono">
          agents run on DIFFERENT models · they talk via the Orchestrator&rsquo;s board · the
          board is saved to your vault
        </span>
      </div>
      <div className="team__form">
        <input
          className="team__intent mono"
          value={intent}
          placeholder='task for the team — e.g. "plan our SOC 2 compliance dashboard MVP"'
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void launch()
          }}
        />
        <input
          className="team__agents mono"
          value={agents}
          aria-label="Team roster (name:provider, comma separated)"
          /* Empty means nothing is connected — the default preset only ever
             offers providers that can really answer. Say that here rather than
             leave a blank box that looks like a field waiting to be filled. */
          placeholder="no connected provider — connect one in Settings"
          onChange={(e) => setAgents(e.target.value)}
        />
        <input
          className="team__budget mono"
          type="number"
          min={1000}
          value={tokenBudget}
          aria-label="Token budget"
          onChange={(e) => setTokenBudget(Math.max(1000, parseInt(e.target.value, 10) || 100000))}
        />
        <button type="button" className="team__launch" disabled={running || !intent.trim()} onClick={() => void launch()}>
          {running ? 'Team running…' : 'Launch team'}
        </button>
      </div>
      {/* Pick the crew from the library. This edits the same roster string the
          text box above holds, so the box remains a working escape hatch for a
          name that isn't an agent yet — and the picker names anyone typed there
          who matches nothing. */}
      <RosterPicker agents={library} gate={seatGate} value={agents} onChange={setAgents} />

      {/* Who can't play, and why — BEFORE the launch. An agent whose provider
          isn't connected used to keep its seat and answer with an offline stub;
          it now sits out, and this is where that is said out loud. */}
      {!running && !result && preflight.reassigned.length > 0 && (
        <div className="team__sitout mono">
          {preflight.reassigned.map((r) => (
            <div key={`${r.role}:${r.from}`}>
              {r.role} reassigned {r.from} → {r.to} ({r.reason})
            </div>
          ))}
        </div>
      )}
      {!running && !result && preflight.sitOut.length > 0 && (
        <div className="team__sitout mono">
          {preflight.sitOut.map((s) => (
            <div key={`${s.role}:${s.token}`}>
              {s.role} sits out: {s.reason}
            </div>
          ))}
        </div>
      )}
      {running && (
        <div className="team__status mono">
          {/* Audit fix (2026-08-30): while a team runs, NAME the crew — the
              same resolved roster the launch used, never a generic line. */}
          {preflight.roster ? (
            <>
              on it now:{' '}
              {splitRoster(preflight.roster)
                .map((p) => `${p.role} · ${p.token}`)
                .join('  ·  ')}{' '}
              — each speaks on its own model, one after another…
            </>
          ) : (
            'agents are working — each speaks on its own model, one after another…'
          )}
        </div>
      )}
      {error && <div className="team__error mono">{error}</div>}
      {result && (
        <div className="team__board">
          {/* The record of who was NOT at the table for THIS run, next to the
              board it shaped — a smaller team is never a silent one. */}
          {sitOut.length > 0 && <div className="team__sitout mono">{sitOutLine(sitOut)}</div>}
          <div className={'team__verdict' + (result.passed ? ' team__verdict--passed' : ' team__verdict--failed')}>
            <span className={'team__verdict-badge' + (result.passed ? ' team__verdict-badge--passed' : ' team__verdict-badge--failed')}>
              {result.passed ? '✓ PASSED' : '✕ FAILED'}
            </span>
            <span className="team__verdict-tokens mono">
              {result.tokens.toLocaleString()} / {result.tokenBudget.toLocaleString()} tok
            </span>
            {result.overBudget && <span className="team__verdict-over-budget mono">over budget</span>}
            {!result.passed && result.reason && (
              <span className="team__verdict-reason mono">{result.reason}</span>
            )}
          </div>
          {result.board.map((m, i) => (
            <div key={i} className="team__msg">
              <div className="team__msghead mono">
                <span className="team__sender">{m.from}</span>
                <span className="team__provider">{m.provider}</span>
                <span className={'team__real' + (m.is_real ? '' : ' team__real--stub')}>
                  {m.is_real ? 'REAL' : 'stub (provider not connected)'}
                </span>
              </div>
              <div className="team__msgbody">{renderChatMarkdown(m.content)}</div>
            </div>
          ))}
          <div className="team__synth">
            <div className="team__msghead mono">
              <span className="team__sender">lead synthesis</span>
              <span className="team__provider">{result.tokens.toLocaleString()} tok total</span>
            </div>
            <div className="team__msgbody">{renderChatMarkdown(result.synthesis)}</div>
          </div>
          {/* Audit fix (2026-08-30): a file the UI names must be reachable
              from where it is named — these were dead mono text. */}
          <button type="button" className="team__path team__path--btn mono" title="reveal in Finder"
            onClick={() => void revealPath(result.board_path)}>
            board saved: {result.board_path} ›
          </button>
          {result.verdictPath && (
            <button type="button" className="team__path team__path--btn mono" title="reveal in Finder"
              onClick={() => void revealPath(result.verdictPath)}>
              verdict saved: {result.verdictPath} ›
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Agent library — system agents (built-in, not deletable) + your business agents.
// Each agent is a spectral orb + role, a model badge, skill chips, usage/eval, and
// an enable toggle. All state is live from the localStorage-backed agents store.

type BadgeKind = AgentModel

const MODEL_TEXT: Record<AgentModel, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  local: 'local',
}

type RoleFilter = 'all' | 'system' | 'business'
type ModelFilter = 'all' | AgentModel

export default function Agents() {
  const navigate = useNavigate()
  const agents = useAgents()
  const { projects } = useProjects()
  const { state } = useApp()
  const { settings } = useSettings()
  const { health } = useConnectivity()
  const { interview } = useInterview()
  const { ensure } = useManagerActions()
  const skills = useSkills()
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [modelFilter, setModelFilter] = useState<ModelFilter>('all')
  const [adding, setAdding] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  // Which section the page shows; the crew is the default and the page.
  const [tab, setTab] = useState<'crew' | 'team' | 'managers'>('crew')

  // Agent-standard slice A: agents are portable `agents/*.md` files. On page
  // load, sync the vault's folder into the library — hand-authored files join,
  // edited files win for the definition, deleted files delete their agents,
  // and the first native load migrates the whole library to seed files
  // (mirrors the Skills page's `syncVaultSkills` mount effect).
  useEffect(() => {
    // Managers must exist BEFORE the sync below reads them. Seeding lived in
    // ManagersPanel's own mount — fine while the panel rendered on every
    // visit, a regression the moment tabs hid it (2026-08-29): the companion
    // and manager files silently stopped syncing. The page seeds now; the
    // panel's own ensure stays as a harmless idempotent second call.
    ensure(settings, interview)
    // Best-effort by design: a failed vault listing must neither throw nor
    // surface — the store simply stays the source until the next sync. The
    // catch also keeps a half-stubbed test environment from leaking an
    // unhandled rejection out of this fire-and-forget effect.
    void syncVaultAgents(settings.vaultPath).catch(() => {})
    // Slice D: the Companion's own definition file rides the same mount sync —
    // migration writes agents/companion.md on the first native visit; a file
    // the user edited wins, its body adopted as the heartbeat charter. The
    // file's `model:` is a brand preference only, taken from the primary.
    const ms = getManagers()
    // Managers become definition files too (one-way export, header says so).
    void syncManagerFiles(ms.managers, ms.jobs, settings.vaultPath).catch(() => {})
    const companion = ms.managers.find((m) => m.id === COMPANION_MANAGER_ID)
    const hb = companion?.heartbeat
    if (hb) {
      const primaryId = settings.providers.find((pr) => pr.primary)?.id ?? ''
      const brand = primaryId.startsWith('claude')
        ? ('claude' as const)
        : primaryId.startsWith('gemini')
          ? ('gemini' as const)
          : ('local' as const)
      void syncCompanionFile(hb.charter, brand, settings.vaultPath)
        .then((out) => {
          if (out && !out.wrote && out.charter !== hb.charter)
            updateHeartbeatStore(COMPANION_MANAGER_ID, { charter: out.charter })
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () => (a: StoredAgent): boolean => {
      const hitQuery =
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q) ||
        a.skills.some((s) => s.toLowerCase().includes(q))
      const hitModel = modelFilter === 'all' || a.model === modelFilter
      return hitQuery && hitModel
    },
    [q, modelFilter],
  )

  const matched = agents.filter(matches)

  // System section: real built-ins PLUS any business agent the user has
  // explicitly pinned system-wide — `systemAgents` groups purely by
  // assignment (`assignedTo === 'system'`), not the `system` flag, so both
  // land here; AgentTile itself still keeps real built-ins read-only.
  const systemGroup = systemAgents(matched)

  // Per-project sections: this project's ACTIVE team (`agentsForProject` —
  // the same enabled-only helper Task B's project panel/build driver read)
  // plus any of this project's agents the user has disabled. Disabled ones
  // stay visible (dimmed, toggleable) so turning an agent off never makes it
  // vanish from the page with no way back on.
  const projectGroups = projects
    .map((p) => {
      const team = agentsForProject(matched, p.id)
      const disabledAssigned = matched.filter(
        (a) => !a.enabled && (a.assignedTo ?? '') === p.id,
      )
      return { project: p, cards: [...team, ...disabledAssigned] }
    })
    .filter((g) => g.cards.length > 0)

  // Library: whatever's left — unassigned business agents, and (defensively)
  // any agent whose assignedTo points at a project that no longer exists.
  // Nothing ever falls off the page.
  const shownIds = new Set(
    [...systemGroup, ...projectGroups.flatMap((g) => g.cards)].map((a) => a.id),
  )
  const libraryGroup = matched.filter((a) => !a.system && !shownIds.has(a.id))

  const showSystem = roleFilter !== 'business'
  const showRest = roleFilter !== 'system'
  const nothing =
    !adding &&
    (!showSystem || systemGroup.length === 0) &&
    (!showRest || (projectGroups.length === 0 && libraryGroup.length === 0))

  // Real per-agent activity (agentActivity — honest, computed from verdicts,
  // never the fake seeded usage/evalScore) needs the verdict log; the
  // optional per-skill helping-signal chip needs skillStats. Both derived
  // once here (keyed by skill NAME, since a StoredAgent's `skills` are plain
  // name strings, not skill ids) and threaded down to every card. The
  // helping-signal projection runs over the session verdict log — the only
  // real verdict stream left after the loop simulator was deleted;
  // agentActivity below uses the same `verdicts` prop.
  const skillVerdicts = state.verdicts
  const skillStatsById = useMemo(() => skillStats(skillVerdicts, skills), [skillVerdicts, skills])
  const skillStatsByName = useMemo(() => {
    const m = new Map<string, SkillStat>()
    for (const s of skills) {
      const stat = skillStatsById.get(s.id)
      if (stat) m.set(s.name.toLowerCase(), stat)
    }
    return m
  }, [skills, skillStatsById])

  // Toggle and reassign touch only the app-side index state (enabled /
  // assignedTo) — the definition FILE doesn't carry either, so neither edit
  // writes it. Every mutation that changes what the file says goes through
  // `persistAgentToVault`; delete removes the agent's REAL file (its
  // sourcePath when discovered, never the canonical guess). All vault calls
  // are fire-and-forget and native-gated inside — browser no-ops that never
  // block the already-committed local mutation (the Skills page's pattern).
  const toggle = (a: StoredAgent) => updateAgent(a.id, { enabled: !a.enabled })
  const del = (a: StoredAgent) => {
    setMenuId(null)
    removeAgent(a.id)
    // Mirror remove()'s own guard: a system agent's row was NOT removed just
    // now, so its file must not vanish either.
    if (!a.system) void removeAgentFromVault(a, settings.vaultPath)
  }
  const reassign = (a: StoredAgent, assignedTo: string) => updateAgent(a.id, { assignedTo })

  // Why an agent's model can't run right now ('' when it can) — the SAME gate
  // the team launch and the project build apply, so a card can never say an
  // agent is ready for work a launch would drop it from. Cached health only:
  // no probe is triggered by rendering the page.
  const seatGate = useMemo(() => rosterGate(settings, { health }), [settings, health])

  const renderTile = (a: StoredAgent) => (
    <AgentTile
      key={a.id}
      a={a}
      projects={projects}
      verdicts={state.verdicts}
      sitsOut={seatGate(a.model)}
      skillStats={skillStatsByName}
      menuOpen={menuId === a.id}
      onToggle={() => toggle(a)}
      onMenu={() => setMenuId((cur) => (cur === a.id ? null : a.id))}
      onDelete={() => del(a)}
      onReassign={(assignedTo) => reassign(a, assignedTo)}
      onOpen={() => navigate(`/agents/${agentSlug(a.name)}`)}
    />
  )

  return (
    <div className="agents" onClick={() => setMenuId(null)}>
      {/* THE CREW LEADS (Sukhdeep, dogfooding day one, 2026-08-29): the team
          launcher and manager panel used to render first and the agent cards
          were buried at the bottom of the page. One section at a time now —
          Crew is the page; Team and Managers wait behind their own tabs. */}
      <div className="agents__tabs" role="tablist" aria-label="Agents sections">
        {(
          [
            ['crew', 'Crew'],
            ['team', 'Team'],
            ['managers', 'Managers'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={'agents__tab' + (tab === id ? ' agents__tab--on' : '')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'team' && <TeamLauncher />}
      {tab === 'managers' && <ManagersPanel />}

      {tab === 'crew' && (
        <>
      {/* page toolbar */}
      <div className="agents__toolbar">
        <span className="agents__search">
          <svg width="12" height="12" viewBox="0 0 24 24" className="agents__search-ico">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            className="agents__searchinput"
            placeholder="Search agents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <span className="agents__spacer" />
        <select
          className="agents__filter"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          aria-label="Filter by role"
        >
          <option value="all">role: all</option>
          <option value="system">system</option>
          <option value="business">business</option>
        </select>
        <select
          className="agents__filter"
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value as ModelFilter)}
          aria-label="Filter by model"
        >
          <option value="all">model: all</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
          <option value="local">local</option>
        </select>
        <button
          type="button"
          className="agents__new"
          onClick={() => setAdding(true)}
        >
          + New agent
        </button>
      </div>

      <div className="agents__scroll">
        {showSystem && systemGroup.length > 0 && (
          <>
            <SectionHead title="System agents" note="built-in · system-wide" />
            <div className="agent-grid agent-grid--sys">{systemGroup.map(renderTile)}</div>
          </>
        )}

        {showRest &&
          projectGroups.map(({ project, cards }) => (
            <div key={project.id}>
              <SectionHead
                title={project.name}
                note={`${cards.length} agent${cards.length === 1 ? '' : 's'} · this project's team`}
              />
              <div className="agent-grid">{cards.map(renderTile)}</div>
            </div>
          ))}

        {showRest && (
          <>
            <SectionHead title="Library" note="unassigned · yours" />
            <div className="agent-grid">
              {libraryGroup.map(renderTile)}
              {adding ? (
                <NewAgentForm
                  projects={projects}
                  seatGate={seatGate}
                  onCancel={() => setAdding(false)}
                  onCreate={(input) => {
                    const a = createAgent(input)
                    setAdding(false)
                    // Write-through: the new coworker's definition file, at
                    // the write path `create` just settled (canonical, or the
                    // collision-guarded one).
                    void persistAgentToVault(a, settings.vaultPath)
                  }}
                />
              ) : (
                <NewAgentCard onStart={() => setAdding(true)} />
              )}
            </div>
          </>
        )}

        {nothing && (
          <div className="agents__empty">No agents match “{query}”.</div>
        )}
      </div>
        </>
      )}
    </div>
  )
}

function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <div className="sect-head">
      <span className="sect-head__title">{title}</span>
      <span className="sect-head__note">{note}</span>
      <span className="sect-head__rule" />
    </div>
  )
}

function ModelBadge({ kind }: { kind: BadgeKind }) {
  return <span className={`mbadge mbadge--${kind}`}>{MODEL_TEXT[kind]}</span>
}

function AgentTile({
  a,
  projects,
  verdicts,
  sitsOut,
  skillStats,
  menuOpen,
  onToggle,
  onMenu,
  onDelete,
  onReassign,
  onOpen,
}: {
  a: StoredAgent
  projects: Project[]
  verdicts: Verdict[]
  /** '' when this agent's model can really run; else why it will sit out. */
  sitsOut: string
  skillStats: Map<string, SkillStat>
  menuOpen: boolean
  onToggle: () => void
  onMenu: () => void
  onDelete: () => void
  onReassign: (assignedTo: string) => void
  /** Open this agent's own page (the whole head is the link). */
  onOpen: () => void
}) {
  // "Working" only when THIS agent's own assigned project is the one
  // currently running — never fabricated, never borrowed from another
  // project (mirrors ProjectAgentsPanel in Projects.tsx).
  const assignedProject = projects.find((p) => p.id === a.assignedTo)
  const runningProjectId =
    assignedProject && assignedProject.status === 'running' ? assignedProject.id : undefined
  const activity = agentActivity(a, verdicts, runningProjectId)

  // P9 (safety): agent delete is permanent, so arm-then-confirm (mirrors
  // SkillCard). One click on "Delete agent" only ARMS it — a second explicit
  // "confirm" removes it. Closing the menu disarms.
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    if (!menuOpen) setConfirmDel(false)
  }, [menuOpen])

  return (
    <div
      className={
        'agent-tile' +
        (a.system ? '' : ' agent-tile--biz') +
        (a.enabled ? '' : ' agent-tile--off')
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="agent-tile__head agent-tile__head--link"
        role="link"
        tabIndex={0}
        aria-label={`Open ${a.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpen()
        }}
      >
        {/* The face is the MODEL it runs on, and grey when it cannot run —
            not a gradient picked by hashing the name. */}
        <AgentMonogram name={a.name} model={a.model} sitsOut={a.enabled ? sitsOut : 'switched off'} />
        <div className="agent-tile__idcol">
          <div className="agent-tile__name">{a.name}</div>
          <div className="agent-tile__sub" title={a.role}>
            {a.role}
          </div>
        </div>
        <span className="agent-tile__spacer" />
        {a.system && <ModelBadge kind={a.model} />}
        {!a.system && (
          <button
            type="button"
            className="agent-tile__menu"
            onClick={(e) => {
              e.stopPropagation()
              onMenu()
            }}
            aria-label={`Actions for ${a.name}`}
          >
            ⋯
          </button>
        )}
        {menuOpen && (
          <div className="agent-tile__pop">
            {confirmDel ? (
              <div className="agent-tile__confirm">
                <span className="agent-tile__confirmq">Delete “{a.name}”?</span>
                <button
                  type="button"
                  className="agent-tile__confirmyes"
                  onClick={onDelete}
                  aria-label={`Confirm delete ${a.name}`}
                >
                  confirm
                </button>
                <button
                  type="button"
                  className="agent-tile__confirmno"
                  onClick={() => setConfirmDel(false)}
                  aria-label={`Cancel deleting ${a.name}`}
                >
                  cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="agent-tile__popitem"
                onClick={() => setConfirmDel(true)}
                aria-label={`Delete ${a.name}`}
              >
                Delete agent
              </button>
            )}
          </div>
        )}
      </div>

      <div className="chip-row">
        {!a.system && <ModelBadge kind={a.model} />}
        {a.skills.map((s) => {
          const stat = skillStats.get(s.toLowerCase())
          return (
            <span key={s} className="chip-skill">
              {s}
              {/* A bare "12·58%" could not say what the 58% was OF, and in a
                  three-outcome world that is a lie by omission. Fractions name
                  themselves: "12 uses · 7/10 passed · 2 needed a look". */}
              {stat && stat.uses > 0 && (
                <span className="chip-skill__stat">
                  {' '}
                  · {stat.uses} uses ·{' '}
                  {stat.decided === 0 ? 'no decided runs' : `${stat.passes}/${stat.decided} passed`}
                  {stat.attention > 0 && (
                    <span className="chip-skill__attention"> · {stat.attention} needed a look</span>
                  )}
                </span>
              )}
            </span>
          )
        })}
      </div>

      {!a.system && (
        <div className="agent-assign">
          <span className="agent-assign__label">assigned:</span>
          <select
            className="agent-assign__select"
            value={a.assignedTo ?? ''}
            onChange={(e) => onReassign(e.target.value)}
            aria-label={`Reassign ${a.name}`}
          >
            <option value="">Library (unassigned)</option>
            <option value="system">System</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* An agent whose model maps to a provider the app can't reach is NOT on
          the team, and says so here with the reason. It used to keep its seat
          and answer with an offline stub nobody was told about. */}
      {a.enabled && sitsOut && (
        <div className="agent-tile__sitout mono">sits out: {sitsOut}</div>
      )}

      <div className="agent-usage">
        <span className={`agent-usage__dot agent-usage__dot--${activity.state}`} />
        <span className="agent-usage__label mono">{activity.label}</span>
        <span className="agent-usage__spacer" />
        <button
          type="button"
          className={'agtoggle' + (a.enabled ? '' : ' agtoggle--off')}
          onClick={onToggle}
          role="switch"
          aria-checked={a.enabled}
          aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
        >
          <span className="agtoggle__knob" />
        </button>
      </div>
    </div>
  )
}

function NewAgentCard({ onStart }: { onStart: () => void }) {
  return (
    <div className="agent-tile--new">
      <div className="agent-new__title">+ New agent</div>
      <div className="agent-new__desc">
        A structured form — name, role, model, skills. You confirm before it exists (ADR-014).
      </div>
      <div className="agent-new__spacer" />
      <div className="agent-new__actions">
        <button type="button" className="agent-new__btn agent-new__btn--dark" onClick={onStart}>
          Open form
        </button>
      </div>
    </div>
  )
}

function NewAgentForm({
  projects,
  seatGate,
  onCreate,
  onCancel,
}: {
  projects: Project[]
  /** Token → '' or the reason it can't answer. Same gate the launcher applies,
   *  so the form cannot offer a model the run would then refuse. */
  seatGate: (token: string) => string
  onCreate: (input: {
    name: string
    role: string
    model: AgentModel
    skills: string[]
    assignedTo: string
  }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [model, setModel] = useState<AgentModel>('local')
  const [skills, setSkills] = useState('')
  const [assignedTo, setAssignedTo] = useState('')

  const submit = () => {
    if (!name.trim()) return
    onCreate({
      name,
      role,
      model,
      skills: skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      assignedTo,
    })
  }

  // The reason the CHOSEN model can't answer, if any — stated under the field
  // rather than left for the agent tile to reveal after the fact.
  const modelWhy = seatGate(agentModelToken(model))

  return (
    <form
      className="agent-tile--new agent-form"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="agent-new__title">New business agent</div>
      <input
        className="agent-form__input"
        placeholder="name (e.g. pr-reviewer)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        className="agent-form__input"
        placeholder="role (e.g. reviews PRs before merge)"
        value={role}
        onChange={(e) => setRole(e.target.value)}
      />
      {/* The model list used to be three flat options with nothing said about
          whether any of them could actually answer on this Mac. You created the
          agent, and only found out when the tile appeared reading "sits out:".
          Each option now carries its real reason at the moment of choosing. */}
      <select
        className="agent-form__input"
        value={model}
        onChange={(e) => setModel(e.target.value as AgentModel)}
        aria-label="Model"
      >
        {(['local', 'claude', 'gemini'] as AgentModel[]).map((m) => {
          const why = seatGate(agentModelToken(m))
          return (
            <option key={m} value={m}>
              {m === 'claude' ? 'Claude' : m === 'gemini' ? 'Gemini' : 'local'}
              {why ? ` — ${why}` : ''}
            </option>
          )
        })}
      </select>
      {modelWhy && (
        <div className="agent-form__warn mono">
          this agent will be created, but it cannot run yet — {modelWhy}
        </div>
      )}
      <select
        className="agent-form__input"
        value={assignedTo}
        onChange={(e) => setAssignedTo(e.target.value)}
        aria-label="Assign to"
      >
        <option value="">Library (unassigned)</option>
        <option value="system">System</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        className="agent-form__input"
        placeholder="skills, comma-separated"
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
      />
      <div className="agent-new__spacer" />
      <div className="agent-new__actions">
        <button
          type="submit"
          className="agent-new__btn agent-new__btn--dark"
          disabled={!name.trim()}
        >
          Create agent
        </button>
        <button type="button" className="agent-new__btn agent-new__btn--soft" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
