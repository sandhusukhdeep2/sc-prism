import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import './Projects.css'
import VerdictCard, { toVerdictView } from '../components/VerdictCard'
import ProjectRunStage from '../components/ProjectRunStage'
import { useApp, isUsableProjectDir, latestNotice } from '../store/AppStore'
import { agentActivity, agentsForProject, useAgents } from '../lib/agents'
import { expandUserPath, listProjectFiles, pickFolder, revealPath, type ProjectFileMeta } from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import { useConnectivity } from '../lib/connectivity'
import { allowAllProviders, filterRoster, reassignLine, rosterGate, sitOutLine } from '../lib/roster'
import { mergeReadiness } from '../lib/projectRun'
import { addSchedule, projectSchedules, scheduleKind, updateSchedule, useSchedules } from '../lib/schedules'
import {
  addProject,
  attachProject,
  defaultProjectPath,
  projectBuildRoster,
  removeProject,
  slugify,
  staffRoster,
  updateProject,
  useProjects,
  type Project,
  type ProjectStatus,
} from '../lib/projects'
import type { Verdict } from '../engine/types'

// The engine Verdict → VerdictCard view mapping lives in VerdictCard.tsx
// (`toVerdictView`) and is shared with the Workspace thread: it was duplicated
// here, and a duplicated renderer is how one surface keeps telling the old,
// two-valued story after the other has been fixed.

const STATUS_LABEL: Record<ProjectStatus, string> = {
  new: 'new',
  interviewing: 'interviewing',
  planned: 'planned',
  running: 'running',
  awaiting: 'awaiting your answer',
  done: 'done',
  attention: 'needs attention',
}

export function StatusChip({ status }: { status: ProjectStatus }) {
  return (
    <span className={`proj__status proj__status--${status}`}>{STATUS_LABEL[status]}</span>
  )
}

// --- New project form ---

export function NewProjectForm({ onDone }: { onDone: (p: Project) => void }) {
  const [mode, setMode] = useState<'new' | 'attach'>('new')
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [verifyCommand, setVerifyCommand] = useState('')
  const [path, setPath] = useState('')
  const { settings: formSettings } = useSettings()

  const isAttach = mode === 'attach'
  // One vault, everything in it (2026-08-31): new projects default INSIDE the
  // chosen vault, so the company's single vault carries its work everywhere.
  const placeholderPath = defaultProjectPath(slugify(name || 'project'), formSettings.vaultPath)
  const trimmedPath = path.trim()
  const pathIsAbsolute = trimmedPath.startsWith('/')
  const canSubmit = name.trim().length > 0 && (!isAttach || pathIsAbsolute)

  // Create with roster '' — that means "use the default system team" (the
  // enabled sys-* agents), resolved at build time by `projectBuildRoster`.
  // No per-project roster is invented on create; the coworker already set up
  // the task-division at install, so a new project uses it automatically.
  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (isAttach) {
      if (!pathIsAbsolute) return
      const created = attachProject(trimmed, trimmedPath, goal, verifyCommand)
      onDone(created)
      return
    }
    const created = addProject(
      trimmed,
      goal,
      verifyCommand,
      trimmedPath || defaultProjectPath(slugify(trimmed), formSettings.vaultPath),
    )
    onDone(created)
  }

  return (
    <div className="proj__form">
      <div className="proj__modetoggle" role="tablist" aria-label="Project mode">
        <button
          type="button"
          role="tab"
          aria-selected={!isAttach}
          className={`proj__modebtn${!isAttach ? ' proj__modebtn--active' : ''}`}
          onClick={() => setMode('new')}
        >
          New project
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isAttach}
          className={`proj__modebtn${isAttach ? ' proj__modebtn--active' : ''}`}
          onClick={() => setMode('attach')}
        >
          Attach existing
        </button>
      </div>
      <input
        className="proj__forminput"
        value={name}
        placeholder="project name"
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
      />
      {isAttach && (
        <button
          type="button"
          className="proj__startbtn"
          onClick={() => {
            // Native picker (project-room spec: select, don't type). Cancel is
            // a normal outcome — nothing changes. An empty name adopts the
            // folder's own name so one click fills the whole form.
            void pickFolder('Choose the project folder').then((picked) => {
              if (!picked) return
              setPath(picked)
              setName((n) => n.trim() || picked.split('/').filter(Boolean).pop() || n)
            })
          }}
        >
          Choose folder…
        </button>
      )}
      <textarea
        className="proj__formtextarea"
        value={goal}
        placeholder="what is this project trying to achieve?"
        aria-label="Project goal"
        rows={3}
        onChange={(e) => setGoal(e.target.value)}
      />
      <div className="proj__formrow">
        <input
          className="proj__forminput"
          value={verifyCommand}
          placeholder="verify command — e.g. npm test (optional)"
          aria-label="Verify command"
          onChange={(e) => setVerifyCommand(e.target.value)}
        />
        {isAttach ? (
          <input
            className="proj__forminput"
            value={path}
            placeholder="/Users/you/dev/my-repo"
            aria-label="Repository path (required, absolute)"
            onChange={(e) => setPath(e.target.value)}
          />
        ) : (
          <input
            className="proj__forminput"
            value={path}
            placeholder={placeholderPath}
            aria-label="Project folder path"
            onChange={(e) => setPath(e.target.value)}
          />
        )}
      </div>
      <button type="button" className="proj__formsubmit" disabled={!canSubmit} onClick={submit}>
        {isAttach ? 'Attach project →' : 'Create project →'}
      </button>
    </div>
  )
}

