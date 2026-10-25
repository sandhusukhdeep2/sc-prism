import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import VerdictCard, { toVerdictView } from '../components/VerdictCard'
import ConnectivityBanner from '../components/ConnectivityBanner'
import Desk, { useDeskState } from '../components/Desk'
import ErrorMessageCard from '../components/ErrorMessageCard'
import LiveActivity from '../components/LiveActivity'
import RunStream from '../components/RunStream'
import ChatRunStream from '../components/ChatRunStream'
import UserBubble from '../components/UserBubble'
import CopyButton from '../components/CopyButton'
import { renderChatMarkdown } from '../lib/chatMarkdown'
import { narrateStatus, narrationLines } from '../lib/narrate'
import { modelColor } from '../lib/modelColor'
import {
  activeMessages,
  activeThreadKey,
  collapseRepeats,
  buildEngineProviders,
  teamRosterFromSettings,
  useApp,
  type ChatMessage,
  type RouteHint,
} from '../store/AppStore'
import { isCliProvider, primaryDisplayName, primarySupportsVision, useSettings } from '../lib/settings'
import { meterFor } from '../lib/contextMeter'
import { useConnectivity } from '../lib/connectivity'
import { filterRoster, rosterGate, sitOutLine } from '../lib/roster'
import Icon from '../components/Icon'
import { greeting, statusLine } from '../lib/desk'
import { isNative, pickFile, readImageBase64, readTextFile, revealVaultNote } from '../lib/nativeEngine'
import { composeWithAttachments, displayLine, type ChatAttachment } from '../lib/attachments'
import { useSpanTail } from '../lib/engineConsole'
import { stageSpans, type PipelineStage,
  projectRunSpans,
} from '../lib/pipeline'
import type { EngineSpan } from '../lib/nativeEngine'
import LiveRunCards from '../components/LiveRunCards'
import { activeRuns, crewSize, currentRunSpans, lastFinishedRunSpans } from '../lib/liveRuns'
import CrewBoard from '../components/CrewBoard'
import RunLedger from '../components/RunLedger'
import { availableTeam, decideRouting, managerToken, routingLine } from '../lib/delegation'
import { useInterview } from '../lib/interview'
import { agentTaskBrief, agentTaskDisplay, useAgents } from '../lib/agents'
import { proposeAgentBrief } from '../lib/agentProposals'
import { projectNeeds, rosterCharter } from '../lib/projectRoster'
import { appRunCapabilities } from '../lib/delegation'
import { useProjects, useProjectsHydrated, nextSendMode, removeProject } from '../lib/projects'
import { NewProjectForm, ProjectContextPanel, StatusChip } from './Projects'
import './Projects.css'
import './Workspace.css'

// THE ENGINE CONSOLE, rehomed (2026-08-18).
//
// This used to be a permanent black box under the chat: on screen whether or
// not anything was running, showing the last run's 40-span trail, and — with
// the ledger and the two rail panels stacked under it — one of the blocks that
// made Work taller than the window. The visual-system-v2 spec makes it the
// EXPANDABLE DETAIL of a pipeline step, so that is exactly what it is now: the
// `▸` on a column in CrewBoard opens THIS, for THAT step, and nothing renders
// until the user asks.
//
// It shows the spans of ONE step and no others. `stageSpans` re-reads the same
// `round` attr the column was grouped by, and the caller only ever hands it
// `currentRunSpans` — which is [] whenever 2+ runs are in flight — so a step's
// detail can neither drift onto another run nor become a general tail again.
// Span reading/formatting still lives in ../lib/engineConsole (shared with the
// Project run stage's narration strip); this component only owns the JSX/CSS.
export function EngineConsole({
  label,
  spans,
  live,
  now = Date.now(),
  vaultPath,
}: {
  /** The step this detail belongs to — the engine's own stage label. */
  label: string
  /** THIS step's real spans. Nothing else is ever shown. */
  spans: EngineSpan[]
  /** Is a run genuinely EXECUTING (`activeRuns`)? A parked run is not. */
  live: boolean
  /** Injected wall clock (tests). */
  now?: number
  /** Vault root for the drawer's reveal control (audit fix 2026-08-30). */
  vaultPath?: string
}) {
  const status = narrateStatus(spans)
  return (
    <div className="ws__console">
      <div className="ws__consolehead mono">
        <span className={'ws__consoledot' + (live ? ' ws__consoledot--live' : '')} />
        {`engine steps · ${label} (${spans.length} span${spans.length === 1 ? '' : 's'})`}
      </div>
      <div className="ws__consolebody mono">
        {status && <div className="ws__narrate mono">{status}</div>}
        <RunStream spans={spans} now={now} onRevealNote={(rel) => void revealVaultNote(vaultPath, rel)} />
        {live && (
          <div className="ws__consoleline ws__consoleline--wait">
            … working (spans appear as each phase completes)
          </div>
        )}
        {spans.length === 0 && !live && (
          <div className="ws__consoleline ws__consoleline--wait">
            the engine recorded no spans for this step
          </div>
        )}
      </div>
    </div>
  )
}

// --- map the engine's structured artifacts onto the display cards ---
// (the Verdict → card mapping now lives in VerdictCard.tsx as `toVerdictView`,
// shared with Projects.tsx — it used to be copy-pasted into both.)
//
// A third mapper used to live here: it turned a SIMULATOR agent into the Live
// agent card, inventing a token burn, an eval score and a progress bar. Both it
// and the store's live-agent slice it read are deleted (2026-08-16 Finding 1);
// the card now renders from the real live run + its real spans, below.

/**
 * The letter for a chat reply's disc: the PROVIDER's initial.
 *
 * `m.model` is `provider · model` ("local · Qwen3.8-27B-4bit", "claude-cli ·
 * opus"), and the provider is what the colour already encodes — so the letter
 * and the hue say the same thing rather than two different ones. A model string
 * that named no provider yields '' and the disc stays blank, which is the same
 * non-claim the idle grey makes.
 */
export function providerInitial(model: string): string {
  const provider = (model ?? '').split('·')[0].trim()
  return provider ? provider.charAt(0).toUpperCase() : ''
}