// --- Build team line (P1-4, reframed) ---
// A project builds with the DEFAULT system team automatically — the enabled
// sys-* agents (Planner/Implementer/Reviewer/…) on their configured models,
// the task-division set up at install. Nothing is invented per-project on
// create (roster ''). This line just shows whichever team the build will
// ACTUALLY use, resolved by `projectBuildRoster`: this project's OWN assigned
// agents (the exception, for a specific requirement) > an explicit manual
// roster override > the default system team. `rosterSummary` renders that
// exact roster string — honest, never fabricated. A manual single/other-model
// override stays available (Override → type a roster) but isn't the headline.
// Exported (MV5): the approve-mode build proposal (ProjectContextPanel) reuses
// this exact "role → model" rendering rather than duplicating it.
export function rosterSummary(roster: string): string {
  return roster
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => pair.replace(':', ' → '))
    .join(' · ')
}

// MV5 (Manager View §5, approval modes): the build-proposal panel's renderer.
// Thin wrapper over `rosterSummary` (reused, not duplicated) — the proposal
// needs one more thing rosterSummary's existing callers didn't: an honest
// phrase for the empty-roster case (no assigned agents, no override, no
// system agents configured yet) instead of a blank string, since the
// proposal always shows SOME team description before the user approves.
export function renderRoster(roster: string): string {
  return rosterSummary(roster) || 'your default team'
}

// This project's ASSIGNED agents (Task B): when any are assigned they ARE
// the build team and their roster overrides the free-text toggle below
// (`TeamRosterControl`) — see `projectBuildRoster` (lib/projects.ts), which
// `runProject` (AppStore.tsx) actually consults. Each agent's activity is
// COMPUTED from real verdicts + in-flight run state via `agentActivity` —
// never fabricated; "no runs yet" when there's nothing to show.
/**
 * Delete a project from SC Prism (Sukhdeep, 2026-08-29: "…delete"). Honest
 * scope, stated in the confirm itself: the RECORD is removed — chat thread,
 * plan, loop schedule associations — the folder on disk is untouched (use
 * Reveal folder + Finder to trash files). Two-step inline confirm; no native
 * dialog, so the copy can say exactly what happens.
 */
function DeleteProjectControl({ projectId }: { projectId: string }) {
  const [arming, setArming] = useState(false)
  if (!arming) {
    return (
      <button type="button" className="proj__startbtn proj__deletebtn" onClick={() => setArming(true)}>
        Delete project
      </button>
    )
  }
  return (
    <span className="proj__deleteconfirm">
      <span className="mono proj__deletenote">removes it from SC Prism — the folder on disk is untouched</span>
      <button
        type="button"
        className="proj__startbtn proj__deletebtn proj__deletebtn--armed"
        onClick={() => removeProject(projectId)}
      >
        Really delete
      </button>
      <button type="button" className="proj__startbtn" onClick={() => setArming(false)}>
        Keep it
      </button>
    </span>
  )
}

function ProjectAgentsPanel({ project, verdicts }: { project: Project; verdicts: Verdict[] }) {
  const agents = useAgents()
  const assigned = agentsForProject(agents, project.id)
  const runningProjectId = project.status === 'running' ? project.id : undefined

  return (
    <div className="proj__agents">
      <div className="proj__sectionhead">
        <span className="proj__sectionkicker">Agents</span>
        <Link to="/agents" className="proj__agentslink">
          manage on the Agents page →
        </Link>
      </div>
      {assigned.length === 0 ? (
        <div className="proj__agentsempty mono">
          No project-specific agents — this build uses the default system team.
        </div>
      ) : (
        <div className="proj__agentlist">
          {assigned.map((a) => {
            const activity = agentActivity(a, verdicts, runningProjectId)
            return (
              <div key={a.id} className="proj__agentrow">
                <span className="proj__agentorb" style={{ background: a.orb }} />
                <div className="proj__agentinfo">
                  <div className="proj__agentname">
                    <span className="proj__agentnametext">{a.name}</span>
                    <span className="proj__agentmodel mono">{a.model}</span>
                  </div>
                  <div className="proj__agentrole">{a.role}</div>
                  {/* The activity line sits UNDER the name in this narrow rail
                      (2026-08-31): as a trailing column it could not shrink,
                      so a real label overflowed the card and the name wrapped
                      into its own model badge. */}
                  <div className="proj__agentactivityrow" title={activity.label}>
                    <span className={`proj__agentdot proj__agentdot--${activity.state}`} />
                    <span className="proj__agentactivity mono">{activity.label}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TeamRosterControl({ project }: { project: Project }) {
  const agents = useAgents()
  const { settings } = useSettings()
  const { health } = useConnectivity()
  const [editing, setEditing] = useState(false)

  const assigned = agentsForProject(agents, project.id)
  const override = (project.roster ?? '').trim()
  // The exact roster the build will use — same resolver AND same provider gate
  // AppStore.runProject consults, so this line never disagrees with what
  // actually runs (before the gate existed it happily listed a role whose
  // provider was switched off, and the build then stubbed that role).
  const gate = rosterGate(settings, { health })
  // GATE ONCE, in the filter that also REPORTS. Passing `gate` to
  // projectBuildRoster too made it drop the unusable agents itself, leaving
  // filterRoster nothing to report — so this line read "Default team (your
  // system agents)" while the Researcher had been silently removed for Gemini
  // being switched off. Building with `allowAllProviders` lets the one
  // downstream filter both drop AND say who it dropped.
  // THE STAFFING GATE, shown in the room (2026-08-30): a typed role key that
  // names no real library agent is refused at launch (AppStore.runProject),
  // so this line reports it HERE, before the tap — never a seat the build
  // would silently re-charter or reject as a surprise. An override that
  // staffs NOBODY reads as the refusal it is, not as "single model".
  const asked = projectBuildRoster(project, agents, allowAllProviders)
  const staffing = staffRoster(asked, agents)
  const staffingRefused = Boolean(asked) && !staffing.roster
  const resolved = filterRoster(staffing.roster, gate, settings)
  const summary = rosterSummary(resolved.roster)

  const label =
    assigned.length > 0
      ? "this project's agents"
      : override
        ? 'Manual override'
        : 'Default team (your system agents)'

  return (
    <div className="proj__team">
      <div className="proj__teamline mono">
        {label}:{' '}
        {staffingRefused
          ? 'nobody could be staffed — the build will refuse to start'
          : summary || 'single model (no team configured)'}
      </div>
      {staffing.unstaffed.length > 0 && (
        <div className="proj__teamsitout mono">{sitOutLine(staffing.unstaffed)}</div>
      )}
      {resolved.reassigned.length > 0 && (
        <div className="proj__teamsitout mono">{reassignLine(resolved.reassigned)}</div>
      )}
      {resolved.sitOut.length > 0 && (
        <div className="proj__teamsitout mono">{sitOutLine(resolved.sitOut)}</div>
      )}
      {/* Per-project assigned agents take precedence, so the manual roster
          override only applies when there are none — offer it only then. */}
      {assigned.length === 0 ? (
        <>
          <div className="proj__teamactions">
            <button type="button" className="proj__teamlink" onClick={() => setEditing((v) => !v)}>
              {override ? 'Adjust override' : 'Override team'}
            </button>
            {override && (
              <>
                <span className="proj__teamsep">·</span>
                <button
                  type="button"
                  className="proj__teamlink"
                  onClick={() => {
                    setEditing(false)
                    updateProject(project.id, { roster: '' })
                  }}
                >
                  use default team
                </button>
              </>
            )}
          </div>
          {editing && (
            <input
              className="proj__teaminput mono"
              value={project.roster ?? ''}
              placeholder="agent:model, comma separated — e.g. implementer:local (names from your library)"
              aria-label="Team roster override (agent:provider, comma separated)"
              onChange={(e) => updateProject(project.id, { roster: e.target.value })}
            />
          )}
          <div className="proj__teamnote mono">
            the enabled system agents run this build unless you assign project-specific agents or set an override.
          </div>
        </>
      ) : (
        <div className="proj__teamnote mono">
          project-specific agents — manage them on the Agents page.
        </div>
      )}
    </div>
  )
}

// --- Standing build/test loops owned by this project (P2-4) ---
// Off by default: a project owns zero loops until the user explicitly adds
// one here — "Add build loop" / "Add test loop" are the opt-in, and each
// added schedule starts enabled (the click IS the opt-in), routed through
// the app-level loop driver in AppStore.tsx exactly like a free-standing
// standing task, just tagged with this project's id + a 'build'/'test' kind.
export function ProjectLoops({ project }: { project: Project }) {
  // Subscribe to schedule changes so this list re-renders on add/enable
  // toggle; projectSchedules(project.id) reads the (now fresh) singleton.
  useSchedules()
  const loops = projectSchedules(project.id)

  const addBuildLoop = () => addSchedule(project.goal || `build ${project.name}`, 30, '', project.id, 'build')
  const addTestLoop = () => addSchedule(project.goal || `test ${project.name}`, 30, '', project.id, 'test')

  // A test loop runs the project's verify command; with none set it would
  // skip Tier-1 and report a false green, so the button is disabled until the
  // user sets a verify command (mirrors the driver's honest skip-on-empty).
  // The command itself is EDITABLE right here: the interview auto-fills it
  // from the plan's own words, and a wrong extraction must be fixable —
  // the create form was the only other editor.
  const canTest = !!project.verifyCommand.trim()

  return (
    <div className="proj__loops">
      <div className="proj__sectionhead">
        <span className="proj__sectionkicker">Loops</span>
        <span className="proj__sectionhint mono">
          standing build/test loops for this project — off until you add one
        </span>
      </div>
      <div className="proj__loopbtns">
        <button type="button" className="proj__loopbtn" onClick={addBuildLoop}>
          + Add build loop
        </button>
        <button
          type="button"
          className="proj__loopbtn"
          onClick={addTestLoop}
          disabled={!canTest}
          title={canTest ? undefined : 'set a verify command first'}
        >
          + Add test loop
        </button>
        <input
          className="proj__verifyinput mono"
          value={project.verifyCommand}
          placeholder="set a verify command first"
          aria-label="Verify command"
          onChange={(e) => updateProject(project.id, { verifyCommand: e.target.value })}
        />
      </div>
      {loops.length > 0 && (
        <div className="proj__loopslist">
          {loops.map((s) => {
            const kind = scheduleKind(s)
            return (
              <div key={s.id} className="proj__looprow">
                <span className={`proj__loopkind proj__loopkind--${kind} mono`}>{kind}</span>
                <span className="proj__looptask">{s.task}</span>
                <span className="proj__loopevery mono">every {s.everyMinutes}m</span>
                <label className="proj__loopenable mono">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${kind} loop`}
                    onChange={(e) => updateSchedule(s.id, { enabled: e.target.checked })}
                  />
                  {s.enabled ? 'on' : 'off'}
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// --- Shared project context body: meta/agents/team/loops/merge + plan/run/
// verdicts. Extracted (P1-3b) so the Work page's right rail can mount the
// SAME live project context as this page's detail view — one body, two
// mount points, no duplicated logic. Pure extraction: identical JSX/classes
// to what ProjectView rendered; the plan `<section>` and the interview
// `<section>` below are mutually exclusive on `project.plan.length`, so
// moving the plan section in here (rendered before ProjectView's interview
// block) never changes the actual DOM order — only one of the two ever
// renders at a time.
// Project-room spec §5: every file the room mentions must be reachable from
// the room. The panel lists the folder's REAL contents (Rust walk: capped,
// dotfiles skipped, symlinks never followed) and a click reveals the file in
// the Finder. Loaded on mount + whenever the path changes; a run finishing
// refreshes it (new files appear without leaving the room).
function FilesPanel({ project }: { project: Project }) {
  const { state } = useApp()
  const navigate = useNavigate()
  const [files, setFiles] = useState<ProjectFileMeta[]>([])
  const [dir, setDir] = useState('')
  const [openList, setOpenList] = useState(false)
  const liveCount = state.liveRuns.length
  useEffect(() => {
    let cancelled = false
    // Best-effort by design (and the catch keeps a half-stubbed test env from
    // leaking an unhandled rejection out of this fire-and-forget effect).
    void (async () => {
      const abs = await expandUserPath(project.path)
      if (cancelled) return
      setDir(abs)
      setFiles(await listProjectFiles(abs))
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [project.path, project.stepIndex, project.status, liveCount])
  if (files.length === 0) return null
  const shown = files.slice(0, 100)
  const fmt = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
  const fileCount = files.filter((f) => !f.dir).length
  // Sprint E (2026-08-31, 'the sidebar shows way more than needed'): the list
  // folds behind its count; one click opens it.
  if (!openList) {
    return (
      <div className="proj__files">
        <button type="button" className="proj__fileshead proj__fileshead--btn mono" onClick={() => setOpenList(true)}>
          Files · {fileCount} ▸
        </button>
      </div>
    )
  }
  return (
    <div className="proj__files">
      <button type="button" className="proj__fileshead proj__fileshead--btn mono" onClick={() => setOpenList(false)}>
        Files · {fileCount} ▾
      </button>
      {shown.map((f) =>
        f.dir ? (
          <div key={f.path} className="proj__filerow proj__filerow--dir mono">
            {f.path}/
          </div>
        ) : (
          <span key={f.path} className="proj__filerowwrap">
            <button
              type="button"
              className="proj__filerow mono"
              title="open in the Editor"
              onClick={() => navigate(`/editor?file=${encodeURIComponent(f.path)}`)}
            >
              <span className="proj__filepath">{f.path}</span>
              <span className="proj__filesize">{fmt(f.size)}</span>
            </button>
            <button
              type="button"
              className="proj__filereveal mono"
              title="reveal in Finder"
              aria-label={`Reveal ${f.path} in Finder`}
              onClick={() => void revealPath(`${dir}/${f.path}`)}
            >
              ↗
            </button>
          </span>
        ),
      )}
      {files.length > shown.length && (
        <div className="proj__filerow proj__filerow--dir mono">… {files.length - shown.length} more — Reveal folder for all</div>
      )}
    </div>
  )
}

export function ProjectContextPanel({ project }: { project: Project }) {
  const { state, runProject, answerProjectRequest, mergeProject } = useApp()
  const { settings } = useSettings()
  const { health } = useConnectivity()
  const agents = useAgents()
  // The team as it would REALLY be assembled: same gate the build applies, so
  // the proposal can't promise a role whose provider isn't connected.
  const proposalGate = rosterGate(settings, { health })
  // Staff first (same gate the build applies, 2026-08-30) so the proposal can
  // no more promise a made-up role than an unconnected provider — an override
  // that staffs NOBODY must read as the refusal here, not as "your default
  // team. Approve to build." while runProject refuses.
  const proposedAsk = projectBuildRoster(project, agents, allowAllProviders)
  const proposedStaffing = staffRoster(proposedAsk, agents)
  const proposalRefused = Boolean(proposedAsk) && !proposedStaffing.roster
  const proposedTeam = filterRoster(proposedStaffing.roster, proposalGate, settings)

  // MV5 (Manager View §5): in 'approve' mode, "Start build" proposes the
  // REAL resolved team (same `projectBuildRoster` the build itself consults)
  // and waits for an explicit "Approve & build" before `runProject` ever
  // fires — a pre-run trigger gate, not a rewire of the mid-run
  // awaiting/answerProjectRequest handshake below (untouched). Reset on
  // project switch so a stale proposal never bleeds onto a different project.
  const [proposing, setProposing] = useState(false)
  useEffect(() => {
    setProposing(false)
  }, [project.id])

  const projectVerdicts = project.verdictIds
    .slice()
    .reverse()
    .map((id) => state.verdicts.find((v) => v.taskId === id))
    .filter((v): v is Verdict => v !== undefined)

  // Notices accumulate (never cleared by the driver itself), so take the LAST
  // matching ask — the first would show a previous ask's stale text on a
  // second park.
  const awaitingNotice = latestNotice(state.notices, project.id, 'request')



  // Reveal the built project's folder in the Finder once the build is done.
  // Honest limit: this reveals the folder, not a live site — the build has
  // no tracked entry file to open. Reuses the driver's exact resolve+validate
  // (expandUserPath + isUsableProjectDir) so a stale/relative project.path
  // refuses the same way runProject/mergeProject already do.
  const revealProjectFolder = async () => {
    const dir = await expandUserPath(project.path)
    if (isUsableProjectDir(dir)) void revealPath(dir)
  }

  return (
    <>
      <div className="proj__viewmeta mono">
        <span>{project.path}</span>
        {project.verifyCommand && <span>verify: {project.verifyCommand}</span>}
        {project.runBranch && (
          <span>
            {project.baseBranch || '(unknown)'} → {project.runBranch}
          </span>
        )}
      </div>

      <FilesPanel project={project} />
      <ProjectAgentsPanel project={project} verdicts={state.verdicts} />
      <TeamRosterControl project={project} />
      <ProjectLoops project={project} />

      {mergeReadiness(project) === 'ready' && (
        <button
          type="button"
          className="proj__mergebtn"
          onClick={() => void mergeProject(project.id)}
        >
          Merge {project.runBranch} into {project.baseBranch || '(unknown)'} →
        </button>
      )}

      {/* Plan + run — the numbered build plan, Start build, and (once B5 lands)
          the cinematic run stage. */}
      {project.plan.length > 0 && (
        <section className="proj__plan">
          <div className="proj__sectionhead">
            <span className="proj__sectionkicker">Plan</span>
            {project.brief && <span className="proj__sectionhint">{project.brief}</span>}
          </div>
          <ol className="proj__steps">
            {project.plan.map((step, i) => {
              const st: 'done' | 'current' | 'todo' =
                project.status === 'done' || i < project.stepIndex
                  ? 'done'
                  : i === project.stepIndex && project.status !== 'planned'
                    ? 'current'
                    : 'todo'
              return (
                <li key={i} className={`proj__step proj__step--${st}`}>
                  <span className="proj__stepnum mono">{i + 1}</span>
                  <span className="proj__steplabel">{step}</span>
                </li>
              )
            })}
          </ol>

          {/* MV5: only the INITIAL start is gated by approvalMode. Auto mode
              keeps today's behavior (Start build → runProject directly).
              Approve mode (default) proposes the real resolved team first;
              runProject only fires from the explicit "Approve & build"
              below — it provably cannot run without that click. */}
          {project.status === 'planned' && !proposing && (
            <button
              type="button"
              className="proj__startbtn"
              onClick={() => {
                if (settings.approvalMode === 'auto') void runProject(project.id)
                else setProposing(true)
              }}
            >
              Start build →
            </button>
          )}
          {project.status === 'planned' && proposing && (
            <div className="proj__proposal">
              <div className="proj__proposaltext mono">
                {proposalRefused ? (
                  <>No team could be staffed — the build will refuse to start.</>
                ) : (
                  <>
                    The Manager will assemble your team:{' '}
                    <strong>{renderRoster(proposedTeam.roster)}</strong>. Approve to build.
                  </>
                )}
              </div>
              {proposedStaffing.unstaffed.length > 0 && (
                <div className="proj__teamsitout mono">{sitOutLine(proposedStaffing.unstaffed)}</div>
              )}
              {proposedTeam.reassigned.length > 0 && (
                <div className="proj__teamsitout mono">{reassignLine(proposedTeam.reassigned)}</div>
              )}
              {proposedTeam.sitOut.length > 0 && (
                <div className="proj__teamsitout mono">{sitOutLine(proposedTeam.sitOut)}</div>
              )}
              <div className="proj__proposalbtns">
                <button
                  type="button"
                  className="proj__approvebtn"
                  onClick={() => {
                    void runProject(project.id)
                    setProposing(false)
                  }}
                >
                  Approve &amp; build →
                </button>
                <button
                  type="button"
                  className="proj__cancelbtn"
                  onClick={() => setProposing(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {/* 'awaiting' needs Resume too: after an app reload the parked
              driver is gone, so the banner's Yes/No would no-op — runProject
              special-cases status==='awaiting' and re-parks the ask with a
              live driver behind the buttons. */}
          {(project.status === 'attention' || project.status === 'awaiting') && (
            <button type="button" className="proj__startbtn" onClick={() => void runProject(project.id)}>
              Resume build →
            </button>
          )}
          {project.status === 'running' && (
            <div className="proj__runningnote mono">
              ⏳ running — step {Math.min(project.stepIndex + 1, project.plan.length)} of {project.plan.length}
            </div>
          )}
          {Boolean(project.path) && (
            <button type="button" className="proj__startbtn" onClick={() => void revealProjectFolder()}>
              Reveal folder
            </button>
          )}
          <DeleteProjectControl projectId={project.id} />

          {project.status === 'awaiting' && (
            <div className="proj__askbanner">
              <div className="proj__askbannertext">
                {awaitingNotice?.text ?? `«${project.name}» is waiting for your answer.`}
              </div>
              <div className="proj__askbannerhint mono">waiting for your answer — see the orb</div>
              <div className="proj__askbannerbtns">
                <button type="button" className="proj__askyes" onClick={() => answerProjectRequest(true)}>
                  Yes, one more try
                </button>
                <button type="button" className="proj__askno" onClick={() => answerProjectRequest(false)}>
                  No, stop here
                </button>
              </div>
            </div>
          )}

          {project.lastNote && project.status !== 'awaiting' && (
            <div className="proj__lastnote mono">{project.lastNote}</div>
          )}

          <ProjectRunStage project={project} />

          {projectVerdicts.length > 0 && (
            <div className="proj__verdicts">
              <div className="proj__sectionkicker">Verdicts</div>
              <div className="proj__verdictlist">
                {projectVerdicts.map((v) => (
                  <VerdictCard key={v.taskId} v={toVerdictView(v)} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  )
}

// --- Redirect: /projects (+ ?open=<id>) now lands on the Work page ---
// There is ONE place to work. The Companion orb / Desk links still deep-link
// to `/projects?open=<id>` (unchanged callers) — this selects that project
// (if it resolves) and hands off to the Work page ('/') instead of opening a
// separate Projects page. The old Projects list page + ProjectView detail
// view (superseded by the Work page — the interview runs in the center
// thread, the context lives in the right rail) are gone; only this redirect
// remains from that route.
export function ProjectsRedirect() {
  const { setActiveProject } = useApp()
  const { projects } = useProjects()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId && projects.some((p) => p.id === openId)) {
      setActiveProject(openId)
    }
    navigate('/', { replace: true })
  }, [searchParams, projects, setActiveProject, navigate])
  return null
}