export default function Workspace() {
  const { state, sendIntent, send, sendTeam, setActiveProject, compressNow, newSession } = useApp()
  const { settings } = useSettings()
  const connectivity = useConnectivity()
  const [draft, setDraft] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)
  // In-app confirms (replace the old native window.confirm dialogs).
  const [confirmNewSession, setConfirmNewSession] = useState(false)
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false)
  // THE RAIL FOLDS DURING A RUN (Sukhdeep, watching the first live build:
  // "remove these two things on the sidebar and put sidebar stuff somewhere
  // else, so we have enough space for the chat and can see the live feed").
  // While a run is genuinely executing the rail auto-collapses — the stage's
  // ON-IT-NOW chips + Who's-on-it board ARE the live feed, at full width —
  // and a "details" toggle in the chat tabs brings it back on demand. With
  // nothing live the rail returns on its own: a PLANNED project's rail holds
  // the Start-build button, which must never be hidden by default.
  const [railChoice, setRailChoice] = useState<'auto' | 'open' | 'closed'>('auto')
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Slice A — file attachments: text/code/doc files reach the AI as plain
  // context (composeWithAttachments), so this works with ANY connected model,
  // no vision/multimodal gating needed (that's Slice B, images).
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  // Slice B — image attach (multimodal). One image per message: `path` is
  // forwarded to the engine (`--image`, which re-reads + validates it and builds
  // the image block); `dataUri` is only the composer thumbnail preview. A vision
  // route sends the image; a non-vision route is told honestly it wasn't sent.
  const [image, setImage] = useState<{ path: string; name: string; dataUri: string } | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  // Honest capability signal for the composer hint: does the enabled primary
  // provider actually support vision? (The engine gateway stays authoritative.)
  const visionCapable = primarySupportsVision(settings)

  // Per-message route hint (composer local/cloud/auto). Default 'auto' = let the
  // gateway decide (byte-identical to no hint). It applies to the NEXT message
  // only and resets to 'auto' after send — an intentional, one-off override, not
  // a sticky mode. The gateway keeps sensitive content local whatever is picked;
  // the attribution chip on the reply shows where it ACTUALLY went + why.
  const [routeHint, setRouteHint] = useState<RouteHint>('auto')

  // The per-message OVERRIDE panel (who takes this / where it runs), closed by
  // default. See the composer below for why it is no longer seven always-on
  // pills. Closed on send with the same discipline the controls themselves
  // keep: both reset after every message, so a panel left open would advertise
  // a choice that has already lapsed.
  const [overrideOpen, setOverrideOpen] = useState(false)

  // WHO does this task (Mission Control §Give a task from Work, 2026-08-06).
  // A team run could only be started from the Agents page — "there is lots of
  // place where I start a task… I supposed to give a task in a work page". The
  // composer now picks the runner:
  //   'companion' — the default and byte-identical to before this control
  //                 existed (same `send`, same args, same everything),
  //   'team'      — the SHARED governed team launch (`sendTeam` → the store's
  //                 one `launchTeam`, the same one the Agents page calls),
  //   'agent'     — one REAL agent from the library, briefed on the companion
  //                 (see `agentTaskBrief` — the app has no per-agent runner and
  //                 never pretends otherwise).
  // Like the route hint beside it, this applies to the NEXT message and resets
  // to the companion after send: a team run costs minutes and real tokens, so a
  // sticky target would silently spend them on the next thing typed.
  //   'propose'   — ask for a NEW agent (2026-08-11 spec, source (b)). It runs
  //                 the same companion send with a brief that demands the strict
  //                 PROPOSE_AGENT block; the reply's block becomes a PROPOSAL on
  //                 the desk, citing this very message as its evidence. Nothing
  //                 is created here — the human creates, from the desk.
  // Sprint B (2026-08-30, his order): the TEAM is the default lane — different
  // AIs, different agents. The manager (companion) is the one-click
  // alternative; the per-message reset below also returns to team.
  const [target, setTarget] = useState<
    'companion' | 'team' | 'agent' | 'propose' | 'staff'
  >('team')
  const [agentId, setAgentId] = useState('')
  // Sprint B2: the three specialist lanes fold behind 'more ▾' — two visible
  // choices (manager, team), never five (his 'too complicated' note).
  const [moreTargetsOpen, setMoreTargetsOpen] = useState(false)
  // The roles the team run actually gets — seeded from what is really connected
  // (the same preset the Agents launcher shows) and editable right here.
  // The manager staffs the team (2026-08-31): the composer no longer edits a
  // roster string — the settings-derived default is what launch resolves.
  const roster = teamRosterFromSettings(settings)
  // The same provider gate the launch itself applies (AppStore.launchTeam), so
  // this hint and the run can never disagree: a role whose model maps to a
  // provider that isn't connected sits out, and it says so here first.
  const teamSitOut = sitOutLine(
    filterRoster(roster, rosterGate(settings, { health: connectivity.health }), settings).sitOut,
  )

  // SUKH'S OWN DECISION for the message being composed (2026-08-15 spec §One
  // front door): does he do it himself, hand it to the better-suited AI, or
  // assemble a team — and WHY. It is shown BEFORE the send, so the user never
  // discovers the pick afterwards, and never sees a pick with no reason.
  //
  // `availableTeam` reuses roster.ts's seat test (f2766c6), so an AI that
  // cannot answer is never offered; the user's own sensitive words are the same
  // list threaded to the engine as SCPRISM_SENSITIVE, so the floor that fires
  // here is the floor that fires there.
  const { interview: iv } = useInterview()
  const seats = availableTeam(settings, { health: connectivity.health })
  const routing = decideRouting({
    intent: draft,
    sensitiveWords: iv.sensitiveWords,
    team: seats.team,
    sitOut: seats.sitOut,
    wantsTeam: target === 'team',
    managerToken: managerToken(settings),
  })

  // The project bound to this Workspace session (P2-4), if any — set via
  // Projects' "Open in Workspace" button. undefined (the default) when no
  // project has ever been opened, or the bound id no longer resolves (the
  // project was deleted): the chip simply doesn't render, same as today.
  const { projects } = useProjects()
  const projectsHydrated = useProjectsHydrated()
  const activeProject = state.activeProjectId
    ? projects.find((p) => p.id === state.activeProjectId)
    : undefined

  // The active project's REAL activity feed (run/skill/created events) — shown
  // in the engine/activity console below the chat (the rail keeps team-only).
  const agents = useAgents()
  // The picker mounted in the composer's team panel reads the SAME provider
  // gate the launch itself applies, so what it offers and what actually runs
  // cannot drift apart. It is handed the WHOLE library — including the agents
  // that cannot play — because a seat that sits out has to say so rather than
  // be silently absent.
  // The agents the composer may actually address: the REAL enabled entries of
  // the library, nothing invented. An empty library disables the option and
  // says why — it never offers a name that doesn't exist.
  const libraryAgents = agents.filter((a) => a.enabled)

  // STAFFING (2026-08-15). Sukh can only staff a project that HAS recorded
  // needs — its own plan steps, which are the roles' only citable evidence. No
  // open project, or a project with no plan yet, means the option is genuinely
  // unavailable and the composer says so rather than offering a dead button.
  const staffProject = activeProject
  const staffNeeds = staffProject ? projectNeeds(staffProject) : []
  const canStaff = !!staffProject && staffNeeds.length > 0
  const chosenAgent = libraryAgents.find((a) => a.id === agentId) ?? libraryAgents[0]

  // Mission Control (2026-08-05): the app's ONE live-run truth. Everything
  // that says "something is happening" on this page — the glowing cards, the
  // narration in the chat column, the console's live label and the orb pulse —
  // derives from THIS and nothing else, so none of them can claim activity
  // that isn't real. `state.running` (chat-only) is deliberately no longer the
  // signal: a team/manager/heartbeat/project run is just as live.
  const liveRuns = state.liveRuns
  // ...minus the runs PARKED on a human answer. A parked build (the "one more
  // refine?" gate) is registered but its engine has already exited, so it must
  // not make anything on this page glow, pulse or read "live" — it can sit
  // there all night. Its card stays, saying "waiting on you".
  const executing = activeRuns(liveRuns)
  const anyLive = executing.length > 0
  // The rail's visibility: the user's explicit choice wins; 'auto' folds it
  // exactly while something is genuinely executing (see railChoice above).
  const railVisible = railChoice === 'open' || (railChoice === 'auto' && !anyLive)

  // ONE span tail for the whole page (console body, orbs, cards, narration).
  // This REPLACES the two independent 1200ms polls Workspace used to run (the
  // console's own + a second one for OrbView) — following the live run costs
  // no new poller, it costs one fewer. Parked runs don't poll either: no engine
  // is writing spans while the app waits on the human.
  const tail = useSpanTail(settings.vaultPath, anyLive)
  // The spans of whatever is running right now (by real span start time) — []
  // when nothing is live AND when 2+ runs are (they can't be told apart), so
  // narration can never outlive a run or be pinned on the wrong one.
  const liveSpans = currentRunSpans(tail.spans, executing)
  // WHAT THE BOARD DRAWS. While a run executes, only that run's spans (which is
  // [] whenever two runs are in flight, so one crew can never be attributed to
  // another). When nothing is running, the LAST FINISHED run's spans — but only
  // if it was genuinely a crew, because drawing a one-monogram board for an
  // ordinary chat reply would dress a single answer up as teamwork.
  const finishedSpans = lastFinishedRunSpans(tail.spans)
  const showsLastCrew = !anyLive && crewSize(finishedSpans) > 1
  // A PROJECT'S BOARD IS ITS WHOLE BUILD, not the one step running now.
  //
  // Each plan step is a separate engine run, so `liveSpans` only ever held the
  // current one: a four-step plan drew a single anonymous column that changed
  // four times, and the crew he staffed was nowhere. The project keeps the task
  // id of every step it has finished, so the build's real shape is recoverable
  // — one column per step, each carrying the seat that did it and the step's
  // own text as its label.
  //
  // The live step is unioned on top so the column being worked RIGHT NOW is
  // there before its verdict lands; without it the board would always be one
  // step behind itself.
  const projectSpans = activeProject
    ? [...projectRunSpans(tail.spans, activeProject.verdictIds), ...(anyLive ? liveSpans : [])]
    : []
  const boardSpans = activeProject
    ? projectSpans
    : anyLive
      ? liveSpans
      : showsLastCrew
        ? finishedSpans
        : []
  const narration = narrationLines(liveSpans, 4)
  // (The active project's activity feed used to be piped into the console box
  // when idle. That box is gone — it is a pipeline step's `▸` detail now — and
  // the same real feed already has its own home in the project rail below,
  // `<LiveActivity project={...} />`, so nothing measured was lost with it.)

  // A persisted/orphaned activeProjectId (or one just deleted) that no longer
  // resolves falls back to Universal, so the chat never shows a ghost thread.
  // Gated on `projectsHydrated` so we never clear a VALID binding during the
  // brief window before native disk hydration finishes (the cache can lag disk).
  useEffect(() => {
    if (projectsHydrated && state.activeProjectId && !activeProject) setActiveProject('')
  }, [projectsHydrated, state.activeProjectId, activeProject, setActiveProject])

  // Switching threads/projects disarms any pending in-app confirm.
  useEffect(() => {
    setConfirmDeleteProject(false)
    setConfirmNewSession(false)
  }, [state.activeProjectId])

  const [retryBusyId, setRetryBusyId] = useState<string | null>(null)
  const retryError = async (m: Extract<ChatMessage, { kind: 'error' }>) => {
    setRetryBusyId(m.id)
    try {
      const status = await connectivity.probeOne(m.providerId)
      if (status === 'ok') void sendIntent(m.intent)
      else void connectivity.probeAll() // refresh dot/banner as visible feedback
    } finally {
      setRetryBusyId(null)
    }
  }

  // Who is answering — used for honest "X is thinking…" feedback. Subscription
  // CLIs cold-start per call, so tell the user replies take longer there.
  const primaryName = primaryDisplayName(settings)
  // The companion's name is the user's to choose (settings.companionName). These
  // lines said "Sukh" — the author's own companion — on every install.
  const companionName = settings.companionName.trim() || 'the manager'
  const primaryIsCli = settings.providers.some((p) => p.primary && isCliProvider(p.id))
  const thinkingLabel = primaryIsCli
    ? `${primaryName} is thinking… (subscription replies take 15–45s)`
    : `${primaryName} is thinking…`

  // The composer says WHO it is addressing, so a task can never go somewhere
  // the user didn't expect. The companion wording is unchanged (the default
  // path is untouched, down to its placeholder + label).
  const composerLabel =
    target === 'team'
      ? 'Describe the task for the team'
      : target === 'propose'
        ? 'Describe the gap — you get a proposal to review, not a new agent'
        : target === 'staff' && staffProject
          ? `Send to have ${companionName} staff “${staffProject.name}” — you get a roster to review, not a team`
        : target === 'agent' && chosenAgent
          ? `Describe the task for ${chosenAgent.name}`
          : 'Describe what you want to build'
  // A proposal is only ever RECORDED on the real-engine path (the store reads
  // the reply's block only when a real completion comes back). Without a real
  // primary the target bar's promise — "you get a proposal to review" — is
  // quietly unmet, so it says so instead.
  // WHO this send goes to, in one sentence — the target actually selected, so
  // it can never name a coworker the message will not reach.
  const targetSentence =
    target === 'team'
      ? 'your team takes this'
      : target === 'agent'
        ? chosenAgent
          ? `${chosenAgent.name} takes this`
          : 'nobody enabled to take this'
        : target === 'propose'
          ? 'you get a proposal to review'
          : target === 'staff'
            ? `${companionName} staffs this project`
            : `${primaryName} takes this`

  const proposalCanRun = isNative() && buildEngineProviders(settings).primaryReal
  const hasContent = !!draft.trim() || attachments.length > 0 || !!image
  // What Send is allowed to do: a team run needs TEXT (it has no image path),
  // and an agent target needs a real agent to address.
  const canSend =
    target === 'team'
      ? !!draft.trim() || attachments.length > 0
      : target === 'propose'
        ? // a proposal must cite the user's OWN words as evidence, so it needs
          // typed text — an attachment alone is nothing to quote
          !!draft.trim()
        : target === 'staff'
          ? // The charter carries the project's own needs, so this send needs no
            // typed text — but it DOES need a project with real needs to cite.
            canStaff
          : target === 'agent'
            ? hasContent && !!chosenAgent
            : hasContent

  // keep the newest message / verdict in view as the task streams
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeMessages(state), state.liveRuns])

  // Auto-grow the composer textarea to fit its content, up to a max height
  // (then it scrolls). Runs on every draft change, including the reset to '' on
  // send so it collapses back to a single line.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const submit = () => {
    if (state.running) return
    const text = draft.trim()
    // Staffing is the one send that carries no user text: the brief IS the
    // project's recorded plan. Every other target still needs something typed.
    if (target !== 'staff' && !text && attachments.length === 0 && !image) return
    // ...and it needs a project with REAL recorded needs to cite, or there is
    // nothing honest to staff against.
    if (target === 'staff' && !canStaff) return
    // An agent target with nothing to address can't send (the control is
    // disabled in that state — this is the belt-and-braces guard, so a task can
    // never be attributed to an agent that isn't there).
    if (target === 'agent' && !chosenAgent) return
    // A team run takes TEXT — an image alone has nowhere to go (guarded by the
    // send button too).
    if (target === 'team' && !text && attachments.length === 0) return
    // A proposal quotes the user's own request as its evidence — with no typed
    // text there is nothing real to cite, so nothing is sent.
    if (target === 'propose' && !text) return
    // Two strings: the ENGINE/AI gets the full file bodies (composeWithAttachments);
    // the transcript + vault log get the compact "📎 name (N chars)" ref (displayLine),
    // so a 50 KB file never becomes a wall of text in the user's bubble or the saved log.
    const engineText = composeWithAttachments(text, attachments)
    // The transcript shows a compact ref for text files; an attached image adds
    // its own "🖼️ name" marker so the user's bubble reflects what was sent.
    const baseDisplay = displayLine(attachments, text)
    const displayText = image ? `${baseDisplay ? `${baseDisplay}\n` : ''}🖼️ ${image.name}` : baseDisplay
    // Snapshot the hint + image for THIS send, then reset — the override is
    // per-message, so the next message goes back to letting the gateway decide.
    // SUKH'S CHOICE ACTUALLY DRIVES THE RUN (2026-08-15). The line shown above
    // the composer is not a description of what might happen — it becomes this
    // message's real route hint, which the gateway honours WITHIN the
    // sensitivity floor. Your own explicit local/cloud pick still wins: this
    // only fills the 'auto' case, which is where the manager is supposed to
    // decide. A refusal picks nothing (there is nowhere honest to send it).
    const chosenRoute: RouteHint =
      routeHint !== 'auto' || routing.mode === 'refused' || routing.assigned.length === 0
        ? routeHint
        : routing.assigned[0].local
          ? 'local'
          : 'cloud'
    const chosenImage = image ? { path: image.path, name: image.name } : undefined
    const chosenTarget = target
    const chosenTeamAgent = chosenAgent
    setDraft('')
    setAttachments([])
    setImage(null)
    setAttachError(null) // a stale attach error must not linger after a successful send
    setRouteHint('auto')
    // Back to the DEFAULT lane — the team (his order, 2026-08-30). The picker
    // still shows the choice on every message; the manager is one click.
    setTarget('team')
    setMoreTargetsOpen(false)
    setOverrideOpen(false)
    if (chosenTarget === 'team') {
      // The SHARED governed launch. `sendTeam` posts this ask, calls the ONE
      // `launchTeam` the Agents page also calls, and reports the real ending
      // (or the honest busy refusal) back into this chat. A team run has no
      // image path, so an attached image is reported as NOT sent rather than
      // silently dropped.
      void sendTeam({
        task: engineText,
        // `baseDisplay`, NOT `displayText`: the 🖼️ marker would put the image in
        // a message the team never received. The bubble shows only what was
        // actually sent; the caveat below says where the image went (nowhere).
        display: `→ team: ${baseDisplay}`,
        roster,
        caveat: chosenImage ? 'the attached image was not sent (a team run takes text only)' : undefined,
      })
      return
    }
    if (chosenTarget === 'staff' && staffProject) {
      // STAFF THIS PROJECT (2026-08-15 spec §"He staffs a project"). The same
      // propose→approve→create discipline as a single agent, at team scale: Sukh
      // is shown ONLY this project's recorded plan steps (the citable pool), ONLY
      // the AI that can really answer on this Mac, and ONLY the capabilities
      // Sukhdeep himself holds — so he cannot propose an invented need, a seat on
      // a dead provider, or a grant that could never be given. The reply's block
      // becomes a ROSTER on the desk; nothing is created here.
      void sendIntent(
        rosterCharter({
          projectName: staffProject.name,
          needs: staffNeeds,
          usableAI: seats.team.map((t) => t.token),
          userGrants: appRunCapabilities(settings),
          existingAgents: agents
            .filter((a) => a.assignedTo === staffProject.id)
            .map((a) => a.name),
        }),
        `→ staff “${staffProject.name}”`,
        chosenRoute,
        undefined,
        undefined,
        {
          projectId: staffProject.id,
          projectName: staffProject.name,
          needs: staffNeeds,
        },
      )
      return
    }
    if (chosenTarget === 'propose') {
      // The user asking for a new agent on Work (source (b)). A normal
      // companion send carrying the strict proposal brief; the raw request is
      // passed through as the 5th argument so the reply's block is recorded
      // with THIS message as its evidence, quoted verbatim on the desk. No
      // agent is created here, and the transcript says so.
      //
      // Attachments and an image RIDE ALONG like any other send: `engineText`
      // (file bodies included) goes into the brief and `chosenImage` is passed
      // through — this path used to send bare `text` with `undefined` for the
      // image AFTER the composer had already cleared them, so both were
      // silently dropped. The EVIDENCE stays the typed request (`text`): a file
      // body is not something the desk can quote back as the user's words.
      void sendIntent(
        proposeAgentBrief(engineText),
        `→ propose an agent: ${displayText}`,
        chosenRoute,
        chosenImage,
        text,
      )
      return
    }
    if (chosenTarget === 'agent' && chosenTeamAgent) {
      // A normal companion task carrying the agent's real identity — see
      // `agentTaskBrief`: the app has no per-agent runner, and both the brief
      // and the label on the card say exactly that. `sendIntent` (not `send`)
      // deliberately: an agent-addressed task must not be swallowed by an
      // active project interview.
      void sendIntent(
        agentTaskBrief(chosenTeamAgent, engineText),
        agentTaskDisplay(chosenTeamAgent, displayText),
        chosenRoute,
        chosenImage,
      )
      return
    }
    void send(engineText, displayText, chosenRoute, chosenImage)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // 📎 attach: native file picker → read as UTF-8 text (200 KB cap, Rust
  // side). Honest failure — an oversize/binary/unreadable pick never
  // silently drops; it surfaces "couldn't attach <name>" inline instead.
  const attachFile = async () => {
    setAttachError(null)
    setAttachBusy(true)
    try {
      const path = await pickFile('Choose a text/code/doc file to attach')
      if (!path) return // cancelled, or non-native (button is hidden there anyway)
      const name = path.split('/').pop() || path
      const text = await readTextFile(path)
      if (text === null) {
        setAttachError(`couldn't attach ${name} (too large or not text)`)
        return
      }
      setAttachments((prev) => [...prev, { name, text }])
    } finally {
      setAttachBusy(false)
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
    setAttachError(null) // clearing a slot also clears any stale "couldn't attach" error
  }

  // 🖼️ image attach: native file picker → read as a data URI (5 MB cap,
  // png/jpeg/gif/webp, Rust side) for the thumbnail preview. The PATH is what
  // the engine actually consumes on send (`--image`, re-read + validated there).
  // Honest failure — an oversize/unsupported/unreadable pick never silently
  // drops; it surfaces "couldn't attach <name>" inline, reusing attachError.
  const attachImage = async () => {
    setAttachError(null)
    setImageBusy(true)
    try {
      const path = await pickFile('Choose an image (png/jpeg/gif/webp) to attach')
      if (!path) return // cancelled, or non-native (button is hidden there anyway)
      const name = path.split('/').pop() || path
      const dataUri = await readImageBase64(path)
      if (dataUri === null) {
        setAttachError(`couldn't attach ${name} (too large or not a png/jpeg/gif/webp image)`)
        return
      }
      setImage({ path, name, dataUri })
    } finally {
      setImageBusy(false)
    }
  }

  const removeImage = () => setImage(null)

  // The Live agent card's ONE input: the run genuinely executing right now
  // (parked runs excluded, same as everything else that says "live") plus the
  // REAL per-agent model_call spans of that run. `liveSpans` is already [] when
  // 2+ runs are in flight, so a model is never named on the wrong card.
  const s = state.stats

  // Context meter (P2-4): how full the ACTIVE thread is, plus the compaction
  // levers it unlocks. Honest scope — this is conversation length, not a
  // per-call token claim.
  const meter = meterFor(activeMessages(state))
  const threadKey = activeThreadKey(state.activeProjectId)

  // ONE honest status line, not six KPI chips (2026-08-18). The strip used to
  // carry local% / cache% / eval / tokens / cost / Tier-1 — six numbers on the
  // page whose job is the conversation, each of them a headline Stats already
  // owns and explains. It now states the two facts that place the run history
  // (how many runs are recorded, and how much of the work stayed on this Mac)
  // and links to the page that owns the rest. Both come from the same measured
  // record the ledger reads, so the strip cannot disagree with the rail.
  const runsRecorded = state.verdicts.length
  const hasRuns = runsRecorded > 0
  const statusChip = hasRuns
    ? `${runsRecorded} run${runsRecorded === 1 ? '' : 's'} recorded all time · ${s.localSharePct}% ran on your Mac`
    : 'no runs yet — stats appear as you work'

  // Header status line — Desk.tsx has the shared useDeskState() hook so
  // header and rail compute identically and can never drift.
  const { items: deskItems, running: runningProject } = useDeskState()
  const status = statusLine(deskItems, runningProject)
  // The ambient desk (happening/health/catch-up) is collapsed by default so the
  // chat is the hero; the urgent "Needs you" decisions render separately, always
  // visible, so nothing that needs you is ever hidden behind the collapse.
  const [deskOpen, setDeskOpen] = useState(false)

  return (
    <div className="ws">
      {/* HEADER — the page names WHAT YOU ARE LOOKING AT (this chat, or the
          project you have open) and then, in one plain sentence beneath it,
          what is actually happening. A greeting used to sit here; it told the
          user nothing they could act on. The sentence is `statusLine`, the same
          measured desk state the rail reads, so the two can never disagree —
          and when nothing is running it SAYS nothing is running rather than
          leaving a confident-looking blank. */}
      <section className="ws__strip">
        <div className="ws__titlecol">
          <h1 className="ws__hello">
            {activeProject ? activeProject.name || '(untitled project)' : 'Manager'}
          </h1>
          <div className="ws__subtitle">
            {status || `${greeting(Date.now(), settings.yourName)} — nothing running right now`}
          </div>
        </div>
        <div className="ws__spacer" />
        <div className="ws__kpis mono">
          <span className="ws__kpi">{statusChip}</span>
          <Link to="/stats" className="ws__statslink mono">
            Stats ›
          </Link>
        </div>
      </section>

      <ConnectivityBanner conn={connectivity} />

      {/* Urgent parked decisions — always visible + compact, with inline actions. */}
      <div className="ws__needs">
        <Desk show="needs" />
      </div>

      {/* The ambient coworker desk (happening / health / catch-up) — collapsed by
          default so the chat is the hero; a slim toggle reveals it, height-bounded. */}
      <div className="ws__desk">
        <button
          type="button"
          className="ws__desktoggle"
          onClick={() => setDeskOpen((v) => !v)}
          aria-expanded={deskOpen}
        >
          <span className="ws__desklabel">Coworker desk</span>
          {/* No needs-count here. The toggle expands the AMBIENT slice
              (happening / health / catch-up) — repeating "1 thing needs your
              decision" on it promised the click would reveal the decision,
              which lives in the always-visible rail above. A label may only
              advertise what its own click shows. */}
          <span className="ws__desksummary mono">
            {deskOpen ? '' : 'happening now · health · catch-up'}
          </span>
          <span className="ws__deskchev">{deskOpen ? '▾' : '▸'}</span>
        </button>
        {deskOpen && (
          <div className="ws__deskbody">
            <Desk show="rest" />
          </div>
        )}
      </div>

      {/* main split */}
      <section className="ws__main">
        {/* left sidebar: switches between the Universal chat and each
            project's own chat session — no route change, setActiveProject
            just re-points this same page at a different thread (P1-1). */}
        <nav className="ws__nav" aria-label="Chats and projects">
          <button
            type="button"
            className={`ws__navitem ${!state.activeProjectId ? 'is-active' : ''}`}
            onClick={() => setActiveProject('')}
          >
            <span className="ws__navorb" />
            <span className="ws__navname">Manager</span>
          </button>
          <div className="ws__navlabel mono">Projects</div>
          {projects.length === 0 && <div className="ws__navempty mono">no projects yet</div>}
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`ws__navitem ${state.activeProjectId === p.id ? 'is-active' : ''}`}
              onClick={() => setActiveProject(p.id)}
            >
              <span className="ws__navname">{p.name || '(untitled)'}</span>
              <StatusChip status={p.status} />
            </button>
          ))}
          {isNative() &&
            (showNewForm ? (
              <NewProjectForm
                onDone={(p) => {
                  setShowNewForm(false)
                  setActiveProject(p.id)
                }}
              />
            ) : settings.projectWrites ? (
              <button type="button" className="ws__navnew" onClick={() => setShowNewForm(true)}>
                ＋ New project
              </button>
            ) : (
              // Companion grant denied: no fake affordance — say why + where.
              <div className="ws__navempty mono">projects off — grant file writes in Settings</div>
            ))}
        </nav>

        {/* CHAT COLUMN — region 2 of 3, and the hero. It does NOT scroll: it
            holds a bounded "what is running" stage and the chat card, and the
            chat card's message body is the one thing on this page that
            scrolls. (Until this fix the column itself was the scroller, with
            six page-shaped blocks stacked inside it — see Workspace.css.) */}
        <div className="ws__chatcol">
          {/* THE STAGE — what is running right now. Bounded and internally
              scrolling, and `:empty` when nothing is running, so an idle Work
              page gives the whole column to the conversation. */}
          <div className={'ws__stage' + (anyLive ? ' ws__stage--live' : '')}>
            {/* Live task cards — one per run the app has in flight, then the
                recent outcome rows of THIS SESSION (which is what
                state.finishedRuns is; the durable record is the ledger in the
                rail). A card glows ONLY because its run is in state.liveRuns. */}
            <LiveRunCards live={liveRuns} finished={state.finishedRuns} spans={tail.spans} />
            {/* THE BOARD (visual system v2): the crew cluster, the 🔒 badge and
                the pipeline of column stacks. It is handed `liveSpans` — i.e.
                `currentRunSpans`, which is [] whenever 2+ runs are in flight —
                so it can never cross-attribute one run's crew to another, and
                it renders NOTHING when there is no crew. `liveRuns` is passed
                only so a run genuinely parked on a human answer can raise a
                "Your call" column; `anyLive` (activeRuns) is the sole liveness
                signal, so a parked run's monogram cannot glow.
                `renderStageDetail` is the engine console's new home: the `▸` on
                a column opens THAT step's real spans, and nothing else. */}
            <CrewBoard
              spans={boardSpans}
              live={anyLive}
              runs={liveRuns}
              renderStageDetail={(stage: PipelineStage) => (
                <EngineConsole
                  label={stage.label}
                  spans={stageSpans(boardSpans, stage.key)}
                  live={anyLive}
                  vaultPath={settings.vaultPath}
                />
              )}
            />
            {/* THE CREW STAYS ON SCREEN AFTER THE RUN. Nothing is claimed to be
                happening — `live` is false above, so no monogram pulses — this
                simply says who really did the last piece of work, which the
                page used to forget the moment the run ended. */}
            {!anyLive && showsLastCrew && (
              <div className="ws__lastcrew mono">
                the last team run · nothing is running now
              </div>
            )}
          </div>
        <div className="chat">
          <div className="chat__tabs">
            <span className="chat__tab is-active">Chat</span>
            <Link to="/editor" className="chat__tab">Editor</Link>
            <span className="chat__spacer" />
            {activeProject && (
              <button
                type="button"
                className="chat__tab chat__tab--details"
                aria-expanded={railVisible}
                onClick={() =>
                  setRailChoice(railVisible ? 'closed' : 'open')
                }
              >
                {railVisible ? 'details ◂' : 'details ▸'}
              </button>
            )}
            {state.verdicts[0] && (
              <Link to="/verdict" className="chat__task mono">
                last result ›
              </Link>
            )}
          </div>

          <div className="chat__body" ref={bodyRef}>
            {activeMessages(state).length === 0 && !state.running && (
              activeProject && nextSendMode(activeProject) === 'project-interview' ? (
                <div className="chat__empty mono">
                  <button type="button" className="chat__begin" onClick={() => void send('')}>
                    Begin interview →
                  </button>
                  <div className="chat__beginhint">a few questions about “{activeProject.name}”, then a plan</div>
                </div>
              ) : (
                <div className="chat__empty mono">
                  {activeProject
                    ? `“${activeProject.name}” — describe the next step and ${primaryName} takes it from there`
                    : `no messages yet — describe what you want to build below and ${primaryName} takes it from there`}
                </div>
              )
            )}
            {collapseRepeats(activeMessages(state)).map((m) => {
              if (m.kind === 'user') {
                return (
                  <UserBubble
                    key={m.id}
                    text={m.text}
                    onRetry={
                      state.running
                        ? undefined
                        : (t) => {
                            // ↺ resends through the DEFAULT lane (the team —
                            // the manager staffs it), exactly like typing it
                            // again; disabled while a run holds the engine.
                            void sendTeam({ task: t, display: `→ team: ${t}` })
                          }
                    }
                    onBranch={
                      state.running
                        ? undefined
                        : (t) => {
                            // ⋔ a fresh session on THIS thread with the
                            // message pre-filled — a new path from the same
                            // start; nothing sends until the user sends.
                            void newSession(activeThreadKey(state.activeProjectId))
                            setDraft(t)
                          }
                    }
                  />
                )
              }
              if (m.kind === 'assistant') {
                const bubble = (
                  <div className="msg__bubble">
                    {m.text ? (
                      <span className="msg__stream">{renderChatMarkdown(m.text)}</span>
                    ) : (
                      <span className="msg__typing mono">{thinkingLabel}</span>
                    )}
                    {m.text && <CopyButton text={m.text} />}
                  </div>
                )
                // Attribution chip (multi-model chat) — only when the engine
                // reported a REAL model for this reply. No meta → no chip, and
                // the bubble renders exactly as before (byte-identical). The
                // chip names ONLY what the Verdict carried: the real model, the
                // honest route reason, and 🔒 when it stayed local. Nothing
                // fabricated. A non-real (offline/stub) completion never reaches
                // here — it is surfaced as an honest error card, not a bubble.
                if (!m.model) {
                  return (
                    <div key={m.id} className="msg msg--ai">
                      {/* No model was recorded for this turn, so the disc stays
                          IDLE grey rather than borrowing a colour it can't
                          justify. */}
                      <span className="msg__orb" aria-hidden />
                      {bubble}
                    </div>
                  )
                }
                return (
                  <div key={m.id} className="msg msg--ai">
                    {/* The disc carries the colour of the model that REALLY
                        answered — the same hue the attribution chip below uses,
                        so the thread is colour-coded by who did the work. */}
                    {/* The disc carries the PROVIDER'S INITIAL, like every
                        other coworker mark in the app — the board's monograms,
                        the rail's crew, the dossier's header. It was styled to
                        hold a letter (see .msg__orb) and never given one, so
                        chat was the one place an AI was a blank circle.
                        aria-hidden stays: the attribution line below names the
                        model in words, so the letter is decoration there. */}
                    <span
                      className="msg__orb"
                      style={{ ['--orbc' as string]: modelColor(m.model) }}
                      title={m.model}
                      aria-hidden
                    >
                      {providerInitial(m.model)}
                    </span>
                    <div className="msg__aicol">
                      {bubble}
                      <div className="msg__attrib mono">
                        {m.isLocal && (
                          <span className="msg__attriblock" title="kept on your machine">
                            🔒
                          </span>
                        )}
                        <span
                          className="msg__attribdot"
                          style={{ background: modelColor(m.model) }}
                        />
                        <span className="msg__attribmodel">{m.model}</span>
                        {m.routeReason && (
                          <span className="msg__attribreason">· {m.routeReason}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              }
              if (m.kind === 'error') {
                return (
                  <ErrorMessageCard
                    key={m.id}
                    text={m.text}
                    busy={retryBusyId === m.id}
                    onRetry={() => void retryError(m)}
                  />
                )
              }
              if (m.kind === 'divider') {
                return <div key={m.id} className="msg msg--divider mono">{m.text}</div>
              }
              // The APP speaking — a launch this composer started reporting
              // itself: the busy refusal, a timeout, or a finished team run's
              // REAL outcome. Never an AI bubble (no model said it) and no
              // Retry (its retry would send to the wrong runner).
              if (m.kind === 'notice') {
                return (
                  <div key={m.id} className="msg msg--notice mono" role="status">
                    {m.text}
                    {(m as { repeats?: number }).repeats && (m as { repeats?: number }).repeats! > 1 && (
                      <span className="msg__repeat" title="this exact line repeated — collapsed, every occurrence is still in the record">
                        ×{(m as { repeats?: number }).repeats}
                      </span>
                    )}
                  </div>
                )
              }
              if (m.kind === 'seat') {
                // ONE SEAT'S REAL BOARD CONTRIBUTION — its own bubble, its own
                // colored monogram, three-part attribution in the header.
                return (
                  <div key={m.id} className="msg msg--seat">
                    <span
                      className="msg__seatdot mono"
                      style={{ background: modelColor(m.provider || m.model) }}
                      aria-hidden="true"
                    >
                      {(m.agent[0] ?? '?').toUpperCase()}
                    </span>
                    <div className="msg__seatbody">
                      <div className="msg__seathead mono">
                        {m.agent} · {m.provider}
                        {m.model ? ` · ${m.model}` : ''}
                        {typeof (m as { round?: number }).round === 'number' &&
                          (m as { round?: number }).round! > 0 && (
                            <span className="msg__seatround">
                              {' '}
                              · turn {(m as { round?: number }).round} → to the board, read by
                              every seat
                            </span>
                          )}
                      </div>
                      <div className="msg__stream">{renderChatMarkdown(m.text)}</div>
                    </div>
                  </div>
                )
              }
              return <VerdictCard key={m.id} v={toVerdictView(m.verdict)} />
            })}

            {/* THE ROOM'S LIVE STREAM (project-room spec): while a run is
                live the chat itself scrolls the crew's real actions — same
                spans, same renderer as the stage. Disappears when the run
                ends; the verdict card is the durable record. */}
            {anyLive && <ChatRunStream spans={liveSpans} />}

            {/* Plain-English narration (Mission Control §Plain-English
                narration): ONE line per REAL span of the run in flight, so the
                user follows along without opening a trace. Every line comes
                from `narrateSpan`, which interpolates only what the span's
                attrs actually carry — a missing attr yields a generic honest
                phrase, never an invented model or agent. With no spans yet we
                say exactly that instead of narrating something that hasn't
                happened. The block is gated on `anyLive`, so it disappears the
                moment the last live run clears. */}
            {anyLive && (
              <div className="chat__earlier chat__earlier--narrate">
                <i className="dot dot--ok" />
                <div className="chat__narration">
                  {executing.length > 1 ? (
                    /* 2+ runs are executing. Every span in the file could
                       belong to either, so this strip narrates NEITHER — it
                       says so and points at the cards, which are per-run and
                       stay honest. It used to silently mix the two. */
                    <span className="mono">
                      {executing.length} runs in flight — their steps can&rsquo;t be told apart; see
                      the task cards above
                    </span>
                  ) : narration.length > 0 ? (
                    narration.map((l) => (
                      <div key={l.key} className="chat__narrateline mono">
                        {l.text}
                      </div>
                    ))
                  ) : (
                    // The simulator's live-agent line used to be preferred here;
                    // it could only ever be empty on a native install, so the
                    // honest fallback is the only line left.
                    <span className="mono">working — no engine step reported yet</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {(attachments.length > 0 || image || attachError) && (
            <div className="chat__attachments">
              {attachments.map((a, i) => (
                <span key={`${a.name}-${i}`} className="chat__attachchip mono">
                  📎 {a.name}
                  <button
                    type="button"
                    className="chat__attachremove"
                    onClick={() => removeAttachment(i)}
                    aria-label={`Remove attached file ${a.name}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {image && (
                <span className="chat__imagechip mono">
                  <img className="chat__imagethumb" src={image.dataUri} alt={`Attached image ${image.name}`} />
                  <span className="chat__imagename">{image.name}</span>
                  <button
                    type="button"
                    className="chat__attachremove"
                    onClick={removeImage}
                    aria-label={`Remove attached image ${image.name}`}
                  >
                    ✕
                  </button>
                </span>
              )}
              {/* Honesty: when the primary can't see images, say so plainly — the
                  model will be TOLD an image was attached, never shown a fake one. */}
              {image && !visionCapable && (
                <span className="chat__imagenote mono">
                  this model can't see images — it'll be told an image was attached
                </span>
              )}
              {attachError && <span className="chat__attacherror mono">{attachError}</span>}
            </div>
          )}

          {activeMessages(state).length > 0 && (
            <div className="chat__meter">
              <div
                className="chat__meterbar"
                role="img"
                aria-label={`this thread is ${meter.pct}% of its context budget`}
              >
                <div className={`chat__meterfill chat__meterfill--${meter.level}`} style={{ width: `${meter.pct}%` }} />
              </div>
              {/* P10: scoped label — this is the app's per-THREAD budget, not a
                  model's context window (the old "context %" implied the latter). */}
              <span
                className="chat__metertext mono"
                title="How full this thread is against the app's per-thread budget — not a model's context window."
              >
                memory {meter.pct}% full
              </span>
              {meter.offerCompact && (
                <button
                  type="button"
                  className="chat__compress"
                  onClick={() => void compressNow()}
                  disabled={state.running}
                  title="Summarize older turns and save the full text to your vault"
                >
                  Compress now
                </button>
              )}
              {confirmNewSession ? (
                <span className="chat__confirm">
                  <span
                    className="chat__confirmq mono"
                    title="The current conversation is saved to your vault, then cleared here."
                  >
                    New session? saved to vault
                  </span>
                  <button
                    type="button"
                    className="chat__newsession chat__confirmyes"
                    onClick={() => {
                      void newSession(threadKey)
                      setConfirmNewSession(false)
                    }}
                    disabled={state.running}
                  >
                    confirm
                  </button>
                  <button
                    type="button"
                    className="chat__newsession"
                    onClick={() => setConfirmNewSession(false)}
                  >
                    cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="chat__newsession"
                  onClick={() => setConfirmNewSession(true)}
                  disabled={state.running}
                >
                  New session
                </button>
              )}
            </div>
          )}

          {/* The chosen target's own controls (Mission Control §Give a task
              from Work). Only real values: the roles field is seeded from the
              providers actually connected and is what the run really gets; the
              agent list is the REAL library. The hints state plainly what each
              target does — a team run is a full engine run, and an agent is a
              brief on the companion, not a separate model. */}
          {target !== 'companion' && (
            <div className="chat__targetbar">
              {target === 'propose' ? (
                <>
                  <span className="chat__targethint mono">
                    you get a PROPOSAL to review under &ldquo;Needs you&rdquo; — nothing is added to
                    your agents until you tap Create
                  </span>
                  {!proposalCanRun && (
                    <span className="chat__targethint chat__targethint--warn mono">
                      no real AI is connected — this send is simulated, so no proposal will be
                      recorded
                    </span>
                  )}
                </>
              ) : target === 'team' ? (
                <>
                  <span className="chat__targethint mono">
                    your manager staffs the team — who really worked shows in the run, seat by
                    seat
                  </span>
                  {teamSitOut && (
                    <span className="chat__targethint chat__targethint--warn mono">
                      {teamSitOut}
                    </span>
                  )}
                  {image && (
                    <span className="chat__targethint chat__targethint--warn mono">
                      a team run takes text only — the attached image won&rsquo;t be sent
                    </span>
                  )}
                </>
              ) : (
                chosenAgent && (
                  <>
                    <span className="chat__targetlabel mono">agent</span>
                    <select
                      className="chat__agentpick mono"
                      aria-label="Agent for this task"
                      value={chosenAgent.id}
                      onChange={(e) => setAgentId(e.target.value)}
                    >
                      {libraryAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.role ? ` · ${a.role}` : ''}
                        </option>
                      ))}
                    </select>
                    <span className="chat__targethint mono">
                      briefed on your primary AI — the app has no per-agent runner, so this is{' '}
                      {chosenAgent.name}&rsquo;s role in the brief, not a separate model
                    </span>
                  </>
                )
              )}
            </div>
          )}

          {/* Two ROWS, not one (2026-08-11 acceptance walk, A2): the text field
              owns a full-width row of its own, and every control sits on a
              second, wrapping row beneath it. As a single row the textarea had
              to share its width with the attach buttons, the hint, the 4-option
              target selector and the 3-option route control — with the target
              selector added (78621de) it collapsed to a ~40px column and the
              placeholder wrapped one word-fragment per line. Same controls, same
              aria-labels, same behaviour; only the boxes moved. */}
          {/* SUKH'S CHOICE, and its reason — before the send, never after.
              Rendered only once there is something to decide about: an empty
              composer has no job to route, and a pick with no job would be a
              claim about nothing. */}
          {draft.trim() !== '' && (
            <div
              className={
                'chat__routing mono' + (routing.floor ? ' chat__routing--floor' : '')
              }
              aria-label="Who takes this, and why"
            >
              {routingLine(routing)}
              {routing.soloNote && routing.mode !== 'refused' && (
                <span className="chat__routingnote"> · {routing.soloNote}</span>
              )}
              {routeHint !== 'auto' && (
                <span className="chat__routingnote">
                  {' '}
                  · you overrode this to {routeHint}, so that is where it goes
                </span>
              )}
            </div>
          )}
          <div className="chat__composer">
            {/* Typing stays ENABLED while a task runs — only sending waits. */}
            <textarea
              ref={inputRef}
              className="chat__input"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                state.running
                  ? `${thinkingLabel} — type your next message meanwhile`
                  : `${composerLabel}…`
              }
              aria-label={composerLabel}
            />
            <div className="chat__controls">
              {isNative() && (
                <button
                  type="button"
                  className="chat__attachbtn"
                  onClick={() => void attachFile()}
                  disabled={attachBusy}
                  aria-label="Attach a text/code/doc file"
                  title="Attach a text/code/doc file — its contents reach the AI"
                >
                  <Icon name="attach" size={17} />
                </button>
              )}
              {isNative() && (
                <button
                  type="button"
                  className="chat__attachbtn"
                  onClick={() => void attachImage()}
                  disabled={imageBusy || !!image}
                  aria-label="Attach an image"
                  title={
                    visionCapable
                      ? 'Attach an image (png/jpeg/gif/webp) — your model can see it'
                      : "Attach an image — this model can't see it, but it'll be told one was attached"
                  }
                >
                  <Icon name="image" size={17} />
                </button>
              )}
              {/* THE OVERRIDE, behind ONE control (2026-08-18). Seven pills —
                  five targets and three routes — used to sit on this row at all
                  times, so the composer's loudest feature was a choice the user
                  almost never changes (both controls reset after every send by
                  design). The DEFAULT is now stated in words beside the send
                  button, and the pills live in this panel, opened deliberately.
                  Nothing about the controls themselves changed: same options,
                  same aria-labels, same titles, same per-message reset. */}
              {overrideOpen && (
                <div className="chat__override">
                {/* WHO does this task. Same segmented idiom as the route control it
                    sits beside (literally the same classes), because it is the same
                    kind of per-message choice. Every option is real: the companion
                    is the default path, `team` is the shared governed launch, and
                    `agent` is disabled — with the reason — when the library has
                    nobody enabled to address. */}
                <div
                  className="chat__route chat__target"
                  role="radiogroup"
                  aria-label="Who does this task"
                  title="Who gets this task. Applies to the next message, then resets to your companion — a team run costs real minutes and tokens."
                >
                  <span className="chat__routelabel mono">to</span>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={target === 'companion'}
                    className={'chat__routebtn mono' + (target === 'companion' ? ' chat__routebtn--on' : '')}
                    onClick={() => setTarget('companion')}
                    title={`${primaryName} answers in this chat — the normal path`}
                  >
                    {primaryName}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={target === 'team'}
                    className={'chat__routebtn mono' + (target === 'team' ? ' chat__routebtn--on' : '')}
                    onClick={() => setTarget('team')}
                    title="A real multi-agent team run — each role on its own model, one engine run, refused honestly if another run holds the engine"
                  >
                    team
                  </button>
                  {!moreTargetsOpen && !['agent', 'propose', 'staff'].includes(target) ? (
                    <button
                      type="button"
                      className="chat__routebtn mono"
                      onClick={() => setMoreTargetsOpen(true)}
                      title="more ways to hand this off: one library agent, propose a new agent, staff a project"
                    >
                      more ▾
                    </button>
                  ) : (
                    <>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={target === 'agent'}
                    disabled={libraryAgents.length === 0}
                    className={'chat__routebtn mono' + (target === 'agent' ? ' chat__routebtn--on' : '')}
                    onClick={() => setTarget('agent')}
                    title={
                      libraryAgents.length === 0
                        ? 'no enabled agents in your library — add one on the Agents page'
                        : "one agent from your library, briefed on your primary AI (there is no per-agent runner yet)"
                    }
                  >
                    agent
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={target === 'propose'}
                    className={'chat__routebtn mono' + (target === 'propose' ? ' chat__routebtn--on' : '')}
                    onClick={() => setTarget('propose')}
                    title="Ask for a NEW agent. You get a proposal on your desk citing this request — nothing is created until you tap Create."
                  >
                    new agent
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={target === 'staff'}
                    disabled={!canStaff}
                    className={'chat__routebtn mono' + (target === 'staff' ? ' chat__routebtn--on' : '')}
                    onClick={() => setTarget('staff')}
                    title={
                      !staffProject
                        ? 'open a project first — a roster is staffed against ONE project'
                        : staffNeeds.length === 0
                          ? `“${staffProject.name}” has no plan yet, so there are no real needs to staff against`
                          : `Ask ${companionName} to staff “${staffProject.name}”: the roles it actually needs, which AI each runs on, and what each may touch. One approval creates them all.`
                    }
                  >
                    staff project
                  </button>
                    </>
                  )}
                </div>
                {/* Per-message route control (P-routehint): auto lets the gateway
                    decide; local/cloud request this ONE message's route. Sensitive
                    content always stays local regardless — the reply's chip shows
                    where it actually went. */}
                <div
                  className="chat__route"
                  role="radiogroup"
                  aria-label="Route for this message"
                  title="Where this message runs. Sensitive content always stays local — whatever you pick. Applies to the next message, then resets to auto."
                >
                  <span className="chat__routelabel mono">route</span>
                  {(['auto', 'local', 'cloud'] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={routeHint === opt}
                      className={'chat__routebtn mono' + (routeHint === opt ? ' chat__routebtn--on' : '')}
                      onClick={() => setRouteHint(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                </div>
              )}
              <div className="chat__controlgroup">
                {/* v2 composer: the sentence naming WHO this send goes to. It
                    reports the target really selected — nothing is predicted,
                    and the routing line above adds the reason the moment there
                    is a job to route. */}
                <span className="chat__whohint mono">{targetSentence}</span>
                <button
                  type="button"
                  className={'chat__override-btn mono' + (overrideOpen ? ' is-open' : '')}
                  aria-expanded={overrideOpen}
                  aria-label="Change who takes this, and where it runs"
                  title="Pick a different coworker, or force this one message local or cloud. Both reset after the send."
                  onClick={() => setOverrideOpen((v) => !v)}
                >
                  Change {overrideOpen ? '▾' : '▸'}
                </button>
                <span className="chat__hint mono">Enter to send</span>
                <button
                  type="button"
                  className="chat__send"
                  onClick={submit}
                  disabled={state.running || !canSend}
                  aria-label="Send"
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        </div>

        </div>

        {/* RIGHT RAIL — region 3 of 3, app-height with its own scroll.
            With a project bound to this session it is that project's own
            context (P1-3b) — the SAME live panels as the Projects page's
            detail view, so there is one body, not a duplicate. On the
            Universal thread it is the measured ledger, which used to be
            stacked UNDER the conversation and is the reason the page grew
            without end. "Up next" and "Your setup" are not here and are not
            anywhere on Work any more: the queue lives on Automations (parked
            approvals, due jobs, standing loops — all of it, with more detail)
            and the setup lives on Settings. Both are one click away in More. */}
        {activeProject && railVisible && (
        <aside className="ws__side ws__side--project">
            <>
              <div className="ws__railhead">
                <div className="ws__railname">{activeProject.name || '(untitled)'}</div>
                <StatusChip status={activeProject.status} />
                {confirmDeleteProject ? (
                  <span className="ws__raildelconfirm">
                    <span className="ws__raildelq mono" title="This cannot be undone.">
                      Delete “{activeProject.name}”?
                    </span>
                    <button
                      type="button"
                      className="ws__raildelyes"
                      aria-label={`Confirm delete ${activeProject.name}`}
                      onClick={() => {
                        removeProject(activeProject.id)
                        setActiveProject('')
                        setConfirmDeleteProject(false)
                      }}
                    >
                      confirm
                    </button>
                    <button
                      type="button"
                      className="ws__raildelno"
                      aria-label="Cancel deleting project"
                      onClick={() => setConfirmDeleteProject(false)}
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ws__raildelete"
                    aria-label={`Delete ${activeProject.name}`}
                    title="Delete this project"
                    onClick={() => setConfirmDeleteProject(true)}
                  >
                    ✕
                  </button>
                )}
              </div>
              {activeProject.goal && <div className="ws__railgoal mono">{activeProject.goal}</div>}
              {/* NO TEAM ORBS HERE (2026-08-30 — Sukhdeep, comparing his two
                  screenshots: "the information you show on the sidebar is kind
                  of similar to Who's on it — remove that and utilize the
                  sidebar somewhere else"). He is right: during a run the crew
                  lives on the STAGE — the ON-IT-NOW chips + the Who's-on-it
                  board — and a third copy in the rail said the same thing,
                  smaller. The rail now spends that space on what the stage
                  does NOT show: the plan's step-by-step progress below. */}
              <ProjectContextPanel project={activeProject} />
              <LiveActivity project={activeProject} />
            </>
        </aside>
        )}
      </section>

      {/* THE EVIDENCE ROW — full width, under the work, the shape Sukhdeep's
          design note asks for: Recent runs beside This week, both reading the
          SAME persisted verdicts (rule 7) so they can never contradict each
          other — which is exactly what they did while one read the
          session-only finishedRuns.

          It used to live in the 320px right rail, where the two panels had to
          stack and the run list scrolled inside itself behind a scrollbar
          nobody knew was there. Given the page's width it lays itself out as a
          row instead (a container query in RunLedger.css — the component reads
          the box it is actually in, not the window). It takes its natural
          height and never grows: the conversation above absorbs the slack, so
          this cannot make Work taller than the window again, which is why it
          was banished to the rail the first time.

          Only on the Universal thread. With a project bound to the session the
          rail is already that project's own context, and its runs belong to
          it rather than to the whole app. */}
      {!activeProject && (
        <section className="ws__evidence" aria-label="Your measured run history">
          <RunLedger
            verdicts={state.verdicts}
            layout="row"
          />
        </section>
      )}
    </div>
  )
}
