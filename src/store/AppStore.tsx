// SC Prism — global app store (React Context + useReducer).
// Holds chat messages, produced verdicts, the live agent(s), and running stats.
// sendIntent drives the simulated engine and dispatches its streamed events.

import { clampBudget } from '../lib/budget'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { runTask } from '../engine/simEngine'
import type { EngineEvent, Verdict } from '../engine/types'
import {
  appendChatNote,
  cancelEngineRun,
  ensureToolPolicyMigrated,
  expandUserPath,
  isNative,
  newRunId,
  resolveVaultDir,
  runNativeProject,
  runNativeProjectFinish,
  runNativeProjectMerge,
  runNativeTask,
  runNativeTeam,
  runNativeVerify,
  storeGet,
  listenNative,
} from '../lib/nativeEngine'
import { teamSalvageLine } from '../lib/teamSalvage'
import { isDown, useConnectivity } from '../lib/connectivity'
// THE shared tool_call guard. Every surface in this file that shows a raw
// model completion runs its text through it — see answerText.ts for why.
import { guardAnswerText, incompleteReason, isIncompleteInvestigation } from '../lib/answerText'
import {
  FINISHED_RUN_CAP,
  activeRuns,
  shortIntent,
  type FinishedRun,
  type LiveRun,
  type LiveRunKind,
  type RunOutcome,
} from '../lib/liveRuns'
import { PRIORITY_LABEL, SIGNOFFS, getInterview } from '../lib/interview'
import { list as listSkills } from '../lib/skills'
import { narrateRun } from '../lib/narrate'
import {
  COMPANION_MANAGER_ID,
  beatDue,
  beatLineWithNote,
  defaultTeamRoster,
  dueJobs,
  ensureSeeded,
  getManagers,
  jobKind,
  ladderBrief,
  managerDisplayName,
  nextDispatchAction,
  parkJob,
  parseWakeReply,
  recordJobRun,
  recordManagerBeat,
  recordManagerRest,
  recordManagerSkip,
  setHeartbeatPrint,
  wakeFingerprint,
  REST_REANCHOR_MS,
  shouldSkipWake,
  trimReport,
  useManagers,
  wakeNowBlockReason,
  recordDriverTick,
} from '../lib/managers'
import type { Heartbeat, Manager, ManagerJob } from '../lib/managers'
import {
  appendVaultNote,
  lastEngineProjectError,
  listVaultTreeMeta,
  readPowerState,
  readSpansTail,
  readVaultFile,
  writeVaultNote,
} from '../lib/nativeEngine'
// Measured run budgets + the honest words for a run that ended without an
// answer (2026-08-16). See `runBudget` for why the flat 90s interview wall had
// to go and why our own cancellation must never be reported as a dead provider.
import {
  UNREACHABLE_DETAIL,
  cancelledDetail,
  isLoadFailure,
  latencyFromSpans,
  lastStepFromSpans,
  loadFailedDetail,
  loadFailedText,
  stubDetail,
  turnBudget,
  CEILING_STALLS,
  UNATTENDED_CEILING_MS,
  weStoppedIt,
  type TurnBudget,
} from '../lib/runBudget'
import {
  ask as askBusinessQuestions,
  askBlockedReason,
  askCharter,
  askedQuestions,
  contextThin,
  list as listQuestionSets,
  parseAskBlock,
  persistQuestionsToVault,
  readBusinessContext,
  stripAskBlock,
} from '../lib/businessInterview'
import { configureTelegram, notifyManagerReport, notifyNotice } from '../lib/telegramNotify'
import { configureTelegramApprovals } from '../lib/telegramApprovals'
import { agentNameKey, agentSlug, list as listAgents } from '../lib/agents'
import {
  blockedReason as proposalBlockedReason,
  hydrateProposalsFromVault,
  parseProposalBlock,
  persistProposalsToVault,
  propose as proposeAgent,
  proposalCharter,
  proposalEvidencePool,
  stripProposalBlock,
} from '../lib/agentProposals'
import {
  appendTurn,
  getProjects,
  nextSendMode,
  projectBuildRoster,
  staffRoster,
  unstaffedRefusal,
  updateProject,
  useProjects,
} from '../lib/projects'
import type { Project, ProjectTurn } from '../lib/projects'
import { runInterviewTurn } from '../lib/projectInterview'
import { getSchedules, recordRun as recordScheduleRun, scheduleKind } from '../lib/schedules'
import type { Schedule, ScheduleKind } from '../lib/schedules'
import {
  DEFAULT_MAX_REFINES,
  mergeReadiness,
  nextRunAction,
  refineIntent,
  stepIntent,
  stepNote,
  verdictFeedback,
} from '../lib/projectRun'
import type { RunAction } from '../lib/projectRun'
import { neverTouchGlobs } from '../lib/neverTouch'
import {
  canCompact,
  compactionArchiveMarkdown,
  shouldDrop,
  splitForCompaction,
  structuralSummary,
  summaryMessage,
  summaryPromptFor,
} from '../lib/compaction'
import { meterFor } from '../lib/contextMeter'
import {
  effectiveRoute,
  isCliProvider,
  isCustomProvider,
  normalizeProviderBase,
  providerUsable,
  useSettings,
  type ProviderConfig,
  type ProviderStatus,
  type Settings,
} from '../lib/settings'
import { seatMessagesFromBoard } from '../lib/seatMessages'
import {
  allowAllProviders,
  emptyRosterRefusal,
  filterRoster,
  rosterGate,
  sitOutLine,
  splitRoster,
  type ProviderHealthMap,
  type SitOut,
  reassignLine,
  type Reassigned,
} from '../lib/roster'
import { agentCapabilityNames,
  appRunCapabilities,
  teamCapabilityArgs,
} from '../lib/delegation'
import {
  blockedReason as rosterBlockedReason,
  parseRosterBlock,
  persistRostersToVault,
  propose as proposeRoster,
  type RosterEvidence,
} from '../lib/projectRoster'
import type { EngineImage, EngineProviders, TeamResult } from '../lib/nativeEngine'
import { stageLabelForStep } from '../lib/pipeline'

// A chat entry: a typed intent, a streaming assistant reply, or a produced Verdict.
export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  // Per-message model attribution (multi-model chat, 2026-07-23): the OPTIONAL
  // meta surfaces the engine's REAL per-message routing in the chat — the model
  // that actually answered, the honest route reason, and whether it stayed
  // local. All optional so every existing + persisted assistant message stays
  // valid (back-compat); set ONLY from the real Verdict (`SET_MESSAGE_MODEL`),
  // NEVER fabricated. No meta → no chip. The gateway stays the sole router;
  // this only presents it. (A non-real completion never reaches this meta: the
  // live `sendIntent` flow routes an offline/stub verdict to an honest error
  // card, not an attributed bubble — see the `· stub` reconciliation, H3.)
  | {
      id: string
      kind: 'assistant'
      text: string
      model?: string // the REAL "provider · model" that answered
      routeReason?: string // the honest route reason (routeReasonLabel output)
      isLocal?: boolean // routed to a local model (kept on-device)
    }
  | { id: string; kind: 'verdict'; verdict: Verdict }
  // An honest failure: the send was blocked/failed, nothing real was produced.
  // `intent` keeps the original text so Retry can resend it.
  | { id: string; kind: 'error'; text: string; intent: string; providerId: string }
  // A transcript divider (Slice 1d) — inserted when the Workspace's active
  // project changes, so a running conversation doesn't read as confusingly
  // mixing two projects' context. No behavior, no retry — display only.
  | { id: string; kind: 'divider'; text: string }
  // The APP speaking in the transcript — never an AI, never a model claim
  // (Mission Control §Give a task from Work). This is how a launch the user
  // started from the composer reports itself honestly: the busy refusal, a
  // timeout, or a finished team run's real outcome + board path. Deliberately
  // NOT an `error` card (its Retry resends to the COMPANION, which would be the
  // wrong runner) and NOT an `assistant` bubble (no model said it).
  | { id: string; kind: 'notice'; text: string }
  // ONE SEAT'S REAL BOARD CONTRIBUTION (standing loop, 2026-08-29: "multiple
  // AIs in the same chat with multiple agents"). Emitted only from the
  // persisted board JSONL — the audited a2a record — and only for is_real
  // turns; a stub never gets a bubble. agent/provider/model are the engine's
  // own attribution, never invented client-side.
  | { id: string; kind: 'seat'; agent: string; provider: string; model: string; text: string; round?: number }

// ---------- unified chat threads keyed per scope ----------
//
// The chat is split into one thread per "scope": a single `'universal'` thread
// (the global chat, the default when no project is bound) plus one thread per
// project id. `state.threads` maps a scope key → that scope's messages. These
// helpers are the ONLY sanctioned way to read/route messages, so later tasks
// depend on their exact names/signatures.

// The scope key for the always-present global thread.
export const UNIVERSAL = 'universal'

// The active thread key: a bound project id, else the universal thread. An
// unset or empty activeProjectId means "no project bound" → universal.
export function activeThreadKey(activeProjectId?: string): string {
  return activeProjectId && activeProjectId.length > 0 ? activeProjectId : UNIVERSAL
}

// The messages for one scope key — [] when that thread doesn't exist yet.
export function threadFor(threads: Record<string, ChatMessage[]>, key: string): ChatMessage[] {
  return threads[key] ?? []
}

/**
 * Sprint A (2026-08-30): consecutive app-voice notices with identical text
 * collapse to ONE entry carrying a repeat count — his screenshot showed the
 * same step notice three times in a row. Pure view fold: the stored thread
 * keeps every record; only what renders is grouped, and only EXACT
 * consecutive duplicates group (a different line breaks the run).
 */
export function collapseRepeats(msgs: ChatMessage[]): (ChatMessage & { repeats?: number })[] {
  const out: (ChatMessage & { repeats?: number })[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (
      prev &&
      m.kind === 'notice' &&
      prev.kind === 'notice' &&
      prev.text === m.text
    ) {
      prev.repeats = (prev.repeats ?? 1) + 1
      continue
    }
    out.push({ ...m })
  }
  return out
}

// The messages the Workspace should currently show — the active thread's.
export function activeMessages(state: AppState): ChatMessage[] {
  return threadFor(state.threads, activeThreadKey(state.activeProjectId))
}

// Map a project interview turn to a chat message. `idx` makes a stable id so a
// re-seed of the same transcript reproduces the same message ids.
export function projectTurnToMessage(projectId: string, t: ProjectTurn, idx: number): ChatMessage {
  return { id: `t-${projectId}-${idx}`, kind: t.role === 'user' ? 'user' : 'assistant', text: t.text }
}

export interface Stats {
  tokensToday: number
  costToday: number
  tier1Saves: number
  localSharePct: number
  evalAvg: number
}

// A one-line alert surfaced on the Companion orb for a project run outcome —
// 'done'/'attention' from a finished run, 'request' while the driver is
// parked awaiting the yes/no extra-refine handshake. `id` is unique per
// notice (a project can accumulate more than one over time) so CLEAR_NOTICE
// can dismiss exactly one.
export interface Notice {
  id: string
  /** The subject this notice is about: a project id, or (2026-08-16 Finding 2)
   *  a manager JOB id for a finished standing job. Job ids ('job-…') and
   *  project ids ('proj-…') can't collide, and the project surfaces match on
   *  their own ids, so a job notice can never be mistaken for a project's. */
  projectId: string
  text: string
  kind: 'done' | 'attention' | 'request'
  /** Where "View →" should go. Defaults to the notice's own PROJECT; a
   *  non-project notice (a finished manager job) sets it explicitly so the
   *  jump lands somewhere that really shows the thing it is about. */
  to?: string
}

/**
 * The most recent notice of a given kind for one project. Notices accumulate
 * (nothing removes them but an explicit CLEAR_NOTICE), so a reversed scan is
 * required — the first match forward would surface a stale earlier ask/result
 * instead of the current one. Pure so it's unit-testable without the store.
 */
export function latestNotice(
  notices: Notice[],
  projectId: string,
  kind: Notice['kind'],
): Notice | undefined {
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i]
    if (n.projectId === projectId && n.kind === kind) return n
  }
  return undefined
}

/**
 * The first OTHER project (not `projectId`) currently 'running', if any.
 * Used by the driver to refuse a concurrent start — without this check, a
 * second `runProject` call stomps the run-loop guard rails and strands the
 * FIRST project stuck in 'running' forever (nothing ever advances its
 * status again). Pure so it's unit-testable without the store.
 */
export function otherRunningProject(
  projects: readonly Project[],
  projectId: string,
): Project | undefined {
  return projects.find((p) => p.id !== projectId && p.status === 'running')
}

/**
 * An expanded project dir is only usable when it is an absolute POSIX path.
 * `expandUserPath` returns relative/empty input UNCHANGED (its job is only to
 * expand a leading `~`), so a relative `project.path` (or the unusable-tilde
 * `''` case) would otherwise reach the Rust bridge / Python engine as-is.
 * Pure so it's unit-testable without the store.
 */
export function isUsableProjectDir(expanded: string): boolean {
  return expanded.startsWith('/')
}

/**
 * The first schedule the app-level loop driver (P2-3) should run this tick,
 * or `null` when nothing should run. `busy` is the caller's combined
 * "some engine call is already in flight" flag — this driver's own busy-ref,
 * the manager driver's, or a project run — collapsed to one boolean so this
 * stays pure and testable without reaching into any of those refs. Mirrors
 * `dueSchedules`' own enabled+interval-elapsed filter (kept local, over the
 * passed-in list, rather than calling that module-state-reading function)
 * so the selection logic is unit-testable with an arbitrary fixture list.
 * Picks the first match — same "oldest due, stable order" semantics as
 * `dueSchedules(now)[0]`.
 */
export function pickDueLoop(
  schedules: readonly Schedule[],
  now: number,
  busy: boolean,
): Schedule | null {
  if (busy) return null
  return schedules.find((s) => s.enabled && now - s.lastRun >= s.everyMinutes * 60_000) ?? null
}

/**
 * Whether ANY engine run is in flight app-wide — the single shared gate that
 * keeps ONE engine subprocess at a time across ALL three drivers (the P2-3
 * loop driver, the manager driver, and a manual `runProject`). True when the
 * loop driver is mid-run (`loopBusy`), the manager driver is (`managerBusy`),
 * or ANY project is in flight OR parked awaiting a human — a project
 * 'running' a build step, or one 'awaiting' the "one more refine?" gate. The
 * 'awaiting' case matters twice: the parked run still owns the engine seat
 * conceptually (it resumes on the human's answer, not a driver tick), AND the
 * loop driver must never kick off a fresh `runProject` for an 'awaiting'
 * project — that would double-run past the human gate. Each caller passes
 * `false` for its OWN busy-ref (it is about to run and must not self-block)
 * and the other driver's ref for the peer. Pure so the whole busy decision is
 * unit-testable without any refs.
 */
export function engineBusy(
  loopBusy: boolean,
  managerBusy: boolean,
  projects: readonly Project[],
): boolean {
  if (loopBusy || managerBusy) return true
  return projects.some((p) => p.status === 'running' || p.status === 'awaiting')
}

/**
 * Why a 'test' loop cannot run against `verifyCommand`, or `null` when it can.
 * A project with no verify command has nothing to check: running the engine
 * anyway skips Tier-1 and lets the model judge an empty intent → a FALSE
 * green. Honest answer is to skip and record a failure, never a pass. Pure so
 * the branch decision is unit-testable.
 */
export function testLoopSkipReason(verifyCommand: string): string | null {
  return verifyCommand.trim() ? null : 'no verify command — skipped'
}

/**
 * Why a 'build' loop cannot start yet, or `null` when it can — the subset of
 * `runProject`'s own start guards the loop can pre-know (empty plan, unusable
 * dir). `dir` is the ALREADY-expanded project dir (caller runs
 * `expandUserPath` first, same as the test branch). Used so the loop records
 * an honest 'not ready' failure instead of a green 'build loop started' for a
 * build `runProject` would immediately refuse. Pure so it's unit-testable.
 */
export function buildLoopNotReady(
  plan: readonly string[],
  dir: string,
  status = '',
): string | null {
  if (plan.length === 0) return 'build loop: project not ready'
  if (!isUsableProjectDir(dir)) return 'build loop: project not ready'
  // A FINISHED project is not a build target (caught live 2026-08-29: a done
  // demo was happily rebuilt on its 30-minute bell — real tokens re-doing
  // finished work). Only an explicit re-plan (status leaving 'done') wakes
  // the loop again.
  if (status === 'done') return 'build loop: project is finished — nothing to build'
  return null
}

/**
 * A short, honest `recordRun` summary for the 'build' and 'test' loop kinds
 * — the two kinds with no natural per-run text of their own ('build' reports
 * through the project's own status/notice; 'test' is a pass/fail check).
 * The 'task' kind keeps its own richer summary (the model's actual reply,
 * verbatim from the pre-P2-3 StandingLoops driver) rather than going through
 * this generic phrasing. Pure so the kind-routing text is unit-testable.
 */
export function loopRunSummary(kind: ScheduleKind, ok: boolean): string {
  switch (kind) {
    case 'build':
      return ok ? 'build loop: run finished' : 'build loop: run failed or needs attention'
    case 'test':
      return ok ? 'verify passed' : 'verify failed'
    case 'task':
    default:
      return ok ? 'task ran' : 'no real reply (provider offline?)'
  }
}

export interface AppState {
  // Chat split into per-scope threads: one `'universal'` thread + one per
  // project id. Read via activeMessages(state) / threadFor(...).
  threads: Record<string, ChatMessage[]>
  verdicts: Verdict[]
  stats: Stats
  running: boolean
  // rolling accumulators used to recompute derived stats (local share, eval avg)
  totalRuns: number
  localRuns: number
  evalSum: number
  evalCount: number
  notices: Notice[]
  // Heartbeat presence (2026-07-29 spec): the wake line the manager driver is
  // running RIGHT NOW — null whenever no wake run is live. The FloatingPulse
  // orb animates ONLY while this is set (honesty rule: pulsing == a live run),
  // so the driver sets it around the run and ALWAYS clears it in finally.
  // Transient — never persisted.
  heartbeatLive: string | null
  // Mission Control (2026-08-05 spec §Live task cards) — the SINGLE source of
  // live-run truth: every run the APP started that has not finished yet. The
  // Work page's card glow derives from membership here and nothing else, so a
  // card can only glow while its run is genuinely live. Every runner registers
  // via `beginLiveRun` and ALWAYS clears via `endLiveRun` in a `finally`; a
  // leaked entry would glow forever, which is exactly the dishonesty this
  // exists to prevent. Transient — never persisted (a reload starts idle).
  liveRuns: LiveRun[]
  // The newest FINISHED_RUN_CAP outcomes, newest first — each one a real
  // recorded ending (passed / failed / stopped), never a guess. Transient.
  finishedRuns: FinishedRun[]
  // The project currently bound to the Workspace as the "active session"
  // (P2-4) — undefined when no project has been opened via Projects'
  // "Open in Workspace" button. Purely a UI label + a home for future
  // project-scoped chat context; it does not change what sendIntent runs.
  activeProjectId?: string
}

type Action =
  // `thread` routes the message to an explicit scope; omitted → the active
  // thread (a bound project, else universal).
  | { type: 'ADD_MESSAGE'; message: ChatMessage; thread?: string }
  | { type: 'REMOVE_MESSAGE'; id: string }
  | { type: 'APPEND_ASSISTANT'; id: string; line: string }
  // Per-message model attribution (multi-model chat): set the REAL model meta on
  // the assistant message with `id`, derived from its Verdict. Id-scoped across
  // threads (like APPEND_ASSISTANT); unknown id → no-op. Only the fields the
  // Verdict actually provides are carried — an undefined field is never written,
  // so a partial dispatch can never blank out or fabricate a model.
  | {
      type: 'SET_MESSAGE_MODEL'
      id: string
      model?: string
      routeReason?: string
      isLocal?: boolean
    }
  // `thread` routes the verdict CARD to an explicit scope (default: the active
  // thread). `card:false` records the verdict in state.verdicts/stats but
  // appends NO chat card — for verdicts whose home is the rail / Verdicts views.
  | { type: 'ADD_VERDICT'; verdict: Verdict; thread?: string; card?: boolean }
  | { type: 'SET_RUNNING'; running: boolean }
  | { type: 'ADD_NOTICE'; notice: Notice }
  | { type: 'CLEAR_NOTICE'; id: string }
  // The heartbeat driver's live wake line (null = idle). Only the manager
  // driver dispatches this, around a REAL wake run. This ONE transition is
  // also the heartbeat's live-run signal (Mission Control): a non-null line
  // registers the heartbeat LiveRun, null clears it — so the orb and the card
  // can never disagree, and there is no second heartbeat signal to leak.
  // `at`/`outcome`/`detail` are the honest record for the finished row; `at`
  // defaults to now when a caller omits it (older dispatch sites).
  | {
      type: 'SET_HEARTBEAT_LIVE'
      line: string | null
      at?: number
      outcome?: RunOutcome
      detail?: string
    }
  // Mission Control: register / clear ONE live run. LIVE_RUN_END on an id that
  // is not live is a no-op — a finished row is only ever written for a run
  // this store actually saw start.
  | { type: 'LIVE_RUN_START'; run: LiveRun }
  // PARK / UNPARK a live run: it stays registered (it resumes when the human
  // answers) but nothing is executing behind it, so nothing may glow or pulse.
  | { type: 'LIVE_RUN_PAUSE'; id: string; paused: boolean }
  | { type: 'LIVE_RUN_END'; id: string; at: number; outcome: RunOutcome; detail?: string }
  | { type: 'SET_ACTIVE_PROJECT'; projectId: string }
  | { type: 'RESET_SESSION' }
  // Swap a thread's older turns for one summary divider (P2-2 compaction
  // core; P2-3 drives this from a real model summary + vault archive write).
  | { type: 'COMPACT_THREAD'; thread: string; summaryId: string; summary: string; keepRecent?: number }
  // Empty ONE thread (P2-3 `New session`) — the driver archives the full
  // thread to the vault BEFORE dispatching this, so nothing is lost.
  | { type: 'RESET_THREAD'; thread: string }

// Small poll delay used by the durable project driver's park/resume loops.
function loopDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The directory the interview's verify command should run in: the BOUND
 * project's folder, or '' when no project is bound.
 *
 * '' is a real answer, not a fallback. The app knows exactly one project
 * directory per chat — the one the thread is bound to — and inventing a second
 * candidate (the engine's own folder, the vault, "the first project in the
 * list") is what produced a verification gate that failed 100% of runs while
 * looking like failing tests. Exported for the unit test that pins it.
 */
export function tier1CwdFor(activeProjectId?: string): string {
  if (!activeProjectId) return ''
  const p = getProjects().projects.find((x) => x.id === activeProjectId)
  return (p?.path ?? '').trim()
}

// Assemble the provider env forwarded to a native engine run from Settings, and
// decide whether the PRIMARY provider is real+configured (so a native run can
// actually produce real model output). OPENAI_API_KEY is shared by the local
// server and cloud OpenAI (base URL disambiguates), so the cloud OpenAI key
// wins when that provider is enabled, else the local key is used.
export function buildEngineProviders(
  settings: Settings,
  activeProjectId?: string,
): {
  providers: EngineProviders
  primaryReal: boolean
} {
  const byId = (id: string) => settings.providers.find((p) => p.id === id)
  const local = byId('local')
  const openai = byId('openai')
  const claude = byId('claude')
  const gemini = byId('gemini')
  const primary = settings.providers.find((p) => p.primary)
  const primaryId = primary?.id ?? 'local'
  // R1 — Auto-route mode: leave SCPRISM_PRIMARY UNSET so the Rust bridge omits
  // it, the gateway's `has_explicit_primary` is False, and the adopted route
  // policy actually governs the default lane (it is unreachable when a primary
  // is always exported). Sensitivity still forces local; a reasoning intent
  // still prefers a configured cloud. Pinned (the default) forwards the primary
  // as before, so the pinned provider always wins — unchanged.
  const autoRoute = settings.routingMode === 'auto'

  const openaiKey = openai?.enabled && openai.apiKey ? openai.apiKey : (local?.apiKey ?? '')

  const providers: EngineProviders = {
    baseUrl: local ? normalizeProviderBase(local.baseUrl) : '',
    apiKey: openaiKey,
    claudeApiKey: claude?.enabled ? claude.apiKey : '',
    geminiApiKey: gemini?.enabled ? gemini.apiKey : '',
    primary: autoRoute ? '' : primaryId,
    localModel: local?.model,
    openaiModel: openai?.model,
    claudeModel: claude?.model,
    geminiModel: gemini?.model,
  }

  // A custom service is any OpenAI-compatible endpoint — the engine's "local"
  // path with the custom URL + key + model substituted in. Skipped in Auto
  // mode: there is no pinned primary to substitute (local routes use the real
  // local server; cloud routes use whatever cloud provider is configured).
  if (!autoRoute && primary && isCustomProvider(primaryId)) {
    providers.baseUrl = normalizeProviderBase(primary.baseUrl)
    providers.apiKey = primary.apiKey
    providers.localModel = primary.model
    providers.primary = 'local'
  }

  providers.context = buildCompanionContext(settings, activeProjectId)
  {
    const iv = getInterview()
    providers.sensitive = iv.sensitiveWords.join(',')
    providers.tier1 = iv.verifyCommand
    // WHERE that verify command runs. The only project directory this path
    // genuinely knows is the bound project's own folder; with no project bound
    // there is no honest answer, and '' makes the engine SAY so rather than run
    // the user's `npm test` in whatever folder the app itself occupies (inside
    // the installed app that is the bundle's engine dir — no package.json in it
    // or any ancestor, so every run "failed its tests" without ever verifying
    // anything). See `EngineProviders.tier1Cwd`.
    //
    // Tier-1 is a PROJECT gate, so a run with no project has nothing to verify
    // and the engine SKIPS it (verifier.NOTHING_TO_VERIFY_MESSAGE) — it does not
    // fail. The command is still forwarded ON PURPOSE: `tier1` + an empty
    // `tier1Cwd` is precisely how the app says "a verify command is configured,
    // this run just has no codebase". Dropping it here instead would make the
    // engine record "no verify command configured for this run", which is FALSE
    // for a user who set one, and would make Stats say so out loud.
    providers.tier1Cwd = tier1CwdFor(activeProjectId)
  }
  // The user picks the model + thinking effort per provider; the PRIMARY's
  // choice drives the run.
  providers.effort = primary?.effort ?? ''
  providers.cliModel = primary && isCliProvider(primaryId) ? (primary.model ?? '') : ''
  providers.flagDeepeval = settings.engineFlags.deepeval
  providers.flagLightrag = settings.engineFlags.lightrag
  providers.flagBifrost = settings.engineFlags.bifrost
  // Web research (web design, 2026-07-23): opt-in, default OFF. When on, the
  // Rust bridge threads `--web` so the run's v2b loop gets the governed
  // web_fetch/web_search tool source; the search key travels env-only. Off →
  // `webResearch` is false and the bridge omits `--web` (byte-identical run).
  providers.webResearch = settings.webResearch
  providers.searchApiKey = settings.searchApiKey
  providers.searchEndpoint = settings.searchEndpoint
  // Tool posture + mid-run blocking approval (companion grants): 'ask' rides
  // the argv (`--require-approval all`) alongside the vault policy; blocking
  // threads `--approval-blocking --approval-timeout 300`. Off → identical.
  providers.mcpApproval = settings.mcpApproval
  providers.approvalBlocking = settings.approvalBlocking

  // "Real + configured": the primary is enabled and has the credential it needs
  // — a base URL for the local server, or an API key for a cloud provider.
  // That test now lives in ONE place (`providerUsable`, lib/settings.ts) so the
  // rest of the app — above all the team roster — can ask the same question
  // instead of inventing a looser one. Same answer as before, same words.
  const primaryReal = providerUsable(primary)
  return { providers, primaryReal }
}

/**
 * Providers for a PROJECT run: same governed pipeline as buildEngineProviders,
 * but tier1 is overridden to the PROJECT's OWN verify command — never the
 * onboarding interview's. buildEngineProviders always seeds tier1 from
 * `getInterview().verifyCommand` (the workspace-setup command), which is
 * meant for the chat/loop paths; a project run has its own `verifyCommand`
 * field and must gate on THAT, or its own checks never run and the
 * interview's unrelated command leaks in instead. An empty project verify
 * command is passed through as-is (honest: this project has none, so Tier-1
 * is skipped) rather than falling back to the interview's.
 */
export function buildProjectProviders(
  settings: Settings,
  verifyCommand: string,
  /** The project's own folder — where its verify command must run. */
  projectDir = '',
): { providers: EngineProviders; primaryReal: boolean } {
  const built = buildEngineProviders(settings)
  // Trimmed at THIS boundary, not in the rail's input (a controlled input
  // cannot trim while the user types a space): '  ' as --tier1 would run
  // `sh -c '  '` → exit 0 → a false green over a gate that checked nothing.
  built.providers.tier1 = (verifyCommand ?? '').trim()
  // The project's command belongs in the PROJECT's directory. (The engine's
  // `project` subcommand already passes `--project-dir` as the Tier-1 cwd; this
  // keeps the providers object honest for any caller that runs the plain `run`
  // path with a project's command.)
  built.providers.tier1Cwd = (projectDir ?? '').trim()
  return built
}

// The primary the honest-error guard protects. Native mode guards ANY enabled
// primary — including one the user set but never successfully connected
// (e.g. a cloud primary with a bad/missing key). The banner already names
// that primary as the problem, so the send guard has to cover it too, or a
// send would silently fall through to the sim: exactly the dishonesty this
// feature removes. Only "disabled" or "no primary at all" fall through to
// the sim/demo path (per the spec: browser/sim mode untouched).
export function guardedPrimary(settings: Settings): ProviderConfig | null {
  const primary = settings.providers.find((p) => p.primary && p.enabled)
  return primary ?? null
}

export function connectivityErrorText(name: string, status: ProviderStatus): string {
  return status === 'auth'
    ? `${name} rejected your API key — nothing was sent. Fix the key and retry.`
    : `${name} is unreachable — nothing was sent. Start the server and retry.`
}

/**
 * Providers for a MANAGER run: same governed pipeline, but the manager's own
 * provider drives it (its model + effort included). Tier-1 is skipped by
 * default — most maintenance jobs are reports, not code changes — but
 * `opts.keepTier1` preserves it for a DISPATCH job, which does run real work.
 */
export function buildManagerProviders(
  settings: Settings,
  providerId: string,
  opts?: { keepTier1?: boolean },
): { providers: EngineProviders; primaryReal: boolean } {
  const { providers } = buildEngineProviders(settings)
  const p = settings.providers.find((x) => x.id === providerId)
  if (!p || !p.enabled) return { providers, primaryReal: false }

  providers.primary = providerId
  providers.effort = p.effort ?? ''
  providers.cliModel = isCliProvider(providerId) ? (p.model ?? '') : ''
  // Reports skip the code gate; a DISPATCH keeps the user's Tier-1 command so
  // real deterministic checks run before the Tier-2 judge (spec part B).
  if (!opts?.keepTier1) providers.tier1 = ''
  if (isCustomProvider(providerId)) {
    providers.baseUrl = normalizeProviderBase(p.baseUrl)
    providers.apiKey = p.apiKey
    providers.localModel = p.model
    providers.primary = 'local'
  }
  // Same one definition of "real + configured" as buildEngineProviders above.
  return { providers, primaryReal: providerUsable(p) }
}

/**
 * The project-focus block prepended to the companion's context when a
 * project is active (Slice 1a) — pulled out as a pure helper so it's
 * unit-testable without the store. `null` (no active project, or an
 * activeProjectId that no longer resolves) yields '' so callers can splice it
 * into a `lines.filter(Boolean).join('\n')` array with zero effect: the
 * no-active-project context stays byte-identical to before this feature.
 */
export function activeProjectContext(project: Project | null): string {
  if (!project) return ''
  const goal = project.goal || project.brief
  const lines = [
    `You are working on the project "${project.name}" (${project.status}).`,
    goal ? `Goal: ${goal}` : '',
    project.plan.length
      ? `Plan: ${project.plan.map((step, i) => `${i + 1}. ${step}`).join(' ')}`
      : '',
    'Answer and act in the context of THIS project unless the user changes topic.',
  ]
  return lines.filter(Boolean).join('\n')
}

// Workspace context handed to the engine (→ Companion charter). Assembled from
// the setup interview + vault config so the co-founder knows the business, the
// governance gates, and the never-touch list on EVERY call. `activeProjectId`
// (the Workspace's bound project, P2-4) is resolved against the projects
// store the same way listSkills()/getManagers() are read below; unset or
// unresolved → activeProjectContext(null) → '' → no change to the output.
function buildCompanionContext(settings: Settings, activeProjectId?: string): string {
  const iv = getInterview()
  const gates = SIGNOFFS.filter((s) => iv.signoffs.includes(s.id)).map((s) => s.gate)
  const ais = settings.providers
    .filter((p) => p.enabled)
    .map((p) => `${p.name}${p.primary ? ' (primary)' : ''}${p.id === 'local' ? ' [safe for sensitive]' : ' [cloud]'}`)
  const activeProject = activeProjectId
    ? (getProjects().projects.find((p) => p.id === activeProjectId) ?? null)
    : null
  const lines = [
    activeProjectContext(activeProject),
    settings.companionName.trim()
      ? `The user named you "${settings.companionName.trim()}" — that is your name.`
      : '',
    iv.business ? `Business: ${iv.business}` : '',
    iv.companyName ? `Company: ${iv.companyName}${iv.website ? ` (${iv.website})` : ''}` : '',
    iv.departments.length ? `Departments: ${iv.departments.join(', ')}` : '',
    iv.teamSize ? `Team size: ${iv.teamSize}` : '',
    iv.budget ? `AI/tooling budget: ${iv.budget}` : '',
    ais.length ? `Connected AIs: ${ais.join('; ')}` : '',
    iv.roles.length ? `Operator roles: ${iv.roles.join(', ')}` : '',
    iv.priorities.length
      ? `Priorities (ranked): ${iv.priorities.map((p) => PRIORITY_LABEL[p]).join(' > ')}`
      : '',
    gates.length ? `Always require sign-off before: ${gates.join('; ')}` : '',
    iv.neverTouch.length ? `Never touch: ${iv.neverTouch.join('; ')}` : '',
    iv.compliance.length ? `Compliance regimes: ${iv.compliance.join(', ')}` : '',
    iv.verifyCommand ? `Verify command (Tier-1): ${iv.verifyCommand}` : '',
    iv.sensitiveWords.length
      ? `Sensitive words (force local, never cloud): ${iv.sensitiveWords.join(', ')}`
      : '',
    `Vault: ${settings.vaultPath} (${settings.vaultMode}${
      settings.githubRepo ? `, git-synced to ${settings.githubRepo}` : ''
    })`,
  ]
  // Skills the user saved become standing instructions the primary carries.
  const skills = listSkills().slice(0, 12)
  if (skills.length) {
    lines.push(
      'Saved skills (apply the matching one when a task fits its when-to-use):',
      ...skills.map((s) => `- ${s.name}: ${s.whenToUse || s.description}`),
    )
  }
  // Latest manager findings ride along so "what did my managers find?" works.
  const mgrs = getManagers()
  const reported = mgrs.jobs.filter((j) => j.runs[0]).slice(0, 6)
  if (reported.length) {
    lines.push(
      'Manager reports (latest, full reports in vault/reports/):',
      ...reported.map((j) => {
        const m = mgrs.managers.find((x) => x.id === j.managerId)
        return `- [${j.department}] ${j.title} (${m?.name ?? 'manager'}): ${j.runs[0].summary}`
      }),
    )
  }
  return lines.filter(Boolean).join('\n')
}

// Offline-stub / sim sentinels — text with these prefixes is NOT real model
// output, so we fall back to the simulation rather than surfacing it as real.
export function isRealCompletion(text: string | undefined): text is string {
  return !!text && !text.startsWith('[offline:') && !text.startsWith('[stub:')
}

/**
 * The engine's own words for WHY a non-real reply is non-real, when it gave
 * any — else `''`.
 *
 * The gateway marks every non-answer with `[offline:<provider>:<model>] …`.
 * Two different things wear that marker: the DETERMINISTIC stub (`handled: …`,
 * meaning there was nowhere real to call) and a stand-in that names a real
 * cause — today, a subscription CLI we killed at our own bound ("the claude CLI
 * did not answer within 180s"). Reporting both as "provider offline?" is how
 * the user came to read "possibly waiting on a held tool approval" for five
 * straight beats while nothing was ever held. So: surface a named cause, and
 * nothing for the stub (which has no cause to name beyond "offline").
 */
export function offlineReason(text: string | undefined): string {
  if (!text) return ''
  const m = /^\[offline:[^\]]*\]\s*([\s\S]+)$/.exec(text)
  if (!m) return ''
  const reason = m[1].trim()
  return reason.startsWith('handled:') ? '' : reason
}

/**
 * The result of racing an engine call against its hard timeout — a TAGGED union
 * so a caller can tell WHICH side won. This is the honesty seam (hardening
 * follow-on): a plain `T | null` collapsed a timeout and a genuine null-from-
 * the-engine into the same value, which made a slow provider get reported as
 * "unreachable — nothing was sent" and wrongly marked down. The tag keeps them
 * apart: `timedOut` is a slow-but-live provider, `!timedOut` carries whatever
 * the engine actually returned (which may itself be null on a real error).
 */
export type RaceOutcome<T> = { timedOut: true } | { timedOut: false; value: T }

/**
 * Race an engine call against a hard timeout, reporting WHICH side won. The
 * bounded wait exists so the chat / a driver tick never sits locked for minutes
 * when a subscription CLI or a wedged provider is slow.
 *
 * SAFETY / HONESTY. On a timeout the abandoned run can never corrupt state:
 * `Promise.race` discards the loser, so the engine promise's late resolution
 * has no continuation and is dropped — it can never write a verdict. The
 * run-driving callers (runProject) additionally advance a run id and
 * re-check it after every await, so even a value that somehow surfaced could
 * not be applied over a NEWER run. A timeout thus yields a consistent "no
 * verdict" outcome, never a stale one — and now a DISTINGUISHABLE one (the
 * `timedOut` tag), so callers stop mistaking a slow provider for a down one.
 * Killing the abandoned subprocess itself is done by the caller via
 * `cancelEngineRun` (see `raceCancelable`); the Rust bridge retains the child
 * under the launch's run id so the kill actually lands. Pure timing wrapper —
 * unit-testable with fake timers.
 */
export function raceEngineWithTimeout<T>(work: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return Promise.race([
    work.then((value): RaceOutcome<T> => ({ timedOut: false, value })),
    new Promise<RaceOutcome<T>>((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ])
}

/**
 * Launch-and-race helper: race `work` against `ms`, and when the TIMEOUT wins
 * issue a real subprocess cancel for `runId` so the abandoned engine run is
 * actually stopped (no zombie kept running, no overlap with the next scheduled
 * tick). `cancel` is injected (defaults to `cancelEngineRun`) so the cancel-on-
 * timeout contract is unit-testable with a spy. The normal (engine-wins) path
 * never cancels — byte-identical to a bare race. Returns the tagged outcome.
 */
export async function raceCancelable<T>(
  work: Promise<T>,
  ms: number,
  runId: string,
  cancel: (id: string) => void = cancelEngineRun,
): Promise<RaceOutcome<T>> {
  const outcome = await raceEngineWithTimeout(work, ms)
  if (outcome.timedOut) cancel(runId)
  return outcome
}

// ---------------------------------------------------------------------------
// The ONE team launch (Mission Control §Give a task from Work, 2026-08-06)
//
// A team run could only be started from the Agents page, and the user could not
// find where his task had gone. The Work composer can start one too now — which
// means the SAME launch has two callers, and two copies of a launch that mints a
// run id, claims the shared engine slot, races a cancelable timeout and
// registers a live run would drift within a week (the audit that produced this
// spec found exactly that class of drift). So the launch itself lives ONCE, in
// the store (`launchTeam`), and both callers call it. These constants are its
// public contract — the copy, the timeout and the defaults both surfaces show.
// ---------------------------------------------------------------------------

/** Hard client timeout for a team run; on expiry `raceCancelable` really kills
 *  the engine child (a draining child would keep appending to the ONE
 *  spans.jsonl and get attributed to whatever registered next). */
export const TEAM_TIMEOUT_MS = 300_000

/**
 * Tool executions a heartbeat WAKE may spend per model turn.
 *
 * The engine default rose to 12 (2026-08-18) because real research needs it —
 * but a wake is not research. It is a check-in on state the app already has,
 * inside a 20k token budget, and it must not silently inherit a research-sized
 * appetite just because the shared default grew. The 20k budget still stops the
 * loop first if a wake somehow goes deeper. Chat and manager jobs pass nothing
 * and get the full engine default, which is what they want.
 *
 * CUT FROM 6 TO 3 (2026-08-27) once the turns were priced. A wake's tool calls
 * are answered by the local model (see WAKE_TIMEOUT_MS), where a single call
 * measured 33s to 413s — so six was not "generous", it was more local
 * inference than an hourly check-in can justify.
 *
 * NOTE WHAT THIS DOES NOT BOUND. `--tool-turns` caps tool executions PER STEP
 * (the engine allows `n + 1` model calls per step), and a run has several
 * steps — so lowering it reduces how deep any one step digs, NOT how many
 * model calls the wake makes overall. A wake still made eight calls with this
 * set to 3. The wall must therefore be sized from measured latency, never from
 * this number; reading it as a turn budget is what made the first attempt at
 * that wall wrong.
 *
 * AND THEN BACK TO 6 (2026-08-27), once the real culprit was found. Cutting
 * the turns never helped, because the turns were not the problem: the engine
 * planned the wake as THREE steps, each with its own tool loop and its own copy
 * of this budget, so the wake did the same research three times and ran out in
 * each. See WAKE_STEPS.
 *
 * With the wake planning ONE step, these six turns are spent once. Measured
 * end to end against the real engine, on the real vault:
 *
 *   3 steps, 3 turns   15m 24s   69,976 tok   "I ran out of tool turns"
 *   1 step,  3 turns    4m 29s    8,993 tok   still ran out
 *   1 step,  6 turns    7m 18s   26,364 tok   REAL WORK — see below
 *
 * The six-turn run is the first wake that ever finished its research. It read
 * the vault, found that a manager job had been dead for eleven days across five
 * straight no-reply failures, spotted that an earlier heartbeat had degenerated
 * into a repetition loop and never recorded the pattern, and named the local
 * route as the suspect — then caught itself over-claiming and said so. That is
 * the companion doing its job, and it took six turns to do it.
 */
export const WAKE_TOOL_TURNS = 6

/**
 * Cap on the model's OUTPUT tokens for a wake.
 *
 * The engine's default is 4096, sized for real research. A wake asks for a
 * first-line summary or the word NOTHING_NEEDED, and on Sukhdeep's local model
 * — measured at four to six tokens a second — 4096 tokens is upwards of ten
 * minutes of generation for one call. Capping it took the worst local call in
 * a measured wake from 413s to 237s, with no loss of substance: the replies
 * that mattered came in around 200.
 *
 * RAISED FROM 900 (2026-08-27) after watching what a starved reply looks like.
 * Sukhdeep's local endpoint returns thinking and answer as separate fields —
 * but only when it REACHES the answer. Probe it at 120 tokens and it comes back
 * `finish_reason: length` with the raw monologue in `content` and
 * `reasoning_content` empty: "We need to respond to user... Need final answer
 * in English." That is what a real team run produced for the researcher seat at
 * 900, and on screen it reads as a coworker that has lost its mind rather than
 * one that ran out of room.
 *
 * A cap this side of the answer is worse than a slower beat, so the number
 * clears the thinking with room to spare. Anthropic is unaffected — the gateway
 * floors max_tokens per effort level, so this only ever bites the slow local
 * route, which is the one spending the time. And when it does bite, the span
 * carries `truncated` and the coworker's panel says so instead of showing the
 * monologue as an answer.
 */
export const WAKE_MAX_TOKENS = 1_800

/**
 * How many steps a wake plans. ONE.
 *
 * The engine plans a read task as understand -> locate -> produce, and each
 * step runs its own tool loop with its own turn budget. That shape is a
 * code-task plan: right for "change this repo", ruinous for "check in on my
 * business and do one small thing", where it means doing the same research
 * three times and running out of turns in each.
 *
 * Measured against the real engine on the real wake:
 *
 *   default plan   15m 24s   69,976 tokens   "I ran out of tool turns"
 *   one step        4m 29s    8,993 tokens   still short, but 3.4x faster
 *
 * The wake is one small piece of work by its own charter — "Do ONE small
 * useful piece of work" — so planning it as three was always a mismatch.
 */
export const WAKE_STEPS = 1

/**
 * May a wake read your notes through the vault TOOLS? No, by default.
 *
 * This looks like a privacy setting and is not one — nothing about it changes
 * where your data can go. It is a SPEED setting, and the two are entangled by
 * the egress floor: the moment a run reads a note through a tool, every later
 * turn of that run is pinned to the on-device model. Correctly — that is the
 * promise the product rests on. But on this Mac the on-device model answers at
 * four to six tokens a second, so tripping that floor costs the wake its whole
 * hour.
 *
 * Measured end to end, on the real vault, six times:
 *
 *   with vault tools      7–15 min   26,000–43,000 tok   never once landed a
 *                                                        usable answer
 *   without vault tools   54 sec     4,247 tok           a real answer, on the
 *                                                        fast CLI
 *
 * WHAT THIS COSTS, stated plainly because it is a real loss: the wake cannot
 * dig into notes it was not already handed, so the charter's second rung —
 * vault upkeep, indexing verdicts, triaging log.md — is out of reach. That
 * would be a hard trade if the alternative worked. It does not: a wake that
 * never finishes does that upkeep zero times too, and bills for it hourly.
 *
 * The app still hands the wake a great deal without a single tool call:
 * project statuses, the needs-you count, the ladder's own state, the business
 * note, and its recent beats. Flip this to true to trade the answer for the
 * digging.
 */
export const WAKE_VAULT_TOOLS = false

/**
 * The wake's token envelope — a REAL bound, not prompt text: it rides the run's
 * contract, and breaching it fails the Verdict.
 *
 * It was 20,000, chosen when a wake could not finish anything and so never
 * approached it. The first wake that DID finish its research spent 26,364 and
 * was failed for the breach — graded down not for being wrong but for having
 * done the work. A budget that only passes runs which give up early is
 * measuring the wrong thing.
 *
 * SIZED FROM TWO RUNS, NOT ONE. 40,000 was set from a single 26,364-token
 * sample; the next wake that completed spent 42,763 and was failed for the
 * breach. A check-in's cost genuinely varies with how much digging the ladder
 * turns out to need — 26k when the vault is quiet, 43k when it finds something
 * — so the envelope has to cover the spread rather than the first number seen.
 *
 * 60,000 clears both measurements with room, and still stops a wake that starts
 * spending like a research task rather than a check-in.
 */
export const WAKE_TOKEN_BUDGET = 60_000

/**
 * A BUILD STEP's contract envelope — the hard token cap the step's Verdict
 * enforces. SIZED FROM A MEASUREMENT, like the wake's budget above: the first
 * four-seat board step (planner+retrieval+implementer+reviewer) measured
 * 105,843 tokens on 2026-08-29 and FAILED the envelope with a Tier-2 score of
 * 0.7625 that had cleared the judge — the contract's 100k default is a solo
 * doer's number, not a board's. 200k covers the measured spend and the
 * heavier refine turns (they carry the previous attempt's files read back
 * from disk), and still stops a step that starts spending like a research
 * project.
 */
export const PROJECT_STEP_TOKEN_BUDGET = 200_000

/**
 * Hard client timeout for a single governed run — a companion wake or a manager
 * job.
 *
 * This must stay ABOVE the engine's own per-call bound (gateway.py
 * `CLI_TIMEOUT_DEFAULT`, 180s, override `SCPRISM_CLI_TIMEOUT`). The engine has
 * to lose FIRST: then it reports the timeout in its own words and the run still
 * finishes with an honest verdict. If this number ever drops to the engine's
 * bound or below, the client always wins the race — it kills the run, the
 * engine never gets to say why, and the beat reads "stopped at 240s" with
 * nothing behind it. That is exactly the state the user was in.
 *
 * ABOVE THE ENGINE'S BOUND WAS NOT ENOUGH (2026-08-27). 240s cleared the CLI
 * wall and still killed every unattended beat, because a CLI call is not what
 * a wake actually spends its time on. Timed on Sukhdeep's Mac, from
 * spans.jsonl and two full wake-shaped runs against his real endpoints:
 *
 *   claude-cli call    ~5-10s
 *   local call         33s - 413s (his 27B 4-bit generates at ~4-6 tok/s)
 *   a whole wake       6-8 local calls, 10-15 minutes, end to end
 *
 * And the wake ALWAYS ends up local: it reads the business note every beat, so
 * the egress floor pins the rest of the run to the on-device model — correctly,
 * that is the privacy rule working. Four minutes was never going to hold it.
 * Twenty-two of his last forty beats read "we stopped it at 240s", and not one
 * wake in that window completed.
 *
 * A FIXED number is the wrong shape for this, whatever its value: the honest
 * wall depends on how fast THIS Mac answers, which the app already measures.
 * `wakeWallMs` therefore takes the same measured per-machine budget the chat
 * uses (`turnBudget` over the last 200 spans, p90 of the slower route) and
 * spends the run's whole ceiling on it, because nobody is waiting on a
 * background beat: an unattended run that takes twelve minutes costs time the
 * user is not watching, while one killed at four costs the whole hour. The
 * constant below survives only as the FLOOR for a machine that has not been
 * measured yet.
 */
export const WAKE_TIMEOUT_MS = 420_000

/**
 * The wake's real wall for this machine — never below the floor above, and
 * never below the engine's own CLI bound plus its margin, so an honest "we
 * stopped it" can only ever mean the engine had stopped trying too.
 */
export function wakeWallMs(budget: TurnBudget): number {
  // The measured ceiling is clipped at ABS_CEILING_MS — a patience budget for
  // someone sitting in front of the app. Nobody is sitting in front of a
  // heartbeat, and a wake that does its work honestly measured eleven to
  // fifteen minutes on this Mac, so the interactive clip is exactly what kept
  // killing it. Unattended work is re-clipped at its own, longer ceiling.
  const measured = Math.min(
    Math.max(budget.ceilingMs, budget.stallMs * CEILING_STALLS),
    UNATTENDED_CEILING_MS,
  )
  return Math.max(WAKE_TIMEOUT_MS, ENGINE_CLI_WALL_MS + 30_000, measured)
}

/**
 * Floor for the chat composer's client wall. It was a bare `120_000` at the
 * call site; it is named here because it is now a FLOOR, not the whole answer.
 *
 * Same disease as the interview's old 90s wall: a chat run that reads the vault
 * is pinned to the local model by the egress floor for the rest of the run, and
 * a local call on this machine can cost minutes. `chatWallMs` therefore takes
 * the larger of this floor and what one call really costs here. The chat keeps a
 * FLAT wall (not the interview's progress-extended one) on purpose: a person is
 * sitting in front of it waiting, so an unbounded-but-progressing wait is worse
 * than an honest early stop that says it was our stop.
 */
export const CHAT_TIMEOUT_MS = 240_000

/**
 * The ENGINE's own CLI wall (`CLI_TIMEOUT_DEFAULT` in gateway.py, 180s).
 *
 * THE CLIENT MUST NEVER GIVE UP FIRST. This is the bug that made the product
 * look broken on Sukhdeep's machine: the client wall was 120s while the engine
 * was still legitimately waiting on an agentic CLI it allows 180s. So EVERY
 * slow-but-healthy run was killed by us, and the chat then said — accurately,
 * and uselessly — "that was our own wall, not a provider failure". Thirty-four
 * runs failed that way. Claude Code was stopped at 137s on a call it would have
 * finished, and his 35B local model was stopped at 120s on a laptop where a
 * single call can legitimately cost minutes.
 *
 * A client wall BELOW the engine's is never a useful stop: it cannot be a
 * provider verdict, only a self-inflicted one. The floor is therefore held
 * above the engine's CLI timeout with a margin for process start-up and the
 * verdict/eval work that follows the model call.
 */
export const ENGINE_CLI_WALL_MS = 180_000

/**
 * The chat's real wall for this machine — never below the floor, and never
 * below the engine's own wall plus its margin, so an honest "we stopped it" can
 * only ever mean the engine had genuinely stopped trying too.
 */
export function chatWallMs(budget: TurnBudget): number {
  return Math.max(CHAT_TIMEOUT_MS, ENGINE_CLI_WALL_MS + 30_000, budget.stallMs)
}

/** Token budget a launch uses when the caller names none — the same default the
 *  Agents launcher's field starts at. */
export const TEAM_TOKEN_BUDGET = 100_000

/** The honest refusal when the app's ONE engine slot is already held. Shared so
 *  the Agents page and the Work chat refuse in the SAME words; never queued. */
export const TEAM_BUSY_TEXT =
  'Another run is in progress — wait for it to finish, then launch the team.'

/** Honest copy for the two non-result endings (never dressed up as a failure of
 *  the team's reasoning). */
export const TEAM_TIMEOUT_TEXT =
  'We stopped the team run at 5 minutes — that is our own wall, not a provider failure. Try a smaller task.'
export const TEAM_FAILED_TEXT = 'Team run failed — check the agents list and try again.'

/**
 * What a team launch actually did — a tagged union so no caller has to guess.
 * `busy` means NOTHING started (no engine call, no live run, no card): the slot
 * was held, and the caller must say so rather than queue silently. `refused`
 * likewise started nothing — every seat was on a provider that isn't connected,
 * so there was no team to run and `reason` says exactly that.
 *
 * `sitOut` rides along on the outcomes where seats were dropped: a smaller team
 * must never be a silent one, so the caller is handed the names and reasons.
 */
export type TeamLaunch =
  | { status: 'busy' }
  | { status: 'ok'; result: TeamResult; sitOut: SitOut[]; reassigned: Reassigned[] }
  | { status: 'timeout'; salvage: string }
  | { status: 'failed' }
  | { status: 'refused'; reason: string; sitOut: SitOut[]; reassigned: Reassigned[] }
/**
 * The honest one-line notice a FINISHED team run posts into the Work chat.
 * Every part is a real field of that run's own result — the governed verdict's
 * pass/fail, its reason when it failed, the real token sum against the real
 * budget, and the board the engine actually wrote. Nothing is inferred and
 * nothing is rounded up into a claim; a run with no board path simply omits it.
 */
export function teamNoticeText(r: TeamResult): string {
  const head = r.passed ? 'team run passed' : 'team run did not pass'
  const reason = !r.passed && r.reason ? ` — ${r.reason}` : ''
  const over = r.overBudget ? ' (over budget)' : ''
  const budget = ` · ${r.tokens.toLocaleString()}/${r.tokenBudget.toLocaleString()} tok${over}`
  const board = r.board_path ? ` · board saved: ${r.board_path}` : ''
  return `${head}${reason}${budget}${board}`
}

/**
 * The default roster the launcher offers — built ONLY from providers that are
 * really connected (`providerUsable`, the same "real + configured" test the
 * engine's `primaryReal` uses).
 *
 * It used to name `local` as researcher and fall back to `gemini` as critic
 * whatever the user's settings said, so the default team could arrive with two
 * seats belonging to providers the app had never been able to reach. A role
 * with no connected provider is now simply not offered — and with nothing
 * connected at all this returns '', which every launch path refuses out loud
 * rather than running as a one-stub team.
 */
export function teamRosterFromSettings(settings: Settings): string {
  const usable = (id: string): boolean =>
    providerUsable(settings.providers.find((p) => p.id === id))
  const primary = settings.providers.find((p) => p.primary && providerUsable(p))
  const lead = primary?.id ?? settings.providers.find((p) => providerUsable(p))?.id ?? ''
  const critic = settings.providers.find(
    (p) => providerUsable(p) && p.id !== lead && p.id !== 'local',
  )?.id
  const pairs = [
    lead ? `lead:${lead}` : '',
    usable('local') ? 'researcher:local' : '',
    critic ? `critic:${critic}` : '',
  ]
  return pairs.filter(Boolean).join(',')
}

/** How a chat turn's engine outcome resolves, kept pure so the honest-vs-down
 *  decision sendIntent makes is testable without rendering. `timeout` (slow but
 *  live — do NOT mark the provider down) is deliberately separate from `error`
 *  (a real null / offline-stub — a genuine unreachable/error, mark it down). */
export type ChatTurn =
  | { kind: 'ok'; verdict: Verdict; response: string }
  | { kind: 'timeout' }
  // The LOCAL model could not be LOADED — the server answered (507 / "would
  // exceed the metal_cap memory ceiling") and is emphatically NOT down. Kept
  // apart from 'error' because 'error' marks the provider unreachable and
  // renders "nothing was sent. Start the server and retry." — advice that sent
  // the user hunting a network fault while his server was up and answering.
  | { kind: 'loadFailed'; reason: string }
  | { kind: 'error' }

export function chatTurnFromOutcome(outcome: RaceOutcome<Verdict | null>): ChatTurn {
  if (outcome.timedOut) return { kind: 'timeout' }
  const v = outcome.value
  // isRealCompletion narrows v.response to a real string here — only a genuine
  // model completion is ever surfaced/attributed (never offline-stub text).
  // guardAnswerText is the CHAT TURN's share of the tool_call guard: a reply
  // still carrying an unexecuted ```tool_call request is stripped and marked
  // incomplete before it can be appended as an assistant message, written to
  // the vault chat log, or parsed for PROPOSE_AGENT/PROPOSE_ROSTER blocks —
  // every one of which reads `turn.response`.
  if (v && isRealCompletion(v.response))
    return { kind: 'ok', verdict: v, response: guardAnswerText(v.response) }
  const named = offlineReason(v?.response)
  if (isLoadFailure(named)) return { kind: 'loadFailed', reason: named }
  return { kind: 'error' }
}

/**
 * Honest copy for a TIMEOUT (the run was sent and — with the cancel seam —
 * stopped; the provider is slow, NOT down). Deliberately distinct from
 * `connectivityErrorText`, which claims "unreachable — nothing was sent".
 *
 * 2026-08-16: it now names WHO stopped it and after how long. "took too long
 * and the run was stopped" reads like the provider gave up; WE gave up, and a
 * user comparing this card to a real outage had nothing to tell them apart.
 */
export function timeoutErrorText(name: string, afterMs = CHAT_TIMEOUT_MS): string {
  return (
    `${name} was still working after ${Math.round(afterMs / 1000)}s, so we stopped the run — ` +
    `that was our own wall, not a provider failure. Reading your vault keeps the rest of a run ` +
    `on your local model, which is slower here. Try again, or ask for something smaller.`
  )
}

// The per-message model meta a chat bubble surfaces (multi-model chat).
export interface MessageModelMeta {
  model: string
  routeReason?: string
  isLocal?: boolean
}

/**
 * Derive a chat message's honest model attribution from the REAL Verdict its
 * `runNativeTask` produced — the single source of truth for `SET_MESSAGE_MODEL`,
 * so it can never drift into fabricating a model. Pure (no I/O), so it's
 * unit-testable directly. NOTHING here is invented:
 *  - `model` is the REAL "provider · model" the engine recorded (`models_used[0]`),
 *    falling back to the route's already-derived model; when neither names a
 *    model we return `null` (no chip) rather than a placeholder.
 *  - `routeReason` reuses the Verdict's `route.reason` (mapVerdict already ran it
 *    through the honest `routeReasonLabel`) — never a re-guessed cause.
 *  - `isLocal` is the real route target the Verdict recorded.
 * Only a REAL completion is ever attributed: the live `sendIntent` flow calls
 * this ONLY after `isRealCompletion(v.response)` passes (a stub/offline verdict
 * routes to an honest error card instead), so there is no "stub chip" — a
 * non-real reply is surfaced as a failure, never as an attributed bubble (H3).
 */
export function messageModelFromVerdict(v: Verdict): MessageModelMeta | null {
  const used = v.native?.models_used ?? []
  const model = (used[0] ?? v.route?.model ?? '').trim()
  if (!model) return null
  const meta: MessageModelMeta = { model }
  if (v.route?.reason) meta.routeReason = v.route.reason
  if (v.route?.target) meta.isLocal = v.route.target === 'local'
  return meta
}

/**
 * The report-body construction for a manager TEAM job (part C2), pulled out
 * of the driver tick so the exact strings are unit-testable without a native
 * runtime. `res` is the governed TeamResult (or null on offline/timeout) —
 * `ok` gates strictly on `res.passed` (an over-budget or judge-rejected run is
 * a failure even if agents replied), `label` matches the dispatch branch's
 * `<kind> · passed|failed` convention, `text` is the full report-entry
 * body: the synthesis (or the reason, when there is no synthesis) followed by
 * the token-budget line, an OVER BUDGET flag, and the verdict path when any
 * of those are present; and `summary` is the synthesis/reason as a one-line
 * string (newlines replaced with ' · ') sliced to 160 chars for the run record.
 */
export function teamReportBody(res: TeamResult | null): { ok: boolean; text: string; summary: string; label: string } {
  const ok = !!res && res.passed
  const label = `team · ${ok ? 'passed' : 'failed'}`
  // TEAM ANSWER + the desk's finished-run row both read this string, so the
  // tool_call guard applies here once and covers both: `text` is what lands in
  // the saved report, `summary` is the row.
  const base = guardAnswerText(
    res ? res.synthesis || res.reason : '(no team result — provider offline or timed out?)',
  )
  const extra = res
    ? `\n\n${res.tokens.toLocaleString()} / ${res.tokenBudget.toLocaleString()} tok${res.overBudget ? ' · OVER BUDGET' : ''}${res.verdictPath ? `\nverdict: ${res.verdictPath}` : ''}`
    : ''
  // Summary: base text with newlines replaced by ' · ', capped at 160 chars (no extra token/verdict lines)
  const summary = base.replace(/\n+/g, ' · ').slice(0, 160)
  return { ok, label, text: `${base}${extra}`, summary }
}

// --- seeded example so the Workspace isn't empty on first load ---

const seedVerdict: Verdict = {
  taskId: 'A-1042',
  task: 'add a rate-limit guard to the uploader',
  route: {
    target: 'local',
    model: 'qwen2.5-coder',
    via: 'via Bifrost',
    reason: 'routine change — local model is enough',
    routeLabel: 'internal → local · qwen2.5-coder',
  },
  tier1: { tests: '14/14', lint: true, build: true, pass: true },
  tier2: { evalScore: 0.91, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
  tokensIn: 1240,
  tokensOut: 380,
  cost: 0.004,
  durationMs: 4200,
  modelRoute: '1,240 tok in / 380 out',
  hooks: { blocked: 0, passed: true },
  writeback: { path: 'notes/uploader.md', validated: true, committed: true },
  passed: true,
}

const seededState: AppState = {
  threads: {
    [UNIVERSAL]: [
      { id: 'seed-u', kind: 'user', text: 'add a rate-limit guard to the uploader' },
      {
        id: 'seed-a',
        kind: 'assistant',
        text: 'Added a guard plus 3 tests, routed to the local model, and verified before writing back.',
      },
      { id: 'seed-v', kind: 'verdict', verdict: seedVerdict },
    ],
  },
  verdicts: [seedVerdict],
  stats: {
    tokensToday: 1240,
    costToday: 0.04,
    tier1Saves: 7,
    localSharePct: 61,
    evalAvg: 0.91,
  },
  running: false,
  totalRuns: 1,
  localRuns: 1,
  evalSum: 0.91,
  evalCount: 1,
  notices: [],
  heartbeatLive: null,
  liveRuns: [],
  finishedRuns: [],
}

// A truly blank session — what a NATIVE first run starts with (no fake
// example conversation; the browser demo keeps the seeded example).
const blankState: AppState = {
  threads: { [UNIVERSAL]: [] },
  verdicts: [],
  stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
  running: false,
  totalRuns: 0,
  localRuns: 0,
  evalSum: 0,
  evalCount: 0,
  notices: [],
  heartbeatLive: null,
  liveRuns: [],
  finishedRuns: [],
}

// ---------- durable session persistence (localStorage) ----------
//
// We persist ONLY the durable session — the chat transcript, produced verdicts,
// and the running stats. Transient / in-flight state (`running`, liveRuns) is
// deliberately NOT persisted: on reload it is restored to
// idle/empty so a reload can never leave a task dangling mid-flight.

const SESSION_KEY = 'scprism.session'

// The exact durable slice written to storage. activeProjectId (P2-4) rides
// along with the rest of the durable session — it survives a reload exactly
// like the transcript/verdicts/stats do, since "which project am I working
// on" is a session fact, not transient UI state.
interface PersistedSession {
  threads: Record<string, ChatMessage[]>
  verdicts: Verdict[]
  stats: Stats
  activeProjectId?: string
}

/**
 * Back-compat sanitize for the persisted session's `activeProjectId` — any
 * non-string (missing, from a pre-P2-4 session; or malformed) yields
 * `undefined` rather than rejecting the whole session, mirroring how a
 * missing `projectId` on a Schedule sanitizes to '' rather than dropping the
 * record (schedules.ts). An empty string also normalizes to `undefined` (no
 * project bound), matching the reducer's own SET_ACTIVE_PROJECT clear rule.
 * Pure so it's unit-testable without localStorage.
 */
export function sanitizeActiveProjectId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function isStats(x: unknown): x is Stats {
  if (!isRecord(x)) return false
  return (
    typeof x.tokensToday === 'number' &&
    typeof x.costToday === 'number' &&
    typeof x.tier1Saves === 'number' &&
    typeof x.localSharePct === 'number' &&
    typeof x.evalAvg === 'number'
  )
}

// Lightweight structural check — enough to trust the payload without re-deriving
// every nested field. A malformed/partial verdict is rejected wholesale.
function isVerdict(x: unknown): x is Verdict {
  if (!isRecord(x)) return false
  return (
    typeof x.taskId === 'string' &&
    typeof x.task === 'string' &&
    isRecord(x.route) &&
    isRecord(x.tier1) &&
    isRecord(x.tier2) &&
    typeof x.passed === 'boolean'
  )
}

function isChatMessage(x: unknown): x is ChatMessage {
  if (!isRecord(x)) return false
  if (typeof x.id !== 'string') return false
  if (x.kind === 'user' || x.kind === 'divider' || x.kind === 'notice')
    return typeof x.text === 'string'
  if (x.kind === 'seat')
    return (
      typeof x.text === 'string' &&
      typeof x.agent === 'string' &&
      typeof x.provider === 'string' &&
      typeof x.model === 'string'
    )
  if (x.kind === 'assistant') {
    if (typeof x.text !== 'string') return false
    // Per-message model meta (multi-model chat) is OPTIONAL — a message without
    // it stays valid (back-compat), and one WITH it round-trips unchanged (the
    // fields ride through the cast in threadsFromPersisted). Only reject a field
    // that is PRESENT but the wrong type, so a corrupt persisted value can't
    // rehydrate into a misleading chip; absent fields are always fine.
    if (x.model !== undefined && typeof x.model !== 'string') return false
    if (x.routeReason !== undefined && typeof x.routeReason !== 'string') return false
    if (x.isLocal !== undefined && typeof x.isLocal !== 'boolean') return false
    return true
  }
  if (x.kind === 'verdict') return isVerdict(x.verdict)
  if (x.kind === 'error')
    return (
      typeof x.text === 'string' && typeof x.intent === 'string' && typeof x.providerId === 'string'
    )
  return false
}

/**
 * Migrate a parsed persisted payload into a validated threads record, or null
 * when it is neither format. Two shapes are accepted:
 *  - NEW: `{ threads: { <key>: ChatMessage[] } }` — every thread value must be
 *    an array of valid ChatMessages, else the whole payload is rejected. A
 *    `universal` key is guaranteed (defaulted to []) so the app always has a
 *    global thread to fall back to.
 *  - OLD: `{ messages: ChatMessage[] }` (pre-threads sessions) — folded into
 *    the universal thread.
 * Pure so it's unit-testable without localStorage.
 */
export function threadsFromPersisted(
  parsed: Record<string, unknown>,
): Record<string, ChatMessage[]> | null {
  const t = parsed.threads
  if (isRecord(t)) {
    const out: Record<string, ChatMessage[]> = {}
    for (const [key, value] of Object.entries(t)) {
      if (!Array.isArray(value) || !value.every(isChatMessage)) return null
      out[key] = value as ChatMessage[]
    }
    if (!out[UNIVERSAL]) out[UNIVERSAL] = []
    return out
  }
  const msgs = parsed.messages
  if (Array.isArray(msgs) && msgs.every(isChatMessage)) {
    return { [UNIVERSAL]: msgs as ChatMessage[] }
  }
  return null
}

/**
 * Seed a project-scoped thread from each project's saved interview transcript,
 * so opening a project in the Workspace shows its prior conversation. Only
 * seeds a project that has a non-empty transcript AND no existing non-empty
 * thread — an already-populated thread is never overwritten, and an empty
 * transcript adds no key. Returns a new record (never mutates the input).
 * Pure so it's unit-testable without the store.
 */
export function seedThreadsFromProjects(
  threads: Record<string, ChatMessage[]>,
  projects: { id: string; transcript: ProjectTurn[] }[],
): Record<string, ChatMessage[]> {
  const out = { ...threads }
  for (const p of projects) {
    if (!p.transcript || p.transcript.length === 0) continue
    const existing = out[p.id]
    if (existing && existing.length > 0) continue
    out[p.id] = p.transcript.map((turn, i) => projectTurnToMessage(p.id, turn, i))
  }
  return out
}

// Read + validate the saved session. Any parse error or shape mismatch yields
// null so the caller falls back to the seeded example.
function loadSession(): PersistedSession | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (!isStats(parsed.stats)) return null
    const threads = threadsFromPersisted(parsed)
    const verdicts = parsed.verdicts as unknown[]
    if (threads === null) return null
    if (!Array.isArray(verdicts) || !verdicts.every(isVerdict)) return null
    return {
      threads,
      verdicts,
      stats: parsed.stats,
      activeProjectId: sanitizeActiveProjectId(parsed.activeProjectId),
    }
  } catch {
    return null
  }
}

/**
 * The persisted run history, for a surface that lives OUTSIDE the provider
 * tree. Settings renders without `<AppProvider>` (it is reachable from the
 * setup wizard), but the local-model picker's quality column is the Tier-2
 * score of real verdicts — so it reads the same durable session the store
 * restores from, through the same validation. Never a second storage contract:
 * this is `loadSession`'s output, or `[]` when there is nothing valid saved.
 */
export function persistedVerdicts(): Verdict[] {
  return loadSession()?.verdicts ?? []
}


/**
 * The persisted run LEDGER, for the same surfaces that live outside the
 * provider tree (see `persistedVerdicts`). Same durable session, same
 * validation — never a second storage contract, so the budget card and the
 * run history are structurally incapable of disagreeing.
 *
 * Zeros when nothing valid is saved. That is the honest reading of "no runs
 * yet", not a placeholder.
 */
export function persistedStats(): Stats {
  return (
    loadSession()?.stats ?? {
      tokensToday: 0,
      costToday: 0,
      tier1Saves: 0,
      localSharePct: 0,
      evalAvg: 0,
    }
  )
}

function saveSession(state: AppState): void {
  try {
    if (typeof localStorage === 'undefined') return
    const payload: PersistedSession = {
      threads: state.threads,
      verdicts: state.verdicts,
      stats: state.stats,
      ...(state.activeProjectId ? { activeProjectId: state.activeProjectId } : {}),
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload))
  } catch {
    // Storage unavailable / over quota / serialization failure — persistence is
    // best-effort, so drop it silently rather than break the app.
  }
}

function clearStoredSession(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // best-effort — see saveSession
  }
}

// Lazy reducer initializer: restore the durable session if one is saved, else
// use the seeded example. When restoring, transient state is forced to idle —
// `running` false, loop reset — and the rolling accumulators
// are re-derived from the restored verdicts so later stats stay coherent.
function initState(seed: AppState): AppState {
  const session = loadSession()

  // Seed a per-project thread from each project's saved interview transcript
  // (best-effort — getProjects() reads localStorage/disk, which may be empty
  // or unavailable; on any throw we skip seeding). Always guarantee a
  // universal thread so activeMessages() has a global fallback.
  const withProjectSeeds = (threads: Record<string, ChatMessage[]>): Record<string, ChatMessage[]> => {
    let out = threads
    try {
      out = seedThreadsFromProjects(threads, getProjects().projects)
    } catch {
      // getProjects() unavailable — keep the threads as-is.
    }
    if (!out[UNIVERSAL]) out = { ...out, [UNIVERSAL]: [] }
    return out
  }

  // Native first run: start EMPTY and honest — no fake example conversation.
  if (!session) {
    const base = isNative() ? blankState : seed
    return { ...base, threads: withProjectSeeds(base.threads) }
  }

  let totalRuns = 0
  let localRuns = 0
  let evalSum = 0
  let evalCount = 0
  for (const v of session.verdicts) {
    totalRuns += 1
    if (v.route.target === 'local') localRuns += 1
    if (v.passed) {
      evalSum += v.tier2.evalScore
      evalCount += 1
    }
  }

  return {
    threads: withProjectSeeds(healPendingBubbles(session.threads)),
    verdicts: session.verdicts,
    stats: session.stats,
    running: false,
    totalRuns,
    localRuns,
    evalSum,
    evalCount,
      notices: [],
    heartbeatLive: null,
    liveRuns: [],
    finishedRuns: [],
    activeProjectId: session.activeProjectId,
  }
}

/**
 * RESTORE-time heal (2026-08-28): an assistant message with EMPTY text is the
 * typing indicator — legitimate only while its run is alive in THIS session.
 * The app closing mid-run persisted one into the thread, and the node-cli
 * chat then showed "Sukh is thinking… (subscription replies take 15–45s)"
 * forever, over no run at all. Pending is a live-session fact; a restored
 * thread may carry answers and honest notices, never an open promise. The
 * heal speaks in the app's own voice (kind 'notice' — never an AI), keeps the
 * message id (stable keys), and returns the SAME reference when nothing needed
 * healing so an untouched restore stays byte-identical.
 */
export function healPendingBubbles(
  threads: Record<string, ChatMessage[]>,
): Record<string, ChatMessage[]> {
  let changed = false
  const out: Record<string, ChatMessage[]> = {}
  for (const [key, msgs] of Object.entries(threads)) {
    let threadChanged = false
    const healed = msgs.map((m): ChatMessage => {
      if (m.kind === 'assistant' && m.text === '') {
        threadChanged = true
        return {
          id: m.id,
          kind: 'notice',
          text: 'a reply never arrived here — the app closed (or the run was stopped) while this was still being written. Send the message again if you still need it.',
        }
      }
      return m
    })
    out[key] = threadChanged ? healed : msgs
    changed = changed || threadChanged
  }
  return changed ? out : threads
}

// Append a message to ONE thread, creating the array if that scope is new.
// Pure — returns a new threads record.
function appendToThread(
  threads: Record<string, ChatMessage[]>,
  key: string,
  msg: ChatMessage,
): Record<string, ChatMessage[]> {
  return { ...threads, [key]: [...(threads[key] ?? []), msg] }
}

// Apply `fn` to EVERY thread's message array. Pure — used by the cross-thread
// REMOVE_MESSAGE / APPEND_ASSISTANT operations: a message id is globally
// unique, so mapping over all threads is safe and simplest.
function updateAllThreads(
  threads: Record<string, ChatMessage[]>,
  fn: (m: ChatMessage[]) => ChatMessage[],
): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {}
  for (const [key, value] of Object.entries(threads)) out[key] = fn(value)
  return out
}

/**
 * The companion heartbeat's live-run id. Fixed (not a fresh newRunId) because
 * the driver serializes beats under `managerBusyRef` — at most ONE wake is ever
 * in flight — and because the ONE signal that registers it is the existing
 * `SET_HEARTBEAT_LIVE` transition, which carries no id of its own.
 */
export const HEARTBEAT_RUN_ID = 'heartbeat'

/** Vault-safe path segment for a report file (`reports/<slug>/…`). Module
 *  level because the heartbeat wake and the manager-job driver both write
 *  reports and now live in two different closures — one implementation, so a
 *  beat and a job can never disagree about where a manager's reports go. */
const reportSlug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Source (a) of an agent proposal (2026-08-11 spec): a heartbeat wake / manager
 * reply may END with a `PROPOSE_AGENT` block. This is the ONE place that reads
 * one, and every outcome is honest:
 *   • no block            → '' (the beat line is untouched)
 *   • malformed / evidence-free / an id outside the verified pool → the block
 *     is IGNORED and the beat says so, with the reason. No proposal is made.
 *   • a duplicate of a role already proposed, dismissed or created → also
 *     ignored, and the beat says that too (a dismissal must not nag).
 *   • valid + new         → the proposal is recorded (still NOT an agent) and
 *     the vault ledger is refreshed so it survives a restart.
 * Returns the suffix to append to the beat line.
 */
function recordProposalFromReply(
  text: string,
  evidencePool: readonly string[],
  vaultPath: string,
): string {
  const parsed = parseProposalBlock(text, { source: 'heartbeat', knownRunIds: evidencePool })
  if (parsed.status === 'none') return ''
  if (parsed.status === 'refused') return ` · proposal ignored (${parsed.reason})`
  // Why it was refused, in the store's own words (the agent already exists, it
  // is already on the desk, it was dismissed on this same evidence) — read
  // BEFORE proposing so the beat can say the real reason, not "duplicate".
  const blocked = proposalBlockedReason(parsed.input)
  const recorded = proposeAgent(parsed.input, Date.now())
  if (!recorded) return ` · proposal ignored (${blocked ?? 'nothing was recorded'})`
  void persistProposalsToVault(vaultPath)
  return ` · proposed a new agent: ${recorded.name} — waiting for you on the desk`
}

/**
 * The interview (2026-08-15 spec §4): a wake reply may END with an
 * `ASK_BUSINESS` block carrying up to three one-line questions. This is the ONE
 * place that reads one, and every outcome is honest:
 *   • no block → '' (the beat line is untouched)
 *   • malformed / empty / not terminal → IGNORED, and the beat says why
 *   • asking not allowed right now (something is waiting on the user, the note
 *     is already full enough, a set is already open) → ignored, with that reason
 *   • every question already asked before → ignored, and the beat says so (no
 *     re-asking, ever)
 *   • valid + new → the set is parked on the DESK (never a chat interruption)
 *     and the ledger is refreshed so a restart cannot resurrect it.
 * Nothing here writes a business FACT: an unanswered question is a question.
 */
function recordQuestionsFromReply(
  text: string,
  gate: { needsYou: number; contextThin: boolean },
  note: string | null,
  vaultPath: string,
): string {
  const parsed = parseAskBlock(text)
  if (parsed.status === 'none') return ''
  if (parsed.status === 'refused') return ` · questions ignored (${parsed.reason})`
  const blocked = askBlockedReason({ ...gate, sets: listQuestionSets() })
  if (blocked) return ` · questions ignored (${blocked})`
  const set = askBusinessQuestions(parsed.questions, Date.now(), note)
  if (!set) return ' · questions ignored (the user has already been asked all of them)'
  void persistQuestionsToVault(vaultPath)
  const cut = parsed.dropped > 0 ? ` (${parsed.dropped} more were dropped — three is the limit)` : ''
  return ` · asked you ${set.questions.length} question${set.questions.length === 1 ? '' : 's'} on the desk${cut}`
}

/**
 * Source (b) of an agent proposal: the user asked for one on Work. Same strict
 * parser, but the evidence is the user's OWN request (real by construction, and
 * quoted verbatim on the desk row) rather than run ids. ALWAYS returns a
 * sentence — the user explicitly asked for a proposal here, so all three
 * outcomes (no block, refused, recorded) are reported in the thread; silence
 * would read as success. Only ordinary sends (which never call this) stay
 * byte-identical.
 */
function proposalNoticeFromChat(reply: string, request: string, vaultPath: string): string {
  const parsed = parseProposalBlock(reply, { source: 'asked', request })
  if (parsed.status === 'none') {
    return "No agent was proposed — the reply didn't end with a proposal block, so nothing was recorded."
  }
  if (parsed.status === 'refused') {
    return `No agent was proposed — the proposal block was ignored (${parsed.reason}).`
  }
  const blocked = proposalBlockedReason(parsed.input)
  const recorded = proposeAgent(parsed.input, Date.now())
  if (!recorded) {
    return `No agent was proposed — ${blocked ?? 'nothing was recorded'}.`
  }
  void persistProposalsToVault(vaultPath)
  return `Proposed ${recorded.name} — it is waiting under "Needs you". Nothing is created until you tap Create.`
}

/**
 * The roster equivalent of `proposalNoticeFromChat`: the user asked Sukh to
 * STAFF a project on Work, and the reply may end with a `PROPOSE_ROSTER` block.
 *
 * Same three honest outcomes, always reported (the user explicitly asked, so
 * silence would read as success), and the same rule that makes the feature
 * worth having: a role citing a need this project never recorded is REFUSED,
 * whole roster and all. Nothing is created here — the human creates, from the
 * desk, with one approval.
 */
function rosterNoticeFromChat(
  reply: string,
  evidence: RosterEvidence,
  vaultPath: string,
): string {
  const parsed = parseRosterBlock(reply, evidence)
  if (parsed.status === 'none') {
    return "No team was proposed — the reply didn't end with a roster block, so nothing was recorded."
  }
  if (parsed.status === 'refused') {
    return `No team was proposed — the roster block was ignored (${parsed.reason}).`
  }
  const blocked = rosterBlockedReason(parsed.input)
  const recorded = proposeRoster(parsed.input, Date.now())
  if (!recorded) return `No team was proposed — ${blocked ?? 'nothing was recorded'}.`
  void persistRostersToVault(vaultPath)
  const n = recorded.roles.length
  return `Proposed ${n} role${n === 1 ? '' : 's'} for “${evidence.projectName}” — waiting under “Needs you”. One approval creates them all; nothing exists until then.`
}

/**
 * The card line for a run whose intent text is empty (e.g. the interview's
 * blank opening turn). Describes the KIND only — a real fact — rather than
 * inventing a task description.
 */
function kindFallbackIntent(kind: LiveRunKind): string {
  switch (kind) {
    case 'chat':
      return 'a chat message'
    case 'team':
      return 'a team run'
    case 'manager':
      return 'a manager job'
    case 'heartbeat':
      return 'a heartbeat check'
    case 'project':
      return 'a project run'
    case 'loop':
      return 'a loop step'
    case 'task':
      return 'a scheduled task'
    case 'test':
      return 'a scheduled check'
    case 'compaction':
      return 'tidying a conversation'
    default:
      return 'a run'
  }
}

/**
 * Move ONE live run to the finished list. Pure; returns just the two slices so
 * every caller spreads it into the same state object.
 *
 * HONESTY: an id that is not currently live is a NO-OP — no finished row is
 * ever written for a run this store did not see start, so a stray/duplicate
 * end can't fabricate an outcome. The finished list keeps the newest
 * FINISHED_RUN_CAP rows, newest first.
 */
function finishLiveRun(
  state: AppState,
  id: string,
  at: number,
  outcome: RunOutcome,
  detail: string,
): Pick<AppState, 'liveRuns' | 'finishedRuns'> {
  const run = state.liveRuns.find((r) => r.id === id)
  if (!run) return { liveRuns: state.liveRuns, finishedRuns: state.finishedRuns }
  const finished: FinishedRun = {
    id: run.id,
    kind: run.kind,
    intent: run.intent,
    startedAt: run.startedAt,
    endedAt: at,
    outcome,
    detail,
  }
  return {
    liveRuns: state.liveRuns.filter((r) => r.id !== id),
    finishedRuns: [finished, ...state.finishedRuns].slice(0, FINISHED_RUN_CAP),
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const key = action.thread ?? activeThreadKey(state.activeProjectId)
      return { ...state, threads: appendToThread(state.threads, key, action.message) }
    }

    case 'REMOVE_MESSAGE':
      return {
        ...state,
        threads: updateAllThreads(state.threads, (ms) => ms.filter((m) => m.id !== action.id)),
      }

    case 'APPEND_ASSISTANT':
      return {
        ...state,
        threads: updateAllThreads(state.threads, (ms) =>
          ms.map((m) =>
            m.id === action.id && m.kind === 'assistant'
              ? { ...m, text: m.text ? `${m.text}\n${action.line}` : action.line }
              : m,
          ),
        ),
      }

    case 'SET_MESSAGE_MODEL':
      // Attribute the assistant message with `id` to the REAL model its Verdict
      // reported. Id-scoped across every thread (a message id is globally
      // unique), assistant-only, and pure. Only the fields the action actually
      // carries are written (spread-when-defined) — an undefined field never
      // overwrites or fabricates one, and an unknown id maps to a no-op.
      return {
        ...state,
        threads: updateAllThreads(state.threads, (ms) =>
          ms.map((m) =>
            m.id === action.id && m.kind === 'assistant'
              ? {
                  ...m,
                  ...(action.model !== undefined ? { model: action.model } : {}),
                  ...(action.routeReason !== undefined ? { routeReason: action.routeReason } : {}),
                  ...(action.isLocal !== undefined ? { isLocal: action.isLocal } : {}),
                }
              : m,
          ),
        ),
      }

    case 'ADD_VERDICT': {
      const v = action.verdict
      const isLocal = v.route.target === 'local'
      const totalRuns = state.totalRuns + 1
      const localRuns = state.localRuns + (isLocal ? 1 : 0)
      const evalSum = state.evalSum + (v.passed ? v.tier2.evalScore : 0)
      const evalCount = state.evalCount + (v.passed ? 1 : 0)
      const stats: Stats = {
        tokensToday: state.stats.tokensToday + v.tokensIn + v.tokensOut,
        costToday: Math.round((state.stats.costToday + v.cost) * 1000) / 1000,
        // A passed Tier 1 is a "free" deterministic save; a fail is not — and
        // neither is a SKIP. A gate with nothing to check (no project bound, no
        // verify command) passes only because there is nothing to disprove;
        // counting it here would credit the KPI for checks that never ran.
        tier1Saves: state.stats.tier1Saves + (v.tier1.pass && !v.tier1.skipped ? 1 : 0),
        localSharePct: Math.round((localRuns / totalRuns) * 100),
        evalAvg: evalCount ? Math.round((evalSum / evalCount) * 100) / 100 : state.stats.evalAvg,
      }
      const base = {
        ...state,
        verdicts: [v, ...state.verdicts],
        stats,
        totalRuns,
        localRuns,
        evalSum,
        evalCount,
      }
      // card:false → record the verdict/stats only, no chat card (the rail +
      // Verdicts views already surface it; a card here would misroute/double-show).
      if (action.card === false) return base
      const key = action.thread ?? activeThreadKey(state.activeProjectId)
      return {
        ...base,
        threads: appendToThread(base.threads, key, {
          id: `v-${v.taskId}`,
          kind: 'verdict',
          verdict: v,
        }),
      }
    }

    case 'SET_RUNNING':
      return { ...state, running: action.running }

    case 'ADD_NOTICE':
      return { ...state, notices: [...state.notices, action.notice] }

    case 'CLEAR_NOTICE':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) }

    case 'SET_HEARTBEAT_LIVE': {
      // ONE signal, two surfaces. The orb has always pulsed on
      // `heartbeatLive`; the Mission Control card derives from the SAME
      // transition rather than a second heartbeat flag that could drift out
      // of sync (or leak). Registering here means the driver's existing
      // `finally { SET_HEARTBEAT_LIVE null }` is also what clears the card.
      const at = action.at ?? Date.now()
      if (action.line !== null) {
        const run: LiveRun = {
          id: HEARTBEAT_RUN_ID,
          kind: 'heartbeat',
          intent: action.line,
          startedAt: at,
          models: [],
        }
        return {
          ...state,
          heartbeatLive: action.line,
          liveRuns: [...state.liveRuns.filter((r) => r.id !== HEARTBEAT_RUN_ID), run],
        }
      }
      return {
        ...state,
        heartbeatLive: null,
        ...finishLiveRun(state, HEARTBEAT_RUN_ID, at, action.outcome ?? 'stopped', action.detail ?? ''),
      }
    }

    case 'LIVE_RUN_START':
      // Idempotent by id: a re-registration replaces rather than duplicates,
      // so one runner can never light two cards.
      return {
        ...state,
        liveRuns: [...state.liveRuns.filter((r) => r.id !== action.run.id), action.run],
      }

    case 'LIVE_RUN_PAUSE':
      // No-op for an id that is not live — a stray park can never conjure a
      // card, exactly like LIVE_RUN_END can never conjure a finished row.
      return {
        ...state,
        liveRuns: state.liveRuns.map((r) =>
          r.id === action.id ? { ...r, paused: action.paused } : r,
        ),
      }

    case 'LIVE_RUN_END':
      return {
        ...state,
        ...finishLiveRun(state, action.id, action.at, action.outcome, action.detail ?? ''),
      }

    case 'SET_ACTIVE_PROJECT':
      // An empty id clears the binding — normalized to undefined so
      // `state.activeProjectId` is always either a real id or unset, never ''.
      return { ...state, activeProjectId: action.projectId || undefined }

    case 'RESET_SESSION':
      // Drop the whole durable + transient session. Native resets to a blank
      // honest state; the browser demo resets to the seeded example.
      return isNative() ? blankState : seededState

    case 'COMPACT_THREAD': {
      const existing = state.threads[action.thread] ?? []
      const { older, recent } = splitForCompaction(existing, action.keepRecent)
      if (older.length === 0) return state // nothing to compact
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.thread]: [summaryMessage(action.summaryId, action.summary), ...recent],
        },
      }
    }

    case 'RESET_THREAD':
      return { ...state, threads: { ...state.threads, [action.thread]: [] } }

    default:
      return state
  }
}

/**
 * Per-message route hint the composer can attach to ONE send (P-routehint).
 * 'auto' (the default) means no hint — the gateway applies its normal rules and
 * the run is byte-identical to before this feature. 'local'/'cloud' are a
 * REQUEST the gateway grants only within the zero-egress sensitivity floor: a
 * secret stays local even under 'cloud', and the attribution chip shows the
 * REAL route + reason, so the loop stays honest.
 */
export type RouteHint = 'local' | 'cloud' | 'auto'

interface AppContextValue {
  state: AppState
  // `intent` is the FULL text the engine/AI sees (may embed attached-file
  // bodies via composeWithAttachments). `displayText` is the OPTIONAL compact
  // form shown in the transcript + saved to the vault chat-log (e.g. a
  // "📎 name (N chars)" ref instead of the raw body). Omit it and the display
  // falls back to `intent` — every non-attachment caller keeps its old
  // behavior unchanged.
  // `route` is the optional per-message hint (composer local/cloud/auto);
  // 'auto'/omitted → the gateway's normal rules (byte-identical). It reaches
  // the native run and is honored WITHIN the sensitivity floor (a secret stays
  // local even under 'cloud'); the attribution chip shows the REAL outcome.
  // `image` (optional) is a picked image attached to this message: a vision
  // route sends it, a non-vision route is told honestly it wasn't sent. Omitted
  // → a text-only send, byte-identical to before image attach.
  // `proposalRequest` (2026-08-11 spec, source (b)): the user's OWN words when
  // this send is a "propose an agent" ask from Work. Present → the reply is
  // read for a PROPOSE_AGENT block whose evidence is that request, quoted.
  // Absent (every other send) → no block is ever looked for.
  sendIntent: (
    intent: string,
    displayText?: string,
    route?: RouteHint,
    image?: EngineImage,
    proposalRequest?: string,
    rosterEvidence?: RosterEvidence,
  ) => Promise<void>
  // ONE entry point for the chat composer: routes to the active project's
  // interview while it has no plan yet, else `sendIntent` (companion).
  send: (text: string, displayText?: string, route?: RouteHint, image?: EngineImage) => Promise<void>
  clearSession: () => void
  runProject: (projectId: string) => Promise<void>
  answerProjectRequest: (grant: boolean) => void
  mergeProject: (projectId: string) => Promise<void>
  clearNotice: (id: string) => void
  setActiveProject: (id: string) => void
  // Compaction levers (P2-3): `compressNow` compacts the active thread now;
  // `newSession` archives then empties one thread. Both archive-before-drop.
  compressNow: () => Promise<void>
  newSession: (threadKey: string) => Promise<void>
  // Mission Control (2026-08-05): the ONE live-run registration pair, exposed
  // so runners that live OUTSIDE this store (the Agents page's team launcher)
  // register the same way the in-store runners do — one source of live truth,
  // not two. Contract: `const id = beginLiveRun(...)`, then ALWAYS
  // `endLiveRun(id, ...)` in a `finally`. A leaked id glows forever.
  beginLiveRun: (run: { kind: LiveRunKind; intent: string; models?: string[]; id?: string }) => string
  endLiveRun: (id: string, outcome: RunOutcome, detail?: string) => void
  /** PARK / UNPARK a registered run that is waiting on a HUMAN, so nothing on
   *  the page glows or pulses while no engine is executing. Exposed alongside
   *  the pair for the same reason: an out-of-store runner that parks must be
   *  able to say so. */
  pauseLiveRun: (id: string, paused: boolean) => void
  // The app's ONE engine slot, exposed for the SAME reason: a runner outside
  // this store must take part in the one-engine-at-a-time protocol instead of
  // overlapping the manager/loop drivers. `claimEngine` returns false when
  // another run holds the slot — refuse honestly, don't queue; `releaseEngine`
  // MUST be called in a `finally`.
  claimEngine: () => boolean
  releaseEngine: () => void
  // Mission Control §Give a task from Work (2026-08-06): the ONE team launch.
  // `launchTeam` is the whole discipline (claim → run id → live run →
  // cancelable timeout → release + end) and is what the Agents page's
  // TeamLauncher calls; `sendTeam` is the chat-facing wrapper the Work composer
  // calls, which adds the user's message and reports the honest ending as a
  // `notice`. Neither surface owns a second copy of the launch.
  launchTeam: (opts: { task: string; roster?: string; tokenBudget?: number }) => Promise<TeamLaunch>
  sendTeam: (opts: {
    task: string
    display?: string
    roster?: string
    tokenBudget?: number
    caveat?: string
  }) => Promise<void>
  /** "Wake now" (2026-08-05 §Part 3): run ONE immediate beat down the exact
   *  path a scheduled wake takes. Resolves `null` when the wake really ran,
   *  else the honest reason it refused (engine busy, heartbeat off, no
   *  provider, a wake already running) — the caller shows that reason rather
   *  than letting the button look broken. Prefer `useWakeNow()`, which pairs
   *  this with the same reason computed for the disabled state. */
  wakeNow: () => Promise<string | null>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, seededState, initState)
  const idRef = useRef(0)
  const nextId = () => `m${++idRef.current}`
  const noticeIdRef = useRef(0)
  const nextNoticeId = () => `notice-${++noticeIdRef.current}`

  // Mirror the durable session (transcript + verdicts + stats) to localStorage
  // whenever any of those slices change. Transient state is never written.
  useEffect(() => {
    saveSession(state)
  }, [state.threads, state.verdicts, state.stats, state.activeProjectId])

  // Latest settings held in a ref so the memoized sendIntent reads them fresh
  // without re-creating the callback (which would churn consumer effects).
  const { settings } = useSettings()

  // The proposal ledger is merged in HERE, at provider mount — not only inside
  // the Work desk's effect. A heartbeat beat can record (and persist) a
  // proposal while the user is on any route, so the store has to know the
  // vault's history before it writes: hydrating only on the desk left every
  // other entry point writing from an empty store. Idempotent by id, native
  // only, never throws.
  useEffect(() => {
    if (!isNative()) return
    void hydrateProposalsFromVault(settings.vaultPath)
  }, [settings.vaultPath])

  // Tool-policy MIGRATION, at provider mount — the one place every route and
  // every driver (heartbeat, manager jobs, chat) sits under, so an existing
  // install heals itself on the next launch instead of only when the user
  // happens to re-save their tool posture. Two migrations run here:
  //
  //  * the server-level `vault` grant — without it a policy that requires
  //    approval holds the companion's own read-only note tools: the blocking
  //    broker waits, and the wake dies at the 240s client cancel every cadence.
  //  * the read-only CLASS grant (2026-08-17) — the `all` sentinel charges a
  //    separate approval prompt for every tool NAME, which is why he was asked
  //    "again and again" (32 held calls in his spans, every one a read). This
  //    frees what the engine PROVES read-only; acting tools stay held.
  //
  // Idempotent, write-only-when-it-changes, never throws — see
  // ensureToolPolicyMigrated.
  useEffect(() => {
    if (!isNative()) return
    void resolveVaultDir(settings.vaultPath)
      .then((vault) => ensureToolPolicyMigrated(vault))
      .catch(() => {
        /* a migration is best-effort: a broken vault path must not break boot */
      })
  }, [settings.vaultPath])
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Telegram reports (companion grant): keep the fire-and-forget notifier in
  // sync with settings — cheap module-var assignment, safe every render.
  configureTelegram({
    enabled: settings.telegramReports,
    token: settings.telegramBotToken,
    chatId: settings.telegramChatId,
  })
  // …and the INBOUND half (2026-08-11 spec): the same one switch starts and
  // stops the native poller that lets a phone tap answer something already
  // parked. Off / unconfigured → the poller is stopped and the token forgotten.
  configureTelegramApprovals({
    enabled: settings.telegramReports,
    token: settings.telegramBotToken,
    chatId: settings.telegramChatId,
    vaultPath: settings.vaultPath,
  })

  // Same ref bridge for the Workspace's bound project (P2-4/Slice 1a), so the
  // memoized sendIntent reads the CURRENT active project — not whatever it was
  // when sendIntent was first created — without re-creating the callback.
  const activeProjectIdRef = useRef(state.activeProjectId)
  activeProjectIdRef.current = state.activeProjectId

  // Same ref bridge for live connectivity, so the memoized sendIntent can read
  // current health / probeOne / markUnreachable without re-creating itself.
  const connectivity = useConnectivity()
  const connectivityRef = useRef(connectivity)
  connectivityRef.current = connectivity

  // Fresh-state ref for the compaction driver (P2-3): it must read the CURRENT
  // threads, not whatever they were when the memoized driver was first created.
  const stateRef = useRef(state)
  stateRef.current = state

  // Re-entry guard: at most one compaction in flight per thread key, so an
  // auto-trigger effect can't stack a second pass on top of one still running.
  const compactingRef = useRef<Set<string>>(new Set())

  // ---- Mission Control: the ONE live-run registration pair (2026-08-05) ----
  //
  // Every runner in this store (chat send, project build, project interview,
  // manager job, team job) and the Agents page's team launcher goes through
  // these two functions and NOTHING else. The contract, which the Work page's
  // glow depends on absolutely:
  //
  //   const id = beginLiveRun(...)
  //   try { ...the real run... } finally { endLiveRun(id, outcome, detail) }
  //
  // The `finally` is mandatory — a throw, a timeout, an early return or an
  // unmount must all clear the entry, because a leaked entry is a card that
  // glows with no run behind it (fabricated activity). The heartbeat is the
  // one exception BY DESIGN: it registers through the existing
  // SET_HEARTBEAT_LIVE transition (see the reducer) so the orb and the card
  // share one signal instead of two that could drift apart.
  const beginLiveRun = useMemo(() => {
    return (run: { kind: LiveRunKind; intent: string; models?: string[]; id?: string }): string => {
      const id = run.id ?? newRunId()
      dispatch({
        type: 'LIVE_RUN_START',
        run: {
          id,
          kind: run.kind,
          intent: shortIntent(run.intent) || kindFallbackIntent(run.kind),
          startedAt: Date.now(),
          models: run.models ?? [],
        },
      })
      return id
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const endLiveRun = useMemo(() => {
    return (id: string, outcome: RunOutcome, detail = ''): void => {
      dispatch({ type: 'LIVE_RUN_END', id, at: Date.now(), outcome, detail })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // PARK a live run while it waits on a HUMAN (the build's "one more refine?"
  // gate). The run stays registered because it really does resume on the
  // answer — but its engine subprocess has already exited, so from the park
  // until the answer NOTHING is executing and nothing may claim otherwise.
  // Symmetric: park true on the way in, false on the way out, in the same
  // block; the `finally` that ends the run clears the whole entry anyway.
  const pauseLiveRun = useMemo(() => {
    return (id: string, paused: boolean): void => {
      dispatch({ type: 'LIVE_RUN_PAUSE', id, paused })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Manager driver: app-wide, deterministic, serial (ADR-007) ----
  // Ticks every 30s on ANY page; runs one due maintenance job at a time
  // through the REAL engine under the manager's own provider. A 'report' job
  // appends prose to <vault>/reports/ (unchanged); a 'dispatch' job runs the
  // FULL verified pipeline (Tier-1 kept) behind the ask/auto approval gate
  // and surfaces its Verdict via ADD_VERDICT, in addition to the report note.
  // When NO job is due, a due companion heartbeat takes the slot instead
  // (heartbeatWake below — 2026-07-29 spec).
  // Both engine-driver busy-refs are declared UP HERE (before the manager
  // driver effect) so all three engine paths — the manager driver below,
  // `runProject`, and the P2-3 loop driver — can read each other's ref for
  // the symmetric `engineBusy` serialization. `loopBusyRef` is set/cleared by
  // the loop driver effect further down and by `claimEngine`/`releaseEngine`
  // (an out-of-store runner taking the same slot); nothing else writes it.
  const managerBusyRef = useRef(false)
  const loopBusyRef = useRef(false)

  // ---- The app's ONE engine slot, for runners OUTSIDE this store ----
  //
  // The Agents page's team launcher is a real engine run that bypassed the busy
  // protocol entirely: it could start on top of a manager job or a standing
  // loop, and two engines appending to the ONE spans.jsonl is exactly the
  // condition that makes span attribution unprovable. It now claims the same
  // slot the in-store drivers use, and refuses honestly when it can't get it.
  //
  // The claim is `loopBusyRef` deliberately, not a fourth ref: that ref is
  // already the "an app-level engine run is in flight" signal that the loop
  // driver's tick guard, the manager driver and `runProject` all read, so
  // claiming it makes every existing runner yield with no new plumbing. The
  // check-and-set is synchronous (nothing awaited between), so two callers can
  // never both win the slot.
  const claimEngine = useMemo(() => {
    return (): boolean => {
      if (engineBusy(loopBusyRef.current, managerBusyRef.current, getProjects().projects)) return false
      loopBusyRef.current = true
      return true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const releaseEngine = useMemo(() => {
    return (): void => {
      loopBusyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- The ONE team launch, shared by the Agents page and the Work composer ----
  //
  // This is the whole launch discipline in one place: claim the shared engine
  // slot (or refuse — never queue), mint ONE run id that is both the live card's
  // id and the engine child's cancellation handle, register the live run so the
  // Work page's cards/narration/console light up for it, race a cancelable
  // timeout that really kills the child, and ALWAYS release + end in the
  // `finally`. Both callers get the tagged outcome and render it their own way;
  // neither owns a second copy of any of the above, so they cannot drift.
  const launchTeam = useMemo(() => {
    return async (opts: {
      task: string
      roster?: string
      tokenBudget?: number
      /** 'converse' judges a question put to the board as a conversation —
       *  the composer's team target passes it; the Agents launcher (a task
       *  launcher) keeps the read default. */
      mode?: string
    }): Promise<TeamLaunch> => {
      const task = opts.task.trim()
      if (!task) return { status: 'failed' }
      const s = settingsRef.current
      const asked = (opts.roster ?? '').trim() || teamRosterFromSettings(s)
      // THE GATE (2026-08-12). Every seat is checked against the provider it
      // would really run on — enabled, credentialed, and (for a subscription
      // CLI) proven able to answer — before the engine is asked for anything.
      // Whoever can't play is dropped WITH a reason the caller must show; if
      // that leaves nobody, the launch is refused in those same words rather
      // than run as a single offline stub calling itself a team.
      const gate = rosterGate(s, { health: connectivityRef.current.health as ProviderHealthMap })
      const { roster, sitOut, reassigned } = filterRoster(asked, gate, s)
      if (!roster) return { status: 'refused', reason: emptyRosterRefusal(sitOut), sitOut, reassigned }
      // The user's own budget outranks the built-in default. It was invisible
      // and unchangeable until 2026-09-03, when a real board breached it, lost
      // its third agent and returned an empty answer — with no way to see the
      // limit or raise it. An explicit per-call budget still wins over both.
      const chosen = clampBudget(Number(s.tokenBudget ?? 0))
      const budget =
        opts.tokenBudget && opts.tokenBudget > 0
          ? opts.tokenBudget
          : chosen || TEAM_TOKEN_BUDGET
      // The busy protocol. A team run is a full engine run: starting it on top
      // of the manager driver, a standing loop or a project build would put TWO
      // engines on one spans.jsonl, after which no span can be honestly
      // attributed to either. Refuse and say so — nothing starts, nothing
      // registers, nothing is queued behind the user's back.
      if (!claimEngine()) return { status: 'busy' }
      const teamRunId = newRunId()
      // The roster the user asked for is a real REQUEST fact; which model
      // actually spoke comes from the run's real spans, never from here.
      const liveId = beginLiveRun({
        id: teamRunId,
        kind: 'team',
        intent: task,
        models: roster.split(',').map((a) => a.trim()).filter(Boolean),
      })
      let outcome: RunOutcome = 'stopped'
      let detail = 'the team run ended without a recorded outcome'
      try {
        const { providers } = buildEngineProviders(s)
        const vault = await resolveVaultDir(s.vaultPath)
        // PER-AGENT CAPABILITIES (2026-08-15). A seat staffed from an approved
        // project roster carries its granted capabilities; those become the
        // engine's grant table, which REFUSES any tool outside them
        // (capabilities.AgentCapabilityGate.call_tool). The user's own grant
        // goes with it as the ceiling — the engine intersects again, so the app
        // cannot widen anything here even by mistake. A roster with no staffed
        // seat sends nothing at all, and that run is byte-identical to before.
        const seatNames = splitRoster(roster).map((p) => p.role)
        const library = listAgents()
        const caps = teamCapabilityArgs(
          seatNames.map((name) => ({
            name,
            // A SEAT NAME IS A SLUG. `splitRoster` yields the roster's own
            // `<slug>:<token>` role, so an agent whose display name is
            // "Reviewer / Verifier" (slug `reviewer-verifier`) never matched
            // itself here — it landed in --agent-capabilities with [], and an
            // empty entry grants NOTHING (capabilities.py: AgentGrants). It
            // only ever went unnoticed because no project had been staffed yet.
            // Match on the slug, keeping the display-name comparison as a
            // fallback for a roster typed in the agent's own words.
            capabilities: agentCapabilityNames(
              library.find(
                (a) => agentSlug(a.name) === name || agentNameKey(a.name) === agentNameKey(name),
              ),
            ),
          })),
          // The CEILING — one definition, shared with the desk that showed the
          // roster, so what was approved and what is enforced are the same list.
          appRunCapabilities(s),
        )
        if (caps) {
          providers.userCapabilities = caps.userCapabilities
          providers.agentCapabilities = caps.agentCapabilities
        }
        const teamOutcome = await raceCancelable(
          runNativeTeam(task, vault, providers, roster, 1, budget, teamRunId, 0, opts.mode ?? ''),
          TEAM_TIMEOUT_MS,
          teamRunId,
        )
        const res = teamOutcome.timedOut ? null : teamOutcome.value
        if (res) {
          outcome = res.passed ? 'passed' : 'failed'
          detail = res.passed ? '' : 'the team run did not pass'
          // The sit-outs travel WITH the result: whatever renders the board has
          // to be able to say who wasn't at the table and why.
          return { status: 'ok', result: res, sitOut, reassigned }
        }
        if (teamOutcome.timedOut) {
          detail = 'stopped at 300s'
          // The wall stays; throwing the work away does not. Everything the
          // board got done is already on disk — read it back and say so, so a
          // stopped run reports its findings instead of vanishing.
          let salvage = ''
          try {
            salvage = teamSalvageLine(await readSpansTail(vault, 400), teamRunId)
          } catch {
            /* no spans readable -> no claim made */
          }
          return { status: 'timeout', salvage }
        }
        outcome = 'failed'
        detail = 'the team run returned nothing'
        return { status: 'failed' }
      } catch (err) {
        outcome = 'failed'
        detail = 'the team run failed to start'
        throw err
      } finally {
        releaseEngine()
        // The ONE guaranteed clear — otherwise the card glows with no run.
        endLiveRun(liveId, outcome, detail)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Give a task to the team FROM THE CHAT (Work composer). Thin: the user's ask
  // goes in as their own message, `launchTeam` does the real work, and the
  // ending is reported in the transcript as a `notice` — the app speaking, not a
  // model. A busy slot is refused IN THE CHAT in the same words the Agents page
  // uses; nothing is queued and nothing claims to be running.
  const sendTeam = useMemo(() => {
    return async (opts: {
      task: string
      display?: string
      roster?: string
      tokenBudget?: number
      /** Something the launch could NOT carry, posted as its own notice right
       *  away — used to say honestly that an attached image was not sent (a team
       *  run takes text only). At the start, not at the end: the user must know
       *  before the run's five minutes, not after. */
      caveat?: string
    }): Promise<void> => {
      const task = opts.task.trim()
      if (!task) return
      const thread = activeThreadKey(activeProjectIdRef.current)
      const display = (opts.display ?? task).trim() || task
      const notice = (text: string): void => {
        dispatch({ type: 'ADD_MESSAGE', thread, message: { id: nextId(), kind: 'notice', text } })
      }
      dispatch({ type: 'ADD_MESSAGE', thread, message: { id: nextId(), kind: 'user', text: display } })
      if (opts.caveat) notice(opts.caveat)
      let launch: TeamLaunch
      try {
        // The composer is a CHAT channel: a task typed there and sent to the
        // team is judged as a conversation unless it is a build ask — the
        // same channel rule solo chat uses (bc6c193). The Agents launcher
        // calls launchTeam directly and keeps the read default.
        launch = await launchTeam({
          task,
          roster: opts.roster,
          tokenBudget: opts.tokenBudget,
          mode: 'converse',
        })
      } catch {
        launch = { status: 'failed' }
      }
      if (launch.status === 'busy') {
        notice(TEAM_BUSY_TEXT)
        return
      }
      if (launch.status === 'timeout') {
        notice(
          launch.salvage ? `${TEAM_TIMEOUT_TEXT}\n\n${launch.salvage}` : TEAM_TIMEOUT_TEXT,
        )
        return
      }
      if (launch.status === 'failed') {
        notice(TEAM_FAILED_TEXT)
        return
      }
      // Nobody could run: say so, in the reason's own words, and stop. Never
      // "team run failed" — nothing was started and the fix is in Settings.
      if (launch.status === 'refused') {
        notice(launch.reason)
        return
      }
      // A seat that sat out is told BEFORE the result, so the synthesis is read
      // knowing who wasn't in the room.
      if (launch.sitOut.length > 0) notice(sitOutLine(launch.sitOut))
      if (launch.reassigned.length > 0) notice(reassignLine(launch.reassigned))
      // Each seat's REAL contribution as its own bubble, read from the
      // persisted board record (never from memory of the run). Best-effort:
      // a missing/unreadable board changes nothing else about the report.
      try {
        const bp = launch.result.board_path
        if (bp) {
          const vault = await resolveVaultDir(settingsRef.current.vaultPath)
          const rel = bp.startsWith(vault + '/') ? bp.slice(vault.length + 1) : `agents/${bp.split('/').pop() ?? ''}`
          const raw = await readVaultFile(vault, rel)
          if (raw) {
            for (const m of seatMessagesFromBoard(raw)) {
              dispatch({
                type: 'ADD_MESSAGE',
                thread,
                message: { id: nextId(), kind: 'seat', ...m },
              })
            }
          }
        }
      } catch {
        // board unavailable — the synthesis + notices still tell the story
      }
      notice(teamNoticeText(launch.result))
      // The lead's real synthesis, when the run produced one. An empty
      // synthesis posts NOTHING rather than a placeholder reply.
      const synthesis = launch.result.synthesis.trim()
      if (synthesis) {
        dispatch({
          type: 'ADD_MESSAGE',
          thread,
          // The MANAGER is in charge (his design): the synthesis bubble says
          // so — it is the manager's reading of the whole board, not another
          // seat's turn.
          message: {
            id: nextId(),
            kind: 'assistant',
            text: synthesis,
            model: 'Manager · synthesis of the board',
          },
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Heartbeat wake (2026-07-29 spec §Wake) — the companion's beat. ----
  // Runs in the tick's slot when NO maintenance job is due, under the same
  // busy-ref. One governed run through the NORMAL primary path (that is the
  // companion's providerId 'primary' semantics): real state in, ONE small
  // piece of work or an honest `NOTHING_NEEDED — <line>` out. The outcome is
  // ALWAYS a Beat record — orb line == beat == what actually ran.
  //
  // Hoisted out of the driver effect (2026-08-05 §Part 3) so "Wake now" runs
  // THIS function and not a second copy: same 20k token budget, same gates,
  // same beat record, same SET_HEARTBEAT_LIVE registration. `opts.manual` only
  // changes two honest details — the live line says the user asked, and the
  // multi-instance "already beaten on disk" guard is skipped, because a manual
  // wake is not a cadence beat that another instance could have taken.
  const heartbeatWake = useMemo(() => {
    return async (
      companion: Manager,
      hb: Heartbeat,
      opts: { manual?: boolean } = {},
    ): Promise<void> => {
      const slug = reportSlug
      const s = settingsRef.current
      const name = managerDisplayName(companion, s)
      // 0. DON'T WORK ON A SLEEPING MAC (2026-08-15 spec §1). A maintenance
      // DarkWake gives a wake ~90s of real CPU time spread over the better part
      // of an hour (4f95483 measured it from pmset), so the run cannot finish
      // and dies at the app's wall-clock cancel — after paying for it. Asking
      // costs one `pmset -g systemstate`; the answer is checked BEFORE anything
      // is spent, and the skip is RECORDED so the gap in the beat log is
      // explained rather than silent.
      //
      // Two disciplines: an INDETERMINATE answer runs (never skip work on a
      // guess — readPowerState degrades to 'unknown', never to 'dark'), and a
      // MANUAL wake is never skipped: the user pressed the button, he is
      // demonstrably at the machine, and refusing him on a power reading would
      // be the app arguing with a human about whether his Mac is awake. Nothing
      // here holds a power assertion — he chose defer, not keep-awake.
      if (!opts.manual) {
        const power = await readPowerState()
        if (shouldSkipWake(power.state)) {
          // A SKIP GIVES BACK THE TIME IT DID NOT USE (2026-08-27). This used to
          // record an ordinary beat, which advanced the cadence and cost the
          // whole hour the skip landed in — six maintenance wakes in one night
          // left the manager idle from 02:37 to 09:55 having run nothing at all.
          // `recordManagerSkip` records the same honest line but schedules the
          // next attempt minutes away, and collapses a run of skips into one
          // self-counting beat so the faster retry cannot flush the real history
          // out of the capped log.
          recordManagerSkip(companion.id, Date.now(), power.detail)
          return
        }
      }
      const { providers: baseProviders, primaryReal } = buildEngineProviders(s)
      // A wake asks for ONE first-line summary, so it does not need the
      // engine's 4096-token answer ceiling — and on a local model generating at
      // roughly five tokens a second, that ceiling is thirteen minutes of
      // inference per call. Capping it took the worst local call in a measured
      // wake from 413s to 237s. Claude is unaffected: the gateway floors
      // max_tokens per effort level, so this only bites the slow route.
      // A WAKE IS ONE PIECE OF WORK, SO IT PLANS ONE STEP.
      //
      // The engine's default plan — understand, then locate, then produce —
      // gives every step its own tool loop and its own turn budget, so the wake
      // did the same research three times over. Measured end to end against the
      // real engine: the default plan cost 15m24s and 69,976 tokens to return
      // "I ran out of tool turns"; one step cost 4m29s and 8,993. That is the
      // difference between a companion that never once completed and one that
      // has a chance to.
      // THE WAKE NAMES ITSELF. Until now a wake wrote no `agent` attr, so the
      // one piece of work the app does entirely on its own was the one piece
      // nothing could attribute — no seat on the board, no file to open, and
      // "who did this?" answerable only by inference from the timestamp.
      const providers = {
        ...baseProviders,
        maxTokens: WAKE_MAX_TOKENS,
        steps: WAKE_STEPS,
        agentName: name,
        stage: 'Check-in',
        noVaultTools: !WAKE_VAULT_TOOLS,
      }
      if (!primaryReal) {
        recordManagerBeat(companion.id, {
          at: Date.now(),
          action: 'rested',
          line: 'primary AI not connected — no run',
          ok: false,
          tokens: 0,
        })
        return
      }
      const vault = await resolveVaultDir(s.vaultPath)
      // 1. REAL state, gathered cheaply from the stores: project statuses,
      // needs-you counts (awaiting/attention projects + parked dispatches —
      // the desk's store-derived kinds; held/pending tool-call reads stay
      // Desk-internal plumbing, so v1 skips those counts rather than
      // approximating them), and recent beat lines so wakes don't repeat.
      const projects = getProjects().projects
      const needsYou =
        projects.filter((p) => p.status === 'awaiting' || p.status === 'attention').length +
        getManagers().jobs.filter((j) => (j.pendingSince ?? 0) > 0).length
      const statusLines = projects.slice(0, 12).map((p) => `- ${p.name}: ${p.status}`)
      const recent = hb.beats.slice(0, 5).map((b) => `- ${b.action}: ${b.line}`)
      // The wake may PROPOSE one new agent (2026-08-11 spec) — never create
      // one. The evidence pool is the REAL task ids of runs this app recorded;
      // the parser below accepts nothing outside it, and with an empty pool the
      // charter tells the model plainly not to propose at all.
      const evidencePool = proposalEvidencePool(stateRef.current.verdicts)
      // The charter asks the model to certify that NO EXISTING AGENT covers the
      // gap — so it is told which agents exist. Without this the certification
      // was guesswork, and a duplicate name (refused by the store anyway) cost
      // a whole beat.
      const existingAgents = listAgents()
        .filter((a) => a.enabled)
        .map((a) => a.name)
      // The LADDER (2026-08-15 spec §3). The charter says how to climb it; this
      // says what each rung actually holds right now, so an empty rung is known
      // to be empty instead of being written about. Rung 4's fuel is the
      // business-context note — the ONE thing he knows about the business, read
      // from the vault every wake because that note is the only memory.
      const businessNote = await readBusinessContext(s.vaultPath)
      const thin = contextThin(businessNote)
      // Metadata, not just a count: "8 notes" cannot tell an edited vault from
      // an untouched one, which is exactly what the unchanged-state guard below
      // needs to know. The ladder still only reads the count.
      const vaultMeta = await listVaultTreeMeta(vault)
      const vaultNotes = vaultMeta.length
      const ladder = ladderBrief({
        needsYou,
        vaultNotes,
        projects: projects.length,
        businessContext: !thin,
      })
      // He may INTERVIEW (spec §4) only when nothing is waiting on the user, the
      // note is still thin, and no question set is already open. The prompt is
      // told about the option only when the app would actually accept a block —
      // inviting questions it would then refuse is how a model ends up asking
      // the user something he never sees.
      const mayAsk = askBlockedReason({ needsYou, contextThin: thin, sets: listQuestionSets() }) === null
      // THE UNCHANGED-STATE GUARD (2026-08-28). Everything the wake would
      // paste into its prompt is now in hand — if none of it has moved since
      // the last REAL beat, the model has already seen this exact world and
      // said its piece about it. Eleven hourly wakes spent 48,826 tokens on
      // 2026-08-28 re-discovering "Same 8 notes, the same 'new' node cli
      // project"; this comparison is deterministic and free. A MANUAL wake
      // always runs (the user pressed the button), and a print past the
      // re-anchor floor runs too — an idle vault must not mean the companion
      // never checks in again. The companion's own report dir is excluded so
      // a worked beat's write cannot arm the next wake.
      const print = wakeFingerprint({
        needsYou,
        projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
        vaultNotes: vaultMeta,
        excludePrefixes: [`reports/${slug(name)}/`],
        businessNote: businessNote ?? '',
        evidencePool,
        agents: existingAgents,
        questionSetIds: listQuestionSets().map((q) => `${q.id}|${q.status}`),
        charter: hb.charter,
        everyMinutes: hb.everyMinutes,
      })
      if (
        !opts.manual &&
        hb.lastPrint &&
        hb.lastPrint.hash === print &&
        Date.now() - hb.lastPrint.at < REST_REANCHOR_MS
      ) {
        recordManagerRest(companion.id, Date.now())
        return
      }
      const intent = [
        `[HEARTBEAT · ${name}] ${hb.charter}`,
        ladder,
        statusLines.length ? `Project statuses:\n${statusLines.join('\n')}` : 'Projects: none yet.',
        `Items waiting on the user right now: ${needsYou}.`,
        businessNote
          ? `Business context you have been GIVEN (${'business/context.md'}) — this is everything you know about the business, and the note itself says which parts came from the user:\n${businessNote.slice(0, 4000)}`
          : 'You have been given NO business context. Do not write about this business as if you had; ask instead, if you are allowed to below.',
        recent.length ? `Your recent beats (do NOT repeat them):\n${recent.join('\n')}` : '',
        // The summary is asked for on a MARKED line, not "the first line".
        // A reasoning model opens by thinking aloud — the first wake that ever
        // completed its research began "Let me think about the ladder:", and
        // that became the line shown in the orb and the beat log. Asking for a
        // marker lets the thinking stay in the reply where it belongs while the
        // one-line summary is still findable.
        // WHAT IT CAN ACTUALLY REACH THIS WAKE. Without this the model
        // discovers its own limits by trying, and then reports them as a
        // FAULT: the first quick wake answered "the vault files aren't
        // reachable from this session", which reads like something is broken
        // when nothing is — it simply was not given those tools. An agent that
        // knows its own grants can rest honestly instead of apologising for a
        // door that was never there.
        WAKE_VAULT_TOOLS
          ? 'You can read your vault this wake (vault_list / vault_read).'
          : 'You have NO vault tools this wake — everything you know is in this message. That is deliberate, not a fault: do not describe the vault as unreachable or broken, and do not guess at what is in it. Work from the state above, or rest.',
        'Do ONE small useful piece of work within your existing grants. Start your reply with `SUMMARY: <one line saying what you did>` and then write the detail below it. If there was nothing to do, reply exactly `NOTHING_NEEDED — <one honest line>` and nothing else.',
        mayAsk ? askCharter(askedQuestions(listQuestionSets(), businessNote)) : '',
        proposalCharter(evidencePool, existingAgents),
      ]
        .filter(Boolean)
        .join('\n\n')
      // Multi-instance double-wake guard: a SECOND app instance shares this
      // persisted managers store and runs its own 30s tick, so both could see
      // the same beat due and each burn a run. Re-read the DISK copy (the same
      // storeGet the managers lib hydrates from) and re-evaluate due-ness with
      // the disk lastBeat — if another instance already advanced it, skip
      // WITHOUT recording anything (its beat is the real one). Cheap (one
      // small JSON read per due beat) and throw-safe: any read/parse failure
      // proceeds as before, so the guard can only ever suppress a double
      // wake, never a legitimate one. A MANUAL wake skips it: the user asked
      // for a beat now, so "another instance already covered the cadence" is
      // not a reason to silently do nothing after a button press.
      try {
        const raw = opts.manual ? null : await storeGet('managers')
        if (raw) {
          const disk = JSON.parse(raw) as {
            managers?: { id?: string; heartbeat?: { lastBeat?: number } }[]
          }
          const diskLast = disk.managers?.find((m) => m?.id === companion.id)?.heartbeat?.lastBeat
          if (typeof diskLast === 'number' && !beatDue(Date.now(), { ...hb, lastBeat: diskLast })) {
            return
          }
        }
      } catch {
        /* unreadable disk copy → proceed on the in-memory view, as before */
      }
      // The wall for THIS wake on THIS Mac, measured the same way the chat
      // measures its own: p90 of the slower route over the last 200 spans. A
      // wake is pinned local the moment it reads the business note, and a local
      // call here has been timed at anything from 33s to 413s — so a fixed
      // number could only ever be wrong in one direction or the other. Read
      // once, before the run, and used for BOTH the cancel and the line that
      // reports it, so the beat can never name a wall we did not use.
      const wakeWall = wakeWallMs(
        turnBudget(
          latencyFromSpans(
            await readSpansTail(vault, 200),
            s.providers.find((p) => p.id === 'local')?.model ?? '',
          ),
        ),
      )
      // 2. One governed run. The live line exists ONLY around the real run and
      // is ALWAYS cleared — the orb may never pulse while idle. Mission
      // Control rides this SAME transition (see the reducer), so the wake's
      // live card starts and ends with the orb, never separately.
      dispatch({
        type: 'SET_HEARTBEAT_LIVE',
        line: `${name} is awake — one governed check running${opts.manual ? ' (you asked)' : ''}`,
        at: Date.now(),
      })
      // The honest ending for the finished row, mirroring the Beat this wake
      // records. Default 'stopped': if the flow leaves by a path that recorded
      // no beat at all, the row says the outcome is unknown rather than
      // claiming a pass or a fail.
      let beatEnd: { outcome: RunOutcome; detail: string } = {
        outcome: 'stopped',
        detail: 'the wake ended without recording a beat',
      }
      try {
        const hbRunId = newRunId()
        const outcome = await raceCancelable(
          // "ONE small piece of work" is a REAL bound, not just prompt text:
          // 20k tokens ride the run's contract envelope (`--token-budget`),
          // so a runaway wake fails its Verdict instead of spending freely.
          // Chat runs pass nothing → 0 → flag omitted → byte-identical.
          runNativeTask(
            intent,
            vault,
            providers,
            hbRunId,
            undefined,
            undefined,
            WAKE_TOKEN_BUDGET,
            WAKE_TOOL_TURNS,
          ),
          wakeWall,
          hbRunId,
        )
        const verdict = outcome.timedOut ? null : outcome.value
        const real = !!verdict && isRealCompletion(verdict.response)
        // 4. Tokens from the verdict accrue to the beat — a real sum, never
        // an estimate (the card's per-day line adds these up).
        const tokens = verdict ? verdict.tokensIn + verdict.tokensOut : 0
        if (!real) {
          // No real reply → no work happened: an honest failed rest, never a
          // fabricated 'worked'. A TIMEOUT is its own honest line — the run
          // was killed at the 240s client bound (possibly parked on a held
          // tool approval), which is not "provider offline". tokens stays 0
          // for a timeout: no Verdict ever came back, so the killed run's
          // provider-side spend is unknowable from here — recording any
          // number would be an estimate, which beats never carry.
          // When the ENGINE named the cause (e.g. it killed a subscription CLI
          // at its own bound), say THAT — it is the truth and it is actionable.
          // Only an unexplained non-reply falls back to "provider offline?".
          const named = outcome.timedOut ? '' : offlineReason(verdict?.response)
          const line = outcome.timedOut
            ? weStoppedIt(
                wakeWall,
                'it may have been on a held tool approval, or still answering on your local model',
              )
            : named || 'no real reply — provider offline?'
          recordManagerBeat(companion.id, {
            at: Date.now(),
            action: 'rested',
            line,
            ok: false,
            tokens,
          })
          beatEnd = { outcome: outcome.timedOut ? 'stopped' : 'failed', detail: line }
          return
        }
        // The model actually answered over this exact state — stamp the print,
        // so an unchanged world rests for free until something moves (or the
        // re-anchor floor forces the next real look). Stamped ONLY here: a
        // failed or timed-out wake must retry on its cadence, never hide
        // behind a print it did not honestly earn.
        setHeartbeatPrint(companion.id, { hash: print, at: Date.now() })
        // 3. Outcome → Beat. 'worked' appends the FULL reply to the heartbeat
        // report + notifies (outcome-only, as always); 'rested' records the
        // honest line only — no report entry, no phone line. A blank /
        // whitespace-only reply is neither: parseWakeReply classifies it
        // 'rested' with the blank-reply line, and it records ok:false (no
        // vault write, no Telegram) — an empty reply is a failure, not rest.
        // HEARTBEAT BEAT LINE + the heartbeat report both derive from this
        // string (parseWakeReply reads its first line), so the tool_call guard
        // applies once, here, at the point the raw completion enters the app.
        const text = guardAnswerText(verdict!.response as string)
        // A trailing PROPOSE_AGENT block (source (a)). It records a proposal
        // ONLY when the block is well-formed and cites evidence from the
        // verified pool above; otherwise it is ignored and the beat says why —
        // never coerced into a proposal. '' when the reply carries no block, so
        // an ordinary wake's beat line is byte-identical.
        const proposalNote = recordProposalFromReply(text, evidencePool, s.vaultPath)
        // A trailing ASK_BUSINESS block (2026-08-15 spec §4) — up to three
        // questions parked on the DESK. Same discipline as the proposal above:
        // the gate is re-checked here (state can have moved while the run was
        // in flight), and an ignored block says why in the beat line.
        const askNote = recordQuestionsFromReply(
          text,
          { needsYou, contextThin: thin },
          businessNote,
          s.vaultPath,
        )
        // Classify the PROSE ALONE. Appending a proposal block (accepted or
        // refused) must not turn `NOTHING_NEEDED — everything is quiet` into
        // "worked": that fabricated a work entry in the heartbeat report, a
        // success line to the phone, and a 'worked' beat for a wake that did
        // nothing. A proposal is a suggestion, not work — and asking a question
        // is not work either, so its block comes out of the prose too.
        const prose = stripAskBlock(stripProposalBlock(text))
        const { action, line: replyLine } = parseWakeReply(prose)
        // A reply that was ONLY a block still said something real if a proposal
        // or a question set came out of it; blank prose with neither is the
        // honest failure it always was.
        const blank = prose.trim() === '' && proposalNote === '' && askNote === ''
        const line = beatLineWithNote(replyLine, `${proposalNote}${askNote}`)
        if (action === 'worked') {
          const rel = `reports/${slug(name)}/heartbeat.md`
          const existing = (await readVaultFile(vault, rel)) ?? `# Heartbeat — ${name}\n`
          const entry = `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · worked\n\n${text}\n`
          // A swallowed write must not masquerade as a clean beat: on a null
          // return (write failed) the beat records ok:false with an honest
          // suffix, and the phone line reports the FAILURE outcome — never
          // the passed line for a report that does not exist.
          const wrote = await writeVaultNote(vault, rel, trimReport(existing, entry))
          notifyManagerReport(name, 'heartbeat', wrote !== null)
          const beatLine = wrote !== null ? line : `${line} (report write failed)`
          recordManagerBeat(companion.id, {
            at: Date.now(),
            action,
            line: beatLine,
            ok: wrote !== null,
            tokens,
          })
          beatEnd = { outcome: wrote !== null ? 'passed' : 'failed', detail: beatLine }
          return
        }
        recordManagerBeat(companion.id, { at: Date.now(), action, line, ok: !blank, tokens })
        beatEnd = { outcome: blank ? 'failed' : 'passed', detail: line }
      } finally {
        // Clears the orb AND the live card in one honest transition.
        dispatch({
          type: 'SET_HEARTBEAT_LIVE',
          line: null,
          at: Date.now(),
          outcome: beatEnd.outcome,
          detail: beatEnd.detail,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- "Wake now" (2026-08-05 §Part 3) — one immediate, REAL beat. ----
  //
  // Not a shortcut path: it calls the SAME `heartbeatWake` a scheduled beat
  // calls, so it inherits the 20k token budget, the governed run, the live-run
  // registration (orb + card + console) and the Beat record. What it adds is a
  // gate and a guard:
  //
  // - The gate is `wakeNowBlockReason` — the same pure predicate both buttons
  //   render their disabled state from, re-checked HERE against the live refs
  //   before anything is spent. A refusal returns its honest reason for the
  //   caller to show; the button never appears to do nothing.
  // - The guard against double-fire is synchronous: the check and the two ref
  //   writes happen with nothing awaited between them, so a second click
  //   (or a driver tick landing in the same instant) can only ever see busy.
  //
  // It does not disturb the cadence beyond what a real beat does: recordBeat
  // advances `lastBeat` exactly as a scheduled wake's beat would.
  const wakeNowRef = useRef(false)
  const wakeNow = useMemo(() => {
    return async (): Promise<string | null> => {
      const companion = getManagers().managers.find((m) => m.id === COMPANION_MANAGER_ID)
      const hb = companion?.heartbeat
      const s = settingsRef.current
      const reason = wakeNowBlockReason({
        hb,
        primaryReal: isNative() ? buildEngineProviders(s).primaryReal : false,
        waking: wakeNowRef.current || stateRef.current.heartbeatLive !== null,
        engineBusy: managerBusyRef.current || engineBusy(loopBusyRef.current, false, getProjects().projects),
      })
      if (reason) return reason
      wakeNowRef.current = true
      managerBusyRef.current = true
      try {
        await heartbeatWake(companion!, hb!, { manual: true })
      } finally {
        managerBusyRef.current = false
        wakeNowRef.current = false
      }
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartbeatWake])

  useEffect(() => {
    if (!isNative()) return
    const slug = reportSlug
    /**
     * ONE notice per finished manager job (2026-08-16 Finding 2b).
     *
     * These jobs really do run — on this user's machine, 22 recorded runs with
     * real reports on disk — but nothing ever told him: the live card exists
     * only for the ~4 minutes of the run, `finishedRuns` is deliberately never
     * persisted, and he restarts the app constantly. So a completion now lands
     * on the Companion orb (badge + one toast) with a pointer to the REAL
     * report file it wrote.
     *
     * Discipline: OUTCOME ONLY (the same rule the Telegram mirror keeps — no
     * "started"/progress lines), and exactly one per completion — this is
     * called from the same place `recordJobRun` is, i.e. once per finished
     * job, never per 30s tick.
     */
    const noticeJobDone = (
      job: ManagerJob,
      managerName: string,
      ok: boolean,
      reportPath: string,
    ): void => {
      dispatch({
        type: 'ADD_NOTICE',
        notice: {
          id: nextNoticeId(),
          projectId: job.id,
          kind: ok ? 'done' : 'attention',
          text: `${managerName} · ${job.title} — ${ok ? 'done' : 'needs attention'}. Report: ${reportPath}`,
          to: '/automations',
        },
      })
    }
    const tick = async () => {
      // THE LOOP IS ALIVE. Recorded before every guard below, because the guards
      // are exactly what this is here to see past: a driver that sends every
      // tick home early looks identical to a manager with nothing to do, and
      // that is how Sukhdeep's manager went a week without running while the
      // app carried on looking healthy.
      recordDriverTick(Date.now())
      // Symmetric serialization: yield not only to another manager tick
      // (`managerBusyRef`) but also to the loop driver and any in-flight/parked
      // project run (`engineBusy`, self-ref passed false). One engine at a time.
      if (
        managerBusyRef.current ||
        engineBusy(loopBusyRef.current, false, getProjects().projects)
      )
        return
      const s = settingsRef.current
      ensureSeeded(s, getInterview())
      const ms = getManagers()
      const due = dueJobs(ms, Date.now())
      if (due.length === 0) {
        // No maintenance job due → the slot goes to the companion heartbeat,
        // if ITS cadence is due (a due job keeps priority; the beat waits 30s).
        //
        // `companion.enabled` is checked FIRST (2026-08-16 Finding 3): a
        // manager switched off must not keep working. The two flags cannot
        // drift apart — `managers.ts` keeps a heartbeat manager's `enabled` in
        // lockstep with its heartbeat's own switch (the one the user can see),
        // on load and on every mutation — so this gate is the same decision
        // the Agents card renders, not a second one.
        const companion = ms.managers.find((m) => m.id === COMPANION_MANAGER_ID)
        if (!companion?.enabled) return
        if (!companion.heartbeat || !beatDue(Date.now(), companion.heartbeat)) return
        managerBusyRef.current = true
        try {
          await heartbeatWake(companion, companion.heartbeat)
        } finally {
          managerBusyRef.current = false
        }
        return
      }
      managerBusyRef.current = true
      // Mission Control: the live card for THIS tick's job, registered only
      // once a real engine call is about to happen (never for a park / a
      // missing manager / a disconnected provider — none of those run). The
      // `finally` below is the single guaranteed clear, so a throw anywhere in
      // the job body can't leave a card glowing.
      let jobLive: { id: string; outcome: RunOutcome; detail: string } | null = null
      try {
        const job = due[0]
        const manager = ms.managers.find((m) => m.id === job.managerId)
        if (!manager) {
          recordJobRun(job.id, Date.now(), false, 'manager missing')
          return
        }
        const kind = jobKind(job)
        const action = nextDispatchAction(job)
        if (action === 'park') {
          // 'ask' dispatch: parks for the user's OK on the Agents page. Not a run.
          parkJob(job.id, Date.now())
          return
        }
        if (action === 'wait') return // defensive: dueJobs excludes parked jobs
        const { providers, primaryReal } = buildManagerProviders(s, manager.providerId, {
          keepTier1: kind === 'dispatch',
        })
        if (!primaryReal) {
          recordJobRun(job.id, Date.now(), false, `${manager.name}: provider not connected`)
          return
        }
        const vault = await resolveVaultDir(s.vaultPath)
        // The wall for THIS job on THIS Mac — the same measured budget the
        // wake uses (f93b4b4 moved the heartbeat here; the manager tick was
        // left racing the fixed floor). A manager job reads the vault, the
        // egress floor pins it local, and a 27B 4-bit at 4-6 tok/s honestly
        // needs longer than any fixed number — 420s stays only as the floor.
        const mgrWall = wakeWallMs(
          turnBudget(
            latencyFromSpans(
              await readSpansTail(vault, 200),
              s.providers.find((p) => p.id === 'local')?.model ?? '',
            ),
          ),
        )
        if (kind === 'team') {
          // Teams route per-agent via the roster — the manager LEADS but the
          // engine needs every provider it might delegate to, so this uses
          // the FULL buildEngineProviders set (not buildManagerProviders,
          // which narrows to a single primary).
          // The SAME provider gate the interactive launcher applies (2026-08-12).
          // This path matters most: a manager team job runs UNATTENDED on a
          // schedule, so a seat on a provider that isn't connected would stub
          // quietly into a saved report nobody watched being written. Dropped
          // seats are named in the report line; nothing left = the job is
          // recorded as not-run WITH the reason, never as a run that happened.
          const jobGate = rosterGate(s, {
            health: connectivityRef.current.health as ProviderHealthMap,
          })
          const askedRoster =
            (job.roster ?? '').trim() || defaultTeamRoster(manager.providerId, jobGate)
          const { roster, sitOut: jobSitOut } = filterRoster(askedRoster, jobGate, s)
          if (!roster) {
            recordJobRun(job.id, Date.now(), false, `${manager.name}: ${emptyRosterRefusal(jobSitOut)}`)
            return
          }
          const budget = job.tokenBudget || 100_000
          const { providers: teamProviders } = buildEngineProviders(s)
          // THE MANAGER'S POWERS GO WITH THE WORK IT HANDS OUT.
          //
          // This path — a manager dispatching a team job on its own schedule —
          // passed NO capabilities at all, while the UI's own launcher (see
          // `launchTeam` above) has always built them. So a team you started
          // yourself could read the vault and search the web, and the identical
          // team started by your manager could do neither: the engine's grant
          // table was empty, and `AgentCapabilityGate` refuses every tool
          // outside it. That is why crew dispatched by a manager sat there
          // producing nothing.
          //
          // The ceiling is the SAME `appRunCapabilities(s)` the launcher uses —
          // the manager cannot widen it, because a manager is not a way around
          // a grant the user never gave. It can only pass on what it holds.
          const teamSeats = splitRoster(roster).map((p) => p.role)
          const teamLibrary = listAgents()
          const teamCaps = teamCapabilityArgs(
            teamSeats.map((name) => ({
              name,
              capabilities: agentCapabilityNames(
                teamLibrary.find(
                  (a) => agentSlug(a.name) === name || agentNameKey(a.name) === agentNameKey(name),
                ),
              ),
            })),
            appRunCapabilities(s),
          )
          if (teamCaps) {
            teamProviders.userCapabilities = teamCaps.userCapabilities
            teamProviders.agentCapabilities = teamCaps.agentCapabilities
          }
          const teamRunId = newRunId()
          // The roster is what the app ASKED for (a real request fact); who
          // actually answered comes from the run's real spans, not from here.
          jobLive = {
            id: beginLiveRun({
              id: teamRunId,
              kind: 'team',
              intent: `${manager.name} · ${job.title}`,
              models: roster.split(',').map((r) => r.trim()).filter(Boolean),
            }),
            outcome: 'stopped',
            detail: 'the team run ended without a recorded outcome',
          }
          const teamOutcome = await raceCancelable(
            runNativeTeam(
              `[MANAGER TEAM · ${manager.name} · ${job.department}] ${job.prompt}`,
              vault,
              teamProviders,
              roster,
              1,
              budget,
              teamRunId,
            ),
            mgrWall,
            teamRunId,
          )
          const res = teamOutcome.timedOut ? null : teamOutcome.value
          const { ok, text, label, summary: teamSummary } = teamReportBody(res)
          // Who was not at the table rides into the saved report and the job's
          // own run line — an unattended run must not hide a shrunken team.
          const summary = jobSitOut.length
            ? `${teamSummary} · ${sitOutLine(jobSitOut)}`
            : teamSummary
          const rel = `reports/${slug(manager.name)}/${slug(job.title)}.md`
          const existing = (await readVaultFile(vault, rel)) ?? `# ${job.title} — ${manager.name}\n`
          const entry = `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${label}\n\n${text}\n`
          await writeVaultNote(vault, rel, trimReport(existing, entry))
          recordJobRun(job.id, Date.now(), ok, summary)
          notifyManagerReport(manager.name, job.title, ok)
          noticeJobDone(job, manager.name, ok, rel)
          jobLive = {
            id: jobLive.id,
            outcome: teamOutcome.timedOut ? 'stopped' : ok ? 'passed' : 'failed',
            detail: teamOutcome.timedOut ? weStoppedIt(mgrWall) : summary,
          }
          return
        }
        const intent =
          kind === 'dispatch'
            ? `[MANAGER DISPATCH · ${manager.name} · ${job.department}] ${job.prompt}`
            : `[MANAGER JOB · ${manager.name} · ${job.department}] ${job.prompt}\nReply as a concise markdown report.`
        const mgrRunId = newRunId()
        // No models listed: this run goes through the manager's own provider
        // and the gateway decides the actual route, so naming one here would
        // be a guess. The real model shows up on the card from real spans.
        jobLive = {
          id: beginLiveRun({
            id: mgrRunId,
            kind: 'manager',
            intent: `${manager.name} · ${job.title}`,
          }),
          outcome: 'stopped',
          detail: 'the job ended without a recorded outcome',
        }
        const mgrOutcome = await raceCancelable(
          // A REPORT job is the wake's kind of work — one bounded piece of
          // maintenance — so it rides the wake's real bounds: the token budget
          // on the run's contract and a capped tool loop. Unbounded digging on
          // a 4-6 tok/s local model is what made the wall matter at all. A
          // DISPATCH runs the full verified pipeline the user approved — its
          // envelope is the pipeline's own, unchanged.
          kind === 'report'
            ? runNativeTask(
                intent,
                vault,
                providers,
                mgrRunId,
                undefined,
                undefined,
                WAKE_TOKEN_BUDGET,
                WAKE_TOOL_TURNS,
              )
            : runNativeTask(intent, vault, providers, mgrRunId),
          mgrWall,
          mgrRunId,
        )
        const verdict = mgrOutcome.timedOut ? null : mgrOutcome.value
        const real = !!verdict && isRealCompletion(verdict.response)
        // A dispatch is only ok when the verified pipeline PASSED; a report is
        // ok when a real reply came back at all (unchanged behavior).
        const ok = kind === 'dispatch' ? real && verdict!.passed === true : real
        // Same honesty as the wake's beat line: when the engine named the cause
        // (a killed CLI, not an absent provider), the report says so. A TIMEOUT
        // is OUR stop and must say so on every surface — this string reaches
        // the vault report AND recordJobRun, which is exactly where
        // "(no real reply — provider offline?)" used to blame a provider that
        // was still answering.
        const mgrNamed = mgrOutcome.timedOut ? '' : offlineReason(verdict?.response)
        const text = real
          ? guardAnswerText(verdict!.response as string)
          : mgrOutcome.timedOut
            ? `(${weStoppedIt(mgrWall, 'likely your local model still answering, or a held approval')})`
            : `(${mgrNamed || 'no real reply — provider offline?'})`
        if (kind === 'dispatch' && verdict) {
          dispatch({ type: 'ADD_VERDICT', verdict, card: false }) // surfaces on the Verdicts views + manager report, not a project chat
        }
        // Append to the job's report file, trimmed to keep the newest content.
        const rel = `reports/${slug(manager.name)}/${slug(job.title)}.md`
        const existing = (await readVaultFile(vault, rel)) ?? `# ${job.title} — ${manager.name}\n`
        const label = kind === 'dispatch' ? `dispatch · ${ok ? 'passed' : 'failed'}` : ok ? 'ok' : 'failed'
        const footer = kind === 'dispatch' && verdict ? '\n\n_(dispatched task — full Verdict in the app’s Verdicts view)_' : ''
        const entry = `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${label}\n\n${text}${footer}\n`
        await writeVaultNote(vault, rel, trimReport(existing, entry))
        recordJobRun(job.id, Date.now(), ok, text.slice(0, 160))
        notifyManagerReport(manager.name, job.title, ok)
        noticeJobDone(job, manager.name, ok, rel)
        jobLive = {
          id: jobLive.id,
          outcome: mgrOutcome.timedOut ? 'stopped' : ok ? 'passed' : 'failed',
          detail: mgrOutcome.timedOut
            ? weStoppedIt(mgrWall)
            : ok
              ? ''
              : text.slice(0, 160),
        }
      } finally {
        // The ONE guaranteed clear for this tick's job — success, honest
        // failure, timeout or throw. Nothing else clears it.
        if (jobLive) endLiveRun(jobLive.id, jobLive.outcome, jobLive.detail)
        managerBusyRef.current = false
      }
    }
    // TWO CLOCKS, ONE DRIVER.
    //
    // The page's own interval is the fallback. The REAL one is an OS thread in
    // the Rust process (see `MANAGER_TICK_SECS` in src-tauri/src/lib.rs) that
    // emits `scprism://manager-tick`: macOS throttles timers hard in a hidden
    // or occluded WKWebView, so a minimised app can go minutes between page
    // ticks, and a manager that only wakes while someone is looking at it is
    // not a manager.
    //
    // Both call the SAME `tick`. A double fire is safe by construction —
    // `managerBusyRef` and `engineBusy` already make the second one return
    // immediately — so the two clocks can overlap without ever running a job
    // twice. Neither survives the app being QUIT; that needs a headless
    // runner, and this closes the gap between "open and focused" and "open".
    const h = window.setInterval(() => void tick(), 30_000)
    let unlisten: (() => void) | undefined
    if (isNative()) {
      void listenNative('scprism://manager-tick', () => void tick()).then((off) => {
        // The effect may already have torn down while the listener was being
        // registered; drop it immediately rather than leaking it.
        if (stopped) off()
        else unlisten = off
      })
    }
    let stopped = false
    return () => {
      stopped = true
      window.clearInterval(h)
      unlisten?.()
    }
  }, [])

  // Memoized so consumers don't re-run effects on every render; reducer state is
  // read fresh inside the async flow via dispatched events, so no stale closure.
  const sendIntent = useMemo(() => {
    return async (
      intent: string,
      displayText?: string,
      route?: RouteHint,
      image?: EngineImage,
      proposalRequest?: string,
      rosterEvidence?: RosterEvidence,
    ): Promise<void> => {
      const trimmed = intent.trim()
      if (!trimmed) return
      // The dependency dial (Settings › routeBias) fills an ABSENT per-message
      // hint; an explicit composer choice always outranks it, and 'auto' keeps
      // the dial out entirely. Resolved once here so every downstream reader —
      // the run, the route chip, the vault log — sees the same honest hint.
      route = effectiveRoute(settingsRef.current.routeBias, route)
      // Capture the origin thread ONCE, up front: every message + verdict card
      // this turn produces routes here, so a mid-run project switch can't split
      // the conversation across threads (the async flow closes over this).
      const originThread = activeThreadKey(activeProjectIdRef.current)
      // The compact form for the transcript + vault log. Defaults to the full
      // engine text when the caller passes nothing (non-attachment sends), so
      // existing behavior is byte-identical; attachment sends pass a
      // "📎 name (N chars)" ref here while the engine still gets `trimmed`.
      const display = (displayText ?? intent).trim() || trimmed

      dispatch({ type: 'ADD_MESSAGE', thread: originThread, message: { id: nextId(), kind: 'user', text: display } })

      // Honest-error guard (native only): a connected primary that is
      // known-down gets ONE fresh probe; still down → an explicit error card,
      // nothing dispatched, no sim fallback (the sim answering for a dead
      // real AI is exactly the dishonesty this blocks). Spec 2026-07-12 §3.
      if (isNative()) {
        const guarded = guardedPrimary(settingsRef.current)
        const conn = connectivityRef.current
        if (guarded && isDown(conn.health[guarded.id]?.status)) {
          dispatch({ type: 'SET_RUNNING', running: true })
          const fresh = await conn.probeOne(guarded.id)
          dispatch({ type: 'SET_RUNNING', running: false })
          if (fresh !== 'ok') {
            dispatch({
              type: 'ADD_MESSAGE',
              thread: originThread,
              message: {
                id: nextId(),
                kind: 'error',
                text: connectivityErrorText(guarded.name, fresh),
                intent: trimmed,
                providerId: guarded.id,
              },
            })
            return
          }
        }
      }

      const assistantId = nextId()
      dispatch({ type: 'ADD_MESSAGE', thread: originThread, message: { id: assistantId, kind: 'assistant', text: '' } })
      dispatch({ type: 'SET_RUNNING', running: true })
      // Mission Control: this send's live card. No models listed — the gateway
      // decides the route, and guessing it here would be exactly the invented
      // detail the honesty law forbids; the card fills models in from the run's
      // REAL spans. `chatEnd` records the honest ending, defaulting to
      // 'stopped' so an unexpected exit never claims a pass.
      const chatRunLiveId = beginLiveRun({ kind: 'chat', intent: display })
      let chatEnd: { outcome: RunOutcome; detail: string } = {
        outcome: 'stopped',
        detail: 'the send ended without a recorded outcome',
      }

      const onEvent = (e: EngineEvent): void => {
        switch (e.type) {
          case 'assistant':
            dispatch({ type: 'APPEND_ASSISTANT', id: assistantId, line: e.line })
            break
          // 'agent' events are emitted ONLY by the simulator (simEngine), and
          // the app no longer keeps a live-agent slice for them: the Live agent
          // card renders from real live runs + real spans instead (2026-08-16
          // Finding 1). Nothing to dispatch.
          case 'verdict':
            dispatch({ type: 'ADD_VERDICT', verdict: e.verdict, thread: originThread })
            break
          // contract / route / tier1 / tier2 / writeback are reflected via the
          // assistant lines and agent states the engine also emits.
          default:
            break
        }
      }

      try {
        // Native shell with a REAL, configured primary provider: run the actual
        // Python engine and surface its REAL model completion + Verdict in the
        // chat. On success we skip the simulation entirely. A native run with a
        // real primary that fails now reports honestly (see honestFailure
        // below) instead of falling back to the sim — the sim only remains the
        // path for: non-native contexts, and no real primary configured (the
        // demo path, untouched).
        if (isNative()) {
          const { providers, primaryReal } = buildEngineProviders(settingsRef.current, activeProjectIdRef.current)
          if (primaryReal) {
            const failureCard = (providerId: string, text: string): void => {
              // Drop the empty "thinking" bubble; an error card is not a reply.
              dispatch({ type: 'REMOVE_MESSAGE', id: assistantId })
              dispatch({
                type: 'ADD_MESSAGE',
                thread: originThread,
                message: { id: nextId(), kind: 'error', text, intent: trimmed, providerId },
              })
            }
            // GENUINE unreachable/error (real null, or offline-stub text): the
            // provider really is down, so mark it unreachable (gates the next
            // send) and show the "nothing was sent" copy.
            const honestFailure = (): void => {
              const guarded = guardedPrimary(settingsRef.current)
              const name = guarded?.name ?? 'Your primary AI'
              if (guarded) connectivityRef.current.markUnreachable(guarded.id)
              failureCard(guarded?.id ?? 'local', connectivityErrorText(name, 'unreachable'))
            }
            // TIMEOUT: the run WAS sent and (via cancelEngineRun) stopped — the
            // provider is slow, NOT down. Show honest timeout copy and DO NOT
            // markUnreachable (that would falsely gate the next send).
            let chatWall = CHAT_TIMEOUT_MS
            const timeoutFailure = (): void => {
              const guarded = guardedPrimary(settingsRef.current)
              const name = guarded?.name ?? 'Your primary AI'
              failureCard(guarded?.id ?? 'local', timeoutErrorText(name, chatWall))
            }
            try {
              const vault = await resolveVaultDir(settingsRef.current.vaultPath)
              // Measured wall (2026-08-16): 120s floor, raised to what one call
              // actually costs on this machine so a vault-pinned local run is
              // not killed and then reported as an unreachable provider.
              chatWall = chatWallMs(
                turnBudget(
                  latencyFromSpans(
                    await readSpansTail(vault, 200),
                    settingsRef.current.providers.find((p) => p.id === 'local')?.model ?? '',
                  ),
                ),
              )
              // Bounded wait: subscription CLIs can be slow, but the chat must
              // never sit locked for minutes — after 120s report honestly. On a
              // timeout `raceCancelable` KILLS the retained engine child (real
              // cancel), so no zombie keeps running; its late result is also
              // dropped by the race, so it can't backfill after the error card.
              const runId = newRunId()
              const outcome = await raceCancelable(
                // Per-message route hint (composer local/cloud/auto). 'auto'/
                // undefined → no override (byte-identical); the gateway keeps
                // sensitive content local even under 'cloud'. `image` (when the
                // composer attached one) is sent to a vision route or honestly
                // marked not-sent otherwise; undefined → a text-only run.
                //
                // 'converse' names what this send IS — a chat turn. Without it
                // the contract inferred "write" from the wording and the judge
                // graded a good reply as a build that produced no files (the
                // 32 red badges / 3%-pass team card). Only THIS path — the one
                // that declares kind:'chat' above — says it; every other
                // runNativeTask caller omits the arg and is byte-identical.
                runNativeTask(trimmed, vault, providers, runId, route, image, 0, 0, 'converse'),
                chatWall,
                runId,
              )
              const turn = chatTurnFromOutcome(outcome)
              if (turn.kind === 'ok') {
                const verdict = turn.verdict
                dispatch({ type: 'APPEND_ASSISTANT', id: assistantId, line: turn.response })
                // Attribute this reply to the REAL model the gateway routed it
                // to (multi-model chat) — the chat bubble surfaces the engine's
                // per-message routing, never a client-side guess. Nothing is
                // dispatched when the Verdict names no model (no fabricated chip).
                const meta = messageModelFromVerdict(verdict)
                if (meta) dispatch({ type: 'SET_MESSAGE_MODEL', id: assistantId, ...meta })
                // Write the turn back to the vault as a markdown note (best-effort).
                void resolveVaultDir(settingsRef.current.vaultPath).then((v) =>
                  // Persist the COMPACT form, never the raw attachment body —
                  // the chat-log must not become a 50 KB wall of text per file.
                  appendChatNote(v, display, turn.response, verdict.route?.model ?? 'ai'),
                )
                dispatch({ type: 'ADD_VERDICT', verdict, thread: originThread })
                // Source (b): a "propose an agent" ask from Work. The reply may
                // end with a PROPOSE_AGENT block; the EVIDENCE is the user's own
                // request, attached verbatim by the parser. A malformed or
                // duplicate block records nothing and says so in the thread —
                // the same honesty the heartbeat path applies. Ordinary sends
                // pass no request, so nothing here runs for them.
                if (proposalRequest && proposalRequest.trim()) {
                  const note = proposalNoticeFromChat(
                    turn.response,
                    proposalRequest,
                    settingsRef.current.vaultPath,
                  )
                  if (note) {
                    dispatch({
                      type: 'ADD_MESSAGE',
                      thread: originThread,
                      message: { id: nextId(), kind: 'notice', text: note },
                    })
                  }
                }
                // A "staff this project" ask (2026-08-15). The reply may end
                // with a PROPOSE_ROSTER block; the EVIDENCE is the project's own
                // recorded plan, and a role citing anything else refuses the
                // whole roster. Ordinary sends pass no evidence, so nothing here
                // runs for them.
                if (rosterEvidence) {
                  dispatch({
                    type: 'ADD_MESSAGE',
                    thread: originThread,
                    message: {
                      id: nextId(),
                      kind: 'notice',
                      text: rosterNoticeFromChat(
                        turn.response,
                        rosterEvidence,
                        settingsRef.current.vaultPath,
                      ),
                    },
                  })
                }
                // A real reply came back: the honest ending for the card. An
                // INCOMPLETE INVESTIGATION is not a clean pass, though — the
                // engine ran out of tool turns (or budget) mid-research and
                // said so — so the desk's finished-run row says 'stopped' with
                // the reason instead of showing a green tick over unfinished
                // work. This is the marker earning its keep: `[incomplete: …]`
                // exists precisely so a surface can present it as an
                // investigation that stopped rather than as an answer.
                chatEnd = isIncompleteInvestigation(turn.response)
                  ? { outcome: 'stopped', detail: incompleteReason(turn.response) }
                  : { outcome: 'passed', detail: '' }
                return // real output shown — the finally block resets running/agents
              }
              // Distinguish an honest TIMEOUT (slow but live — don't mark down)
              // from a genuine error (real null / offline-stub — mark down).
              if (turn.kind === 'timeout') {
                timeoutFailure()
                chatEnd = {
                  outcome: 'stopped',
                  detail: `we stopped it at ${Math.round(chatWall / 1000)}s — our own wall, not a provider failure`,
                }
              } else if (turn.kind === 'loadFailed') {
                // The local server ANSWERED and refused to load the model (507
                // / the metal_cap ceiling). It is up, so it is NOT marked
                // unreachable — doing that would gate the next send and tell
                // him to start a server that is already running. The card names
                // the real cause and what to do about it.
                const guarded = guardedPrimary(settingsRef.current)
                failureCard(guarded?.id ?? 'local', loadFailedText(turn.reason))
                chatEnd = { outcome: 'failed', detail: loadFailedDetail(turn.reason) }
              } else {
                honestFailure()
                chatEnd = { outcome: 'failed', detail: 'no real reply — the provider was unreachable' }
              }
              return
            } catch {
              honestFailure()
              chatEnd = { outcome: 'failed', detail: 'the run failed before a reply came back' }
              return
            }
          } else {
            // No real primary: still kick off the engine in the background as a
            // best-effort side-effect (writes a real Verdict + spans to the
            // vault). Fire-and-forget so it can never hang or lock the composer.
            void resolveVaultDir(settingsRef.current.vaultPath)
              .then((vault) => runNativeTask(trimmed, vault, providers))
              .catch(() => null)
          }
        }
        await runTask(trimmed, onEvent, settingsRef.current)
        // The SIMULATION path — reached only when there is no native shell or
        // no real primary (the real-engine branches above all return first).
        // It really did produce a verdict, but saying just "passed" would let
        // a simulated turn read like a real one, so the row says which it was.
        chatEnd = { outcome: 'passed', detail: 'simulated — no real engine run' }
      } finally {
        dispatch({ type: 'SET_RUNNING', running: false })
        // The ONE guaranteed clear for a chat send — success, honest failure,
        // timeout or throw. Without this the card would glow forever.
        endLiveRun(chatRunLiveId, chatEnd.outcome, chatEnd.detail)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Compaction driver (P2-3) ----
  // Summarize a thread's older turns (a real model when one is configured, else
  // the deterministic structural recap), ARCHIVE the full pre-compaction block
  // to the vault BEFORE dropping anything (the "compressed ≠ lost" guarantee),
  // then — and only if the archive is safe (`shouldDrop`) — shrink the live
  // thread. The ORDER (summarize → archive → shrink) and the `shouldDrop` gate
  // are the correctness core: on native, a failed vault write keeps the FULL
  // thread rather than silently losing turns.
  const compactThread = useMemo(() => {
    return async (threadKey: string): Promise<void> => {
      if (compactingRef.current.has(threadKey)) return
      const existing = stateRef.current.threads[threadKey] ?? []
      const { older } = splitForCompaction(existing)
      // Nothing to compact, OR the head is already only compaction summaries
      // (re-summarizing them gains nothing and would loop when the retained tail
      // alone stays over threshold). This is the auto-compaction convergence guard.
      if (!canCompact(older)) return
      compactingRef.current.add(threadKey)
      try {
        // 1) Summarize: prefer a real model, else the deterministic structural recap.
        let summary = structuralSummary(older)
        if (isNative()) {
          const { providers, primaryReal } = buildEngineProviders(settingsRef.current, activeProjectIdRef.current)
          if (primaryReal) {
            // A REAL engine run, so it registers like every other one (M1):
            // without a card the Work page said "last run" while this was
            // genuinely in flight.
            const sumRunId = newRunId()
            const sumLiveId = beginLiveRun({
              id: sumRunId,
              kind: 'compaction',
              intent: `tidying the conversation — ${threadKey}`,
            })
            let sumEnd: { outcome: RunOutcome; detail: string } = {
              outcome: 'stopped',
              detail: 'the summary run ended without a recorded outcome',
            }
            try {
              const vault = await resolveVaultDir(settingsRef.current.vaultPath)
              const sumOutcome = await raceCancelable(
                runNativeTask(summaryPromptFor(older), vault, providers, sumRunId),
                30_000,
                sumRunId,
              )
              const res = sumOutcome.timedOut ? null : sumOutcome.value
              if (res && isRealCompletion(res.response)) {
                summary = res.response as string
                sumEnd = { outcome: 'passed', detail: '' }
              } else {
                sumEnd = sumOutcome.timedOut
                  ? { outcome: 'stopped', detail: 'stopped at 30s — kept the structural recap' }
                  : { outcome: 'failed', detail: 'no real summary — kept the structural recap' }
              }
            } catch {
              /* keep the structural summary */
              sumEnd = { outcome: 'failed', detail: 'the summary run failed — kept the structural recap' }
            } finally {
              endLiveRun(sumLiveId, sumEnd.outcome, sumEnd.detail)
            }
          }
        }
        // 2) ARCHIVE FIRST (non-lossy). On native, append the full block to the thread's vault page.
        let archived = false
        if (isNative()) {
          try {
            const vault = await resolveVaultDir(settingsRef.current.vaultPath)
            const relpath = `conversations/${threadKey}.md`
            // True APPEND (no read-modify-write): never truncates past 1 MB.
            const block = compactionArchiveMarkdown(threadKey, older, summary, new Date().toISOString())
            const wrote = await appendVaultNote(vault, relpath, block)
            archived = wrote !== null
          } catch {
            archived = false
          }
        }
        // 3) Only shrink the live thread if it's safe (archived on native, or non-native demo).
        if (shouldDrop(archived, isNative())) {
          dispatch({ type: 'COMPACT_THREAD', thread: threadKey, summaryId: nextId(), summary })
        }
      } finally {
        compactingRef.current.delete(threadKey)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Manual lever: compact the ACTIVE thread now (Workspace `Compress now`, P2-4).
  const compressNow = useMemo(() => {
    return (): Promise<void> => compactThread(activeThreadKey(activeProjectIdRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Manual lever: start a fresh session for ONE thread (Workspace `New session`,
  // P2-4). Same non-lossy contract as compactThread — archive the WHOLE thread
  // to the vault first, then empty it only when `shouldDrop` says it's safe.
  const newSession = useMemo(() => {
    return async (threadKey: string): Promise<void> => {
      const all = stateRef.current.threads[threadKey] ?? []
      if (all.length === 0) return
      const summary = structuralSummary(all)
      let archived = false
      if (isNative()) {
        try {
          const vault = await resolveVaultDir(settingsRef.current.vaultPath)
          const relpath = `conversations/${threadKey}.md`
          // True APPEND (no read-modify-write): never truncates past 1 MB.
          const block = compactionArchiveMarkdown(threadKey, all, summary, new Date().toISOString())
          const wrote = await appendVaultNote(vault, relpath, block)
          archived = wrote !== null
        } catch {
          archived = false
        }
      }
      if (shouldDrop(archived, isNative())) dispatch({ type: 'RESET_THREAD', thread: threadKey })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-compact the ACTIVE thread when it crosses the meter's auto threshold
  // (75%), unless a task is running or a compaction is already in flight
  // (compactThread guards re-entry). After a pass the thread shrinks to
  // `summary + last 6`, so the meter drops well below 75% and this won't
  // re-fire.
  useEffect(() => {
    const key = activeThreadKey(state.activeProjectId)
    const meter = meterFor(threadFor(state.threads, key))
    if (meter.autoCompact && !state.running) {
      void compactThread(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.threads, state.activeProjectId, state.running])

  // Bound interview-turn runner: the shared `runInterviewTurn` (also used by
  // ProjectView.askProject) supplied this store's own settings/native deps,
  // so a project's in-flight interview drives the SAME running indicator and
  // dispatches replies into that project's own chat thread (P1-2).
  const runInterviewTurnBound = useMemo(() => {
    return async (project: Project, userText: string): Promise<void> => {
      dispatch({ type: 'SET_RUNNING', running: true })
      // Mission Control: an interview turn IS a live run (kind 'project').
      // Cleared in the SAME finally that clears `running` — one exit path.
      const liveId = beginLiveRun({
        kind: 'project',
        intent: `interview — ${project.name || '(untitled)'}`,
      })
      let end: { outcome: RunOutcome; detail: string } = {
        outcome: 'stopped',
        detail: 'the interview turn ended without a recorded outcome',
      }
      // Did a REAL completion actually come back? `runInterviewTurn` calls this
      // dep exactly once, on the verdict, and returns normally either way — so
      // this flag is the only thing that knows whether the turn produced a real
      // question or the honest "Couldn't reach the AI just now". Deriving the
      // row from `isNative() && primaryReal` instead marked a timed-out
      // interview a green "passed".
      try {
        // The BUDGET is measured, not assumed (2026-08-16). A vault-reading
        // interview is pinned local by the egress floor, and local turns cost
        // 60-70s on this machine — the old flat 90s wall killed healthy runs by
        // construction. Read the span tail once, derive this machine's real
        // per-call cost, and budget from that; the span tail also becomes the
        // live progress proof so a run that keeps finishing steps is never cut.
        const vaultDir = await resolveVaultDir(settingsRef.current.vaultPath)
        const localModel = settingsRef.current.providers.find((p) => p.id === 'local')?.model ?? ''
        const budget = turnBudget(latencyFromSpans(await readSpansTail(vaultDir, 200), localModel))
        const ending = await runInterviewTurn(project, userText, {
          native: isNative(),
          buildProviders: () => buildEngineProviders(settingsRef.current, project.id),
          resolveVault: () => resolveVaultDir(settingsRef.current.vaultPath),
          runTask: (prompt, vault, providers, runId) => runNativeTask(prompt, vault, providers, runId),
          cancelRun: cancelEngineRun,
          budget,
          lastStep: async () => lastStepFromSpans(await readSpansTail(vaultDir, 8)),
          offlineReason,
          isRealCompletion,
          appendTurn,
          updateProject,
          onTurn: (turn) =>
            dispatch({
              type: 'ADD_MESSAGE',
              thread: project.id,
              message: { id: nextId(), kind: turn.role === 'user' ? 'user' : 'assistant', text: turn.text },
            }),
        })
        // `runInterviewTurn` never throws — it REPORTS how the turn ended, and
        // the row now says exactly that. It used to guess: any non-real reply
        // became "no real reply — timed out or the AI could not be reached",
        // which is what the user read for a run where the AI had answered every
        // call and WE had cancelled it. The four endings are now distinct: our
        // own cancellation (with elapsed and what it was doing), a genuinely
        // unreachable provider, a placeholder reply, and the two refusals.
        end =
          ending.kind === 'reply'
            ? { outcome: 'passed', detail: '' }
            : ending.kind === 'cancelled'
              ? { outcome: 'stopped', detail: cancelledDetail(ending.facts) }
              : ending.kind === 'unreachable'
                ? { outcome: 'failed', detail: UNREACHABLE_DETAIL }
                : ending.kind === 'stub'
                  ? { outcome: 'failed', detail: stubDetail(ending.reason) }
                  : ending.kind === 'no-provider'
                    ? { outcome: 'failed', detail: 'no primary AI connected — no real question was asked' }
                    : { outcome: 'failed', detail: 'needs the installed app' }
      } catch (err) {
        end = { outcome: 'failed', detail: 'the interview turn failed' }
        throw err
      } finally {
        dispatch({ type: 'SET_RUNNING', running: false })
        endLiveRun(liveId, end.outcome, end.detail)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ONE send() entry point: routes to the active project's interview pipeline
  // while it has no plan yet, else the project-aware companion (sendIntent) —
  // the single decision point so callers never have to know which engine runs.
  const send = useMemo(() => {
    return async (text: string, displayText?: string, route?: RouteHint, image?: EngineImage): Promise<void> => {
      const pid = activeProjectIdRef.current
      const project = pid ? (getProjects().projects.find((p) => p.id === pid) ?? null) : null
      if (nextSendMode(project) === 'project-interview') {
        // A blank first turn is allowed here — it asks the interview's first
        // question. The interview pipeline has no per-message routing (it runs
        // its own turn engine), so `route`/`image` are intentionally not
        // threaded here.
        await runInterviewTurnBound(project as Project, text.trim())
        return
      }
      const trimmed = text.trim()
      if (!trimmed) return
      await sendIntent(trimmed, displayText, route, image)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Project driver: a durable multi-step build, one VERIFIED step at a
  // time, on a ref + 140ms-poll mechanic. A
  // project's progress (stepIndex/refinePass/status) is the DURABLE record —
  // these refs only coordinate the single live driver instance (supersede,
  // and the yes/no "one more refine?" park). There is no sim fallback here:
  // a project run is always the real engine, or it honestly refuses to start.
  const projectRunId = useRef(0)
  const projectRequestRef = useRef<'idle' | 'pending' | 'granted' | 'declined'>('idle')

  const runProject = useMemo(() => {
    return async (projectId: string): Promise<void> => {
      const project = getProjects().projects.find((p) => p.id === projectId)
      if (!project) return

      const notify = (kind: Notice['kind'], text: string): void => {
        dispatch({ type: 'ADD_NOTICE', notice: { id: nextNoticeId(), projectId, kind, text } })
        // Courtesy mirror to the phone (companion grant) — outcome kinds only.
        notifyNotice(kind, text)
      }

      // Concurrent-start guard, checked BEFORE the shared projectRunId is
      // bumped: that counter is the single "which run is live" gate for
      // EVERY project (not per-project), so incrementing it here would
      // silently supersede an already-running project's driver loop on its
      // very next poll — stranding it in 'running' forever with nothing left
      // to advance its status. Refuse honestly instead; no status touched.
      const blocker = otherRunningProject(getProjects().projects, projectId)
      if (blocker) {
        notify('attention', `«${blocker.name}» is already running — one build at a time`)
        return
      }
      // Companion grant (audit H1): a denied files grant must actually stop
      // builds — hiding the New-project button alone would be theater. Every
      // build entry point funnels here; refuse honestly, status untouched.
      if (!settingsRef.current.projectWrites) {
        notify('attention', 'project file writes are denied — grant them in Settings → Approvals first')
        return
      }
      // Symmetric engine serialization (final review A): a manual build must
      // yield to the loop driver and the manager driver too, not just to
      // another project. Refuse honestly, status untouched. Self-ref (the
      // loop driver's `loopBusyRef` when it kicks off a build) is released
      // before that call, so a loop-driven build does not hit this — only a
      // truly concurrent manager/loop engine run does. `otherRunningProject`
      // above already covers the projects-running case; this adds the two
      // driver refs.
      if (managerBusyRef.current || loopBusyRef.current) {
        notify('attention', `«${project.name}» — engine busy, another run is in progress`)
        return
      }

      const runId = ++projectRunId.current
      projectRequestRef.current = 'idle'

      // No sim projects: refuse honestly rather than silently no-op or fake
      // it — status is left untouched so nothing looks like it ran.
      if (!isNative()) {
        notify('attention', `«${project.name}» needs the installed app to run.`)
        return
      }
      const { primaryReal } = buildEngineProviders(settingsRef.current)
      if (!primaryReal) {
        notify('attention', `«${project.name}» can't run — connect a real AI provider first.`)
        return
      }
      if (project.plan.length === 0) {
        notify('attention', `«${project.name}» has no plan to run yet.`)
        return
      }

      const vault = await resolveVaultDir(settingsRef.current.vaultPath)
      const projectDir = await expandUserPath(project.path)
      // expandUserPath only expands a leading `~`; a relative project.path
      // (or the empty-string unusable-tilde case) passes through unresolved
      // and must never reach the Rust bridge / Python engine — same honest
      // refusal either way.
      if (!isUsableProjectDir(projectDir)) {
        notify('attention', `«${project.name}» — project path is not usable.`)
        return
      }
      if (projectRunId.current !== runId) return

      // Existing-mode plumbing for the engine's branch-per-run lifecycle —
      // computed ONCE for the whole run (not per step): `project.mode`/
      // `project.slug` never change mid-run, and re-reading the interview's
      // never-touch list on every step would let a mid-run edit silently
      // change the guard a running build is subject to.
      const existingMode = project.mode === 'existing'
      const slug = project.slug
      // The business's protection list applies to real repos; a fresh sandbox
      // project's own billing/ folder is unrelated.
      const neverTouch = existingMode ? neverTouchGlobs(getInterview().neverTouch) : []
      // The build team, resolved by `projectBuildRoster`: this project's OWN
      // assigned agents (a specific-requirement exception) > an explicit
      // manual `project.roster` override > the DEFAULT enabled system agents
      // (the install-time task-division). So by default a project builds with
      // the existing system team — zero per-project setup. Computed ONCE for
      // the whole run, same convention as `existingMode`/`slug`/`neverTouch`
      // above — a mid-run agent edit doesn't silently change the team a
      // running build is subject to.
      //
      // The SAME provider gate the team launcher uses (2026-08-12): a role whose
      // model maps to a provider that isn't connected is dropped with a reason
      // and the user is told, instead of that role quietly answering with an
      // offline stub for the whole build. A manual roster override goes through
      // `filterRoster` too — the user's typed words are checked, not obeyed
      // blindly. If nothing is left the build does not start.
      const buildGate = rosterGate(settingsRef.current, {
        health: connectivityRef.current.health as ProviderHealthMap,
      })
      // GATE ONCE. Building with the gate made projectBuildRoster drop the
      // unusable agents itself, so `filterRoster` below saw nothing left to
      // report and `rosterSitOut` came back empty — the build ran a quietly
      // shorter team and the user was never told. Ask for everyone, and let the
      // one filter both drop AND name who sat out.
      const askedRoster = projectBuildRoster(project, listAgents(), allowAllProviders)
      // THE STAFFING GATE (2026-08-30, lib/projects.ts staffRoster). A typed
      // role key that names no real library agent never reaches the engine —
      // its parse_agents would bind the fallback charter "Act as the team's
      // lead." and the seat answers in nobody's voice (observed 2026-08-29:
      // a "lead:claude" roster spoke as a generic verifier, no FILE blocks).
      // Same honesty pattern as the provider gate below: dropped WITH a
      // reason, refused outright when staffing leaves nothing.
      const { roster: staffedRoster, unstaffed } = staffRoster(askedRoster, listAgents())
      if (askedRoster && !staffedRoster) {
        notify('attention', `«${project.name}» — ${unstaffedRefusal(unstaffed)}`)
        return
      }
      if (unstaffed.length > 0) {
        notify('attention', `«${project.name}» builds without ${sitOutLine(unstaffed)}`)
      }
      const { roster, sitOut: rosterSitOut } = filterRoster(
        staffedRoster,
        buildGate,
        settingsRef.current,
      )
      // An empty ASK is the honest single-doer case (no team configured at all)
      // and is allowed exactly as before; an ask that became empty because
      // nothing is connected is a refusal, not a solo run.
      if (askedRoster && !roster) {
        notify('attention', `«${project.name}» — ${emptyRosterRefusal(rosterSitOut)}`)
        return
      }
      if (rosterSitOut.length > 0) {
        notify('attention', `«${project.name}» builds without ${sitOutLine(rosterSitOut)}`)
      }

      let idx = project.stepIndex
      let rp = project.refinePass
      let feedback = project.lastNote
      let extraGranted: boolean | null = null
      let vids = [...project.verdictIds]
      // The verdict of the last attempt at the CURRENT step — the engine is
      // given its path on a refine so the model is shown the code it is
      // actually fixing (and so attempt N+1 records what it came from). Reset
      // whenever the step advances: a new step has no previous attempt, and
      // pointing it at the last step's files would be a lie about lineage.
      let lastStepVerdictId = ''
      // The durable base branch this run started from — a resumed step
      // reports base '' (unrecoverable from git state), so this local var
      // carries the LAST known-good value forward across steps for the
      // finish call at the end of the run.
      let baseBranch = project.baseBranch ?? ''
      // V2-5: the STORED run branch from a PRIOR run that already returned
      // to base via project_finish (e.g. an 'attention' verdict) — captured
      // ONCE at run start, not re-read from the store per step. The engine's
      // own current-branch resume rule already covers steps 2+ WITHIN one
      // live run (the repo stays checked out on the branch between steps);
      // this passthrough only matters for the RESUME-after-finish case, so
      // step 1 of a resumed run can check the stored branch back out instead
      // of abandoning it for a freshly numbered one. project.runBranch is
      // cleared to '' by mergeProject once merged, so a merged project's
      // next run starts branch-less exactly like a brand-new one.
      const runBranch = project.runBranch ?? ''
      // Reloaded while parked ('awaiting'): resume straight back into the ask
      // rather than silently retrying the already-exhausted refine pass.
      let pending: RunAction | null = project.status === 'awaiting' ? { kind: 'ask-extra-refine' } : null

      updateProject(projectId, { status: 'running' })

      // Mission Control: the project build's live card. Registered only
      // after EVERY honest refusal above has passed (no plan / not native /
      // no provider / busy engine all return before this), so a card exists
      // only for a build that genuinely starts. The `finally` below is the
      // single guaranteed clear across every `return` inside the loop.
      // The wall for a BUILD STEP on THIS Mac — the same measured budget the
      // wake (f93b4b4) and the manager tick (080daa9) already use. This was
      // the LAST fixed 300s wall in the app, and it killed the very first
      // loop-driven build step: an opus planning turn over a real step prompt
      // honestly runs past five minutes, and the implementer steps run LOCAL
      // at 4-6 tok/s. Computed once per build; nobody is watching a loop run.
      const stepWall = wakeWallMs(
        turnBudget(
          latencyFromSpans(
            await readSpansTail(vault, 200),
            settingsRef.current.providers.find((p) => p.id === 'local')?.model ?? '',
          ),
        ),
      )
      const buildLiveId = beginLiveRun({
        kind: 'project',
        intent: project.name || '(untitled project)',
        // The roster the app ASKED the engine to build with — a real
        // request fact. Who actually answered comes from the run's spans.
        models: roster.split(',').map((r) => r.trim()).filter(Boolean),
      })
      let buildEnd: { outcome: RunOutcome; detail: string } = {
        outcome: 'stopped',
        detail: 'the build stopped before it finished',
      }
      try {
        while (true) {
          if (projectRunId.current !== runId) return

          let action: RunAction
          if (pending) {
            action = pending
            pending = null
          } else {
            const intent =
              rp === 0
                ? stepIntent(project.goal, project.plan, idx)
                : refineIntent(project.goal, feedback, rp)
            // Attempt lineage (F1). One logical step = one group; `rp` is how
            // many refines have run, so this attempt is `rp + 1`. Both travel
            // on every attempt INCLUDING the first, or attempt 1 would be
            // missing from its own history and the loop could only ever show
            // the retries.
            const attemptGroup = `${project.id}:step-${idx}`
            const attempt = rp + 1
            const previousVerdict = lastStepVerdictId
              ? `${vault}/verdicts/${lastStepVerdictId}.json`
              : ''
            const opts =
              rp === 0
                ? {
                    context: project.brief,
                    existingMode,
                    slug,
                    neverTouch,
                    runBranch,
                    roster,
                    attempt,
                    attemptGroup,
                  }
                : {
                    context: project.brief,
                    refineFeedback: feedback,
                    existingMode,
                    slug,
                    neverTouch,
                    runBranch,
                    roster,
                    attempt,
                    attemptGroup,
                    previousVerdict,
                  }
            const stepProviders = buildProjectProviders(
              settingsRef.current,
              project.verifyCommand,
              project.path,
            ).providers
            // PER-AGENT CAPABILITIES for this build (2026-08-15). When this
            // project was STAFFED from an approved roster, each seat carries the
            // capabilities the human approved — and they become the engine's
            // grant table. `writes` is the one that bites here: a seat without
            // it writes NOTHING, refused at project.apply_file_ops, not by a
            // greyed-out button. An unstaffed project sends no flags and builds
            // exactly as it did before.
            {
              const lib = listAgents()
              const buildCaps = teamCapabilityArgs(
                splitRoster(roster).map((seat) => ({
                  name: seat.role,
                  capabilities: agentCapabilityNames(
                    lib.find((a) => agentNameKey(a.name) === agentNameKey(seat.role)),
                  ),
                })),
                appRunCapabilities(settingsRef.current),
              )
              if (buildCaps) {
                stepProviders.userCapabilities = buildCaps.userCapabilities
                stepProviders.agentCapabilities = buildCaps.agentCapabilities
              }
            }

            // WHICH PHASE, AND WHOSE. A project already runs one engine call
            // per plan step with a per-seat roster; until now none of that
            // reached the spans, so every step looked like the same anonymous
            // solo run and the board could show neither the plan nor the crew.
            //
            // The stage is the step's OWN text — the plan the user approved,
            // not a phase name anyone invented. The seat is taken round-robin
            // from the roster he staffed, which is the honest reading of "this
            // crew builds this project" when the plan does not name an owner
            // per step: it is a real seat of his, in a stated order, rather
            // than a guess dressed up as an assignment.
            const seats = splitRoster(roster)
            const seat = seats.length ? seats[idx % seats.length].role : ''
            stepProviders.stage = stageLabelForStep(project.plan, idx)
            stepProviders.agentName = seat

            let verdict: Verdict | null = null
            let stepTimedOut = false
            try {
              const engineRunId = newRunId()
              const stepOutcome = await raceCancelable(
                runNativeProject(
                  intent,
                  projectDir,
                  vault,
                  stepProviders,
                  { ...opts, tokenBudget: PROJECT_STEP_TOKEN_BUDGET },
                  engineRunId,
                ),
                stepWall,
                engineRunId,
              )
              stepTimedOut = stepOutcome.timedOut
              verdict = stepOutcome.timedOut ? null : stepOutcome.value
            } catch {
              verdict = null
            }
            if (projectRunId.current !== runId) return

            const passed = !!verdict && verdict.passed === true
            if (verdict) {
              // card:false — a project's verdicts already render in the rail
              // (ProjectContextPanel Verdicts list) + the Verdicts page; a chat
              // card here would both misroute and double-display on one screen.
              dispatch({ type: 'ADD_VERDICT', verdict, card: false })
              // The Manager (a face, never a controller — ADR-007) narrates the
              // step into this project's chat thread, with every fact interpolated
              // from the Verdict's real fields (models used · local routing ·
              // pass/fail) — never free-generated.
              dispatch({
                type: 'ADD_MESSAGE',
                thread: project.id,
                message: { id: nextId(), kind: 'assistant', text: narrateRun(verdict) },
              })
              vids = [...vids, verdict.taskId]
              lastStepVerdictId = verdict.taskId
            }
            feedback = passed
              ? ''
              : verdict
                ? verdictFeedback(verdict)
                : stepTimedOut
                  ? weStoppedIt(stepWall)
                  : lastEngineProjectError() ||
                    'The engine gave no reply and named no reason.'

            let note: string
            if (passed && verdict) {
              // PROJECT ANSWER: the step's note is rendered in the project run
              // stage, so it takes the same tool_call guard as the chat turn.
              const base = isRealCompletion(verdict.response)
                ? guardAnswerText(verdict.response)
                : project.plan[idx]
              note = stepNote(base, verdict.project?.overwrote)
            } else {
              note = feedback
            }

            // Existing-mode branch bookkeeping: the engine reports base '' on
            // a resumed step (unrecoverable from git state) — omit baseBranch
            // from the patch entirely rather than overwrite the durable stored
            // value with an empty string.
            const branchPatch: Partial<Project> = verdict?.project?.runBranch
              ? {
                  runBranch: verdict.project.runBranch,
                  ...(verdict.project.baseBranch ? { baseBranch: verdict.project.baseBranch } : {}),
                }
              : {}
            if (branchPatch.baseBranch) baseBranch = branchPatch.baseBranch

            updateProject(projectId, { verdictIds: vids, refinePass: rp, lastNote: note, ...branchPatch })

            action = nextRunAction(
              { plan: project.plan, stepIndex: idx, refinePass: rp, lastPassed: passed, extraRefineGranted: extraGranted },
              DEFAULT_MAX_REFINES,
            )
          }

          if (action.kind === 'ask-extra-refine') {
            updateProject(projectId, { status: 'awaiting' })
            notify(
              'request',
              `«${project.name}» is stuck after ${DEFAULT_MAX_REFINES} tries — give it one more shot?`,
            )
            // PARK the card too. The engine subprocess for the last refine has
            // already exited; this poll is waiting on a HUMAN and can sit here
            // all night. Left unparked, the card glowed, the console header read
            // "live" and the orb pulsed the whole time — activity with no engine
            // behind it, which is the one thing this app must never show.
            pauseLiveRun(buildLiveId, true)
            projectRequestRef.current = 'pending'
            while (projectRequestRef.current === 'pending') {
              if (projectRunId.current !== runId) return
              await loopDelay(140)
            }
            const decision = projectRequestRef.current
            projectRequestRef.current = 'idle'
            if (projectRunId.current !== runId) return
            // Answered — the engine is about to run again, so the card is live
            // again. (A supersede/throw exits above; the `finally` clears the
            // whole entry, so a parked flag can never leak.)
            pauseLiveRun(buildLiveId, false)
            extraGranted = decision === 'granted'
            updateProject(projectId, { status: 'running' })
            pending = nextRunAction(
              { plan: project.plan, stepIndex: idx, refinePass: rp, lastPassed: false, extraRefineGranted: extraGranted },
              DEFAULT_MAX_REFINES,
            )
            continue
          }

          if (action.kind === 'finish') {
            // Existing mode: return the attached repo to a clean state on the
            // user's own base branch — on BOTH 'done' and 'attention', since a
            // build that needs attention still left the folder checked out on
            // a scprism/* run branch. Only when we actually branched off a
            // real base (never on the zero-commits / new-mode-like path,
            // where base_branch stayed ''). project_finish self-guards against
            // non-scprism branches engine-side, but the driver still only
            // calls it when there is a stored base to return to. Await this
            // FIRST before updating status, so the Merge button doesn't render
            // while finish is still checking out the base.
            if (existingMode && baseBranch) {
              const finishResult = await runNativeProjectFinish(projectDir, baseBranch)
              if (!finishResult?.ok) {
                notify(
                  'attention',
                  `«${project.name}» — couldn't return to ${baseBranch}: ${finishResult?.detail || 'finish failed — is the app native?'}`,
                )
              }
            }
            // The step index reaches plan length once done, so "step N of N"
            // reads as fully complete.
            updateProject(projectId, {
              status: action.status,
              ...(action.status === 'done' ? { stepIndex: project.plan.length } : {}),
            })
            notify(
              action.status === 'done' ? 'done' : 'attention',
              action.status === 'done' ? `«${project.name}» is done — check it` : `«${project.name}» needs attention`,
            )
            // The build's real ending — the same status the project store just
            // recorded, so the card row and the project can never disagree.
            buildEnd =
              action.status === 'done'
                ? { outcome: 'passed', detail: '' }
                : { outcome: 'failed', detail: feedback || 'needs attention' }
            return
          }

          if (action.kind === 'step') {
            idx = action.index
            rp = 0
            extraGranted = null
            feedback = ''
            // A new step starts a new attempt history: it has no previous
            // attempt, and carrying the last step's verdict forward would point
            // the next refine at files this step never wrote.
            lastStepVerdictId = ''
            updateProject(projectId, { stepIndex: idx, refinePass: 0 })
            continue
          }

          // action.kind === 'refine'
          rp = action.pass
          updateProject(projectId, { refinePass: rp })
        }
      } finally {
        endLiveRun(buildLiveId, buildEnd.outcome, buildEnd.detail)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- App-level loop driver (P2-3): app-wide, deterministic, serial ----
  // Ticks every 20s on ANY page (not just /loop) — the single place that
  // fires standing schedules, replacing the old page-scoped tick in
  // Loop.tsx's StandingLoops (removed there so schedules don't double-fire).
  // Runs at most one due schedule per tick, branching on its `kind`:
  //   'build' → the existing build loop (runProject), FIRE-AND-FORGET
  //   'test'  → a governed, read-only verify run (runNativeVerify, P2-2) —
  //             never writes project files or touches git
  //   'task'  → a plain engine task (runNativeTask), verbatim from the old
  //             StandingLoops driver
  // Serialization: the top-of-tick `engineBusy` guard no-ops the whole tick
  // while THIS driver (`loopBusyRef`), the manager driver (`managerBusyRef`),
  // or ANY project is running/awaiting. That keeps the build loop, test loop,
  // task loop, manager driver, and manual `runProject` to one engine run at a
  // time app-wide. `loopBusyRef` is held ONLY across synchronous tick work
  // plus the AWAITED test/task runs (both bounded — they always settle via
  // their own timeouts). The build branch is deliberately fire-and-forget and
  // RELEASES the busy-ref before kicking off `runProject`: a project run can
  // park indefinitely on the human "one more refine?" gate, and holding the
  // busy-ref across it would wedge every other loop until a human answered.
  useEffect(() => {
    if (!isNative()) return
    const tick = async () => {
      // Honest no-op guards, checked before touching any schedule state: a
      // background tick with no real primary provider must do nothing, not
      // silently mark a schedule as failed.
      if (!isNative()) return
      const s = settingsRef.current
      const { providers, primaryReal } = buildEngineProviders(s)
      if (!primaryReal) return

      // One engine run at a time, app-wide: bail the whole tick while this
      // driver, the manager driver, or ANY project (running OR parked
      // 'awaiting' the human) is in flight. A fire-and-forget build started a
      // prior tick leaves its project 'running'/'awaiting', so this guard is
      // what serializes builds — the driver cleanly no-ops until the project
      // finishes or the human answers the parked gate, then resumes.
      if (engineBusy(loopBusyRef.current, managerBusyRef.current, getProjects().projects)) return
      const schedule = pickDueLoop(getSchedules(), Date.now(), false)
      if (!schedule) return

      loopBusyRef.current = true
      try {
        const kind = scheduleKind(schedule)
        const projectId = schedule.projectId ?? ''

        if (kind === 'build') {
          const project = getProjects().projects.find((p) => p.id === projectId)
          // Missing project (deleted, or an empty/stale projectId): record a
          // FAILED run so lastRun advances — a silent return would leave the
          // schedule due forever and starve every later schedule (pickDueLoop
          // keeps selecting it). Mirrors the 'test' branch's missing-project
          // handling.
          if (!project) {
            recordScheduleRun(schedule.id, Date.now(), false, 'build loop: project not found')
            return
          }
          // Never kick off runProject for a project mid-run or parked awaiting
          // the human — the top guard already ensures this, but guard here
          // too: an 'awaiting' project resumes on the human's answer, NOT a
          // driver tick, and re-entering runProject would double-run past the
          // gate. Skip silently (its status is the durable record); do NOT
          // record a run — nothing new happened.
          if (project.status === 'running' || project.status === 'awaiting') return
          // Pre-flight the start guards runProject would apply and REFUSE on
          // (empty plan / unusable dir): without this the loop would record a
          // green 'build loop started' for a build that never actually starts.
          // Record an honest 'not ready' failure and skip the kickoff instead.
          const dir = await expandUserPath(project.path)
          const notReady = buildLoopNotReady(project.plan, dir, project.status)
          if (notReady) {
            recordScheduleRun(schedule.id, Date.now(), false, notReady)
            return
          }
          // Companion grant (audit H1): denied writes stop scheduled builds
          // QUIETLY here (an honest schedule record, no notice spam per tick);
          // runProject's own gate stays the hard stop for manual clicks.
          if (!settingsRef.current.projectWrites) {
            recordScheduleRun(schedule.id, Date.now(), false, 'project writes denied in Settings')
            return
          }
          // FIRE-AND-FORGET: runProject can park indefinitely on the "one more
          // refine?" gate (DEFAULT_MAX_REFINES=2 → mainline, not an edge).
          // Holding loopBusyRef across it would wedge every other loop until a
          // human answered — so RELEASE the busy-ref first, then kick it off
          // unawaited. Releasing also lets runProject's OWN engine-busy guard
          // (managerBusy || loopBusy) pass for this call (it must not refuse
          // the very kickoff it was asked to make). Serialization from here is
          // owned by the project flipping to 'running'/'awaiting' (the top
          // guard + runProject's otherRunningProject check). Record 'started'
          // to advance lastRun. NOTE (accepted, pre-existing): a tens-of-ms
          // window exists between releasing the ref and the project reaching
          // 'running' where the manager driver or a manual "Run" click could
          // also start — a pre-existing runProject property (guarded by its
          // own otherRunningProject check); no per-project runId refactor
          // needed for this feature.
          loopBusyRef.current = false
          // HONEST RECORD (2026-08-31, found in the pre-launch stress check):
          // this used to log a green 'build loop started' the instant it
          // called runProject — so a build that runProject then REFUSED
          // (staffing refusal, engine busy, a gate) left a trail of cheerful
          // 'started' ticks and no run, for as long as the loop lived. The
          // kickoff now reports what actually happened: the project either
          // moved (running/awaiting/done) or it did not, and the reason it
          // gives is its own.
          void runProject(projectId).then(() => {
            const after = getProjects().projects.find((p) => p.id === projectId)
            const moved =
              !!after && (after.status !== 'planned' || after.stepIndex > project.stepIndex)
            recordScheduleRun(
              schedule.id,
              Date.now(),
              moved,
              moved
                ? 'build loop: run started'
                : `build loop: the build did not start — ${
                    after?.lastNote?.split('\n')[0]?.slice(0, 80) || 'no reason recorded'
                  }`,
            )
          })
          return
        }

        if (kind === 'test') {
          const project = getProjects().projects.find((p) => p.id === projectId)
          if (!project) {
            recordScheduleRun(schedule.id, Date.now(), false, 'test loop: project not found')
            return
          }
          // A project with no verify command has nothing to check — running
          // the engine anyway skips Tier-1 and lets the model judge an empty
          // intent, a FALSE green. Skip honestly and record a failure (never
          // a pass) WITHOUT touching the engine.
          const skip = testLoopSkipReason(project.verifyCommand)
          if (skip) {
            recordScheduleRun(schedule.id, Date.now(), false, skip)
            return
          }
          const dir = await expandUserPath(project.path)
          if (!isUsableProjectDir(dir)) {
            recordScheduleRun(schedule.id, Date.now(), false, 'test loop: project path not usable')
            dispatch({
              type: 'ADD_NOTICE',
              notice: {
                id: nextNoticeId(),
                projectId,
                kind: 'attention',
                text: `«${project.name}» test loop — project path is not usable.`,
              },
            })
            return
          }
          const vault = await resolveVaultDir(s.vaultPath)
          // Verify-only: no FILE-block writing, no branching (P2-2's
          // `run_engine_verify` seam) — this never writes project files or
          // touches git, it only executes verifyCommand and reports pass/fail.
          // A REAL engine run, so it registers like every other one (M1); a
          // scheduled check is its own kind, never a 'chat'.
          const testLiveId = beginLiveRun({
            kind: 'test',
            intent: `checking «${project.name}» — ${project.verifyCommand}`,
          })
          let testEnd: { outcome: RunOutcome; detail: string } = {
            outcome: 'stopped',
            detail: 'the check ended without a recorded outcome',
          }
          let ok = false
          try {
            const v = await runNativeVerify(dir, project.verifyCommand, vault, providers)
            ok = !!v && v.passed === true
            testEnd = ok
              ? { outcome: 'passed', detail: '' }
              : { outcome: 'failed', detail: v ? 'the checks failed' : 'the checks did not run' }
          } finally {
            endLiveRun(testLiveId, testEnd.outcome, testEnd.detail)
          }
          recordScheduleRun(schedule.id, Date.now(), ok, loopRunSummary('test', ok))
          if (!ok) {
            dispatch({
              type: 'ADD_NOTICE',
              notice: {
                id: nextNoticeId(),
                projectId,
                kind: 'attention',
                text: `«${project.name}» test loop — verify failed`,
              },
            })
          }
          return
        }

        // kind === 'task' — verbatim from the old Loop.tsx StandingLoops
        // driver: a plain engine task, not routed through any project.
        const vault = await resolveVaultDir(s.vaultPath)
        const taskRunId = newRunId()
        // A REAL engine run, so it registers like every other one (M1). Its own
        // kind — a standing task the app fires on a schedule is not a chat.
        const taskLiveId = beginLiveRun({
          id: taskRunId,
          kind: 'task',
          intent: schedule.task,
        })
        // Same shape as every other registered runner: compute the honest end,
        // clear in the `finally` so a throw can never leave the card glowing.
        let taskEnd: { outcome: RunOutcome; detail: string } = {
          outcome: 'stopped',
          detail: 'the scheduled task ended without a recorded outcome',
        }
        let verdict: Verdict | null = null
        let ok = false
        try {
          const taskOutcome = await raceCancelable(
            runNativeTask(schedule.task, vault, providers, taskRunId),
            180_000,
            taskRunId,
          )
          verdict = taskOutcome.timedOut ? null : taskOutcome.value
          ok = !!verdict && isRealCompletion(verdict.response)
          taskEnd = taskOutcome.timedOut
            ? { outcome: 'stopped', detail: weStoppedIt(180_000) }
            : ok
              ? { outcome: 'passed', detail: '' }
              : { outcome: 'failed', detail: 'no real reply' }
        } finally {
          endLiveRun(taskLiveId, taskEnd.outcome, taskEnd.detail)
        }
        recordScheduleRun(
          schedule.id,
          Date.now(),
          ok,
          ok ? (verdict!.response ?? '').slice(0, 120) : loopRunSummary('task', false),
        )
        if (!ok) {
          dispatch({
            type: 'ADD_NOTICE',
            notice: {
              id: nextNoticeId(),
              projectId: '',
              kind: 'attention',
              text: `standing loop "${schedule.task.slice(0, 60)}" — no real reply (provider offline?)`,
            },
          })
        }
      } finally {
        loopBusyRef.current = false
      }
    }
    const h = window.setInterval(() => void tick(), 20_000)
    return () => window.clearInterval(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Answer the parked "one more refine?" ask; the driver reads the decision
  // off the ref and continues (granted) or finishes 'attention' (declined).
  const answerProjectRequest = useMemo(() => {
    return (grant: boolean): void => {
      if (projectRequestRef.current !== 'pending') return
      projectRequestRef.current = grant ? 'granted' : 'declined'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Merge a finished existing-mode run's branch back into its base — a
  // one-shot user action (not part of the run driver's own state machine),
  // guarded the same way runProject guards a start: native required, the
  // project must not be mid-run (mergeReadiness === 'running' covers both
  // 'running' and the parked 'awaiting'), and there must actually be a run
  // branch to merge (mergeReadiness === 'no-branch' otherwise).
  const mergeProject = useMemo(() => {
    return async (projectId: string): Promise<void> => {
      const project = getProjects().projects.find((p) => p.id === projectId)
      if (!project) return

      const notify = (kind: Notice['kind'], text: string): void => {
        dispatch({ type: 'ADD_NOTICE', notice: { id: nextNoticeId(), projectId, kind, text } })
        // Courtesy mirror to the phone (companion grant) — outcome kinds only.
        notifyNotice(kind, text)
      }

      if (!isNative()) {
        notify('attention', `«${project.name}» needs the installed app to merge.`)
        return
      }
      const readiness = mergeReadiness(project)
      if (readiness === 'running') {
        notify('attention', `«${project.name}» is running — stop it before merging.`)
        return
      }
      // FIX B (v2 final review re-verdict, defense-in-depth): anything short
      // of 'ready' bails — 'no-branch' covers BOTH a missing runBranch and a
      // missing baseBranch (the killed-during-step-1 sticky case). Without a
      // baseBranch there is nothing honest to pass as the engine guard's
      // `into`, and passing '' would bypass that guard entirely.
      if (readiness !== 'ready') {
        notify(
          'attention',
          `«${project.name}» has no run branch to merge (or no base branch to merge into).`,
        )
        return
      }
      // Narrows `runBranch`/`baseBranch` to `string` for the call below —
      // mergeReadiness === 'ready' already guarantees both, but TS can't see
      // that across the function boundary.
      const runBranch = project.runBranch
      const baseBranch = project.baseBranch
      if (!runBranch || !baseBranch) return

      const dir = await expandUserPath(project.path)
      if (!isUsableProjectDir(dir)) {
        notify('attention', `«${project.name}» — project path is not usable.`)
        return
      }

      const result = await runNativeProjectMerge(dir, runBranch, baseBranch)
      if (result?.ok) {
        updateProject(projectId, { runBranch: '' })
        notify('done', `«${project.name}» merged into ${project.baseBranch || '(unknown)'}`)
      } else {
        notify('attention', result?.detail || 'merge failed — is the app native?')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dismiss one Companion-orb notice (jump-and-clear from the panel, or any
  // other explicit acknowledgement) — the reducer drops it by id.
  const clearNotice = useMemo(() => {
    return (id: string): void => {
      dispatch({ type: 'CLEAR_NOTICE', id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bind a project to the Workspace as the active session (P2-4) — Projects'
  // "Open in Workspace" button and the Workspace header switcher (Slice 1b)
  // both call this. Passing '' clears the binding (reducer normalizes it to
  // undefined). P1-3b: switching no longer drops a transcript divider — with
  // per-scope threads (Slice 2060652) each project already has its own
  // thread, so a divider was just noise, and it masked the Begin-interview
  // empty state on a freshly-switched-to project with no transcript yet.
  // ('divider' stays a valid ChatMessage kind and the reducer/persistence
  // still render/restore any that already exist in old sessions.)
  const setActiveProject = useMemo(() => {
    return (id: string): void => {
      dispatch({ type: 'SET_ACTIVE_PROJECT', projectId: id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Wipe the saved session and reset to the seeded example — a "new session"
  // affordance. Also supersedes any in-flight project run so its driver
  // can't write back.
  const clearSession = useMemo(() => {
    return (): void => {
      clearStoredSession()
      projectRunId.current += 1
      projectRequestRef.current = 'idle'
      dispatch({ type: 'RESET_SESSION' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      sendIntent,
      send,
      clearSession,
      runProject,
      answerProjectRequest,
      mergeProject,
      clearNotice,
      setActiveProject,
      compressNow,
      newSession,
      beginLiveRun,
      endLiveRun,
      pauseLiveRun,
      claimEngine,
      releaseEngine,
      launchTeam,
      sendTeam,
      wakeNow,
    }),
    [
      state,
      sendIntent,
      send,
      clearSession,
      runProject,
      answerProjectRequest,
      mergeProject,
      clearNotice,
      setActiveProject,
      compressNow,
      newSession,
      beginLiveRun,
      endLiveRun,
      pauseLiveRun,
      claimEngine,
      releaseEngine,
      launchTeam,
      sendTeam,
      wakeNow,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within <AppProvider>')
  return ctx
}

/**
 * The ONE "Wake now" binding, shared by the orb popover and the Agents
 * heartbeat card (2026-08-05 §Part 3). Both surfaces render the same button
 * from the same facts, so they can never show different availability for the
 * same engine.
 *
 * `reason` is the honest, reactive why-not (null = the wake can run): it is
 * `wakeNowBlockReason` fed from live store state — the heartbeat itself, a
 * really-configured primary, the orb's own live line, and the app's registered
 * live/parked runs. That last one is a REACTIVE view of the engine slot; the
 * authoritative check still happens inside `wakeNow` against the driver refs,
 * and if it refuses there, `fire()` surfaces THAT reason instead. So the button
 * is disabled whenever we can already prove it would refuse, and honest about
 * it in the rare case we only find out on the click.
 *
 * `busy` is true while this hook's own wake is in flight — used to keep the
 * button disabled between the click and the first live-state update (the
 * store's synchronous refs are the real double-fire guard; this is the visible
 * half of it).
 */
export function useWakeNow(): {
  reason: string | null
  disabled: boolean
  busy: boolean
  fire: () => Promise<void>
} {
  const { state, wakeNow } = useApp()
  const { settings } = useSettings()
  const managers = useManagers()
  const projects = useProjects()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const hb = managers.managers.find((m) => m.id === COMPANION_MANAGER_ID)?.heartbeat
  const known = wakeNowBlockReason({
    hb,
    primaryReal: isNative() ? buildEngineProviders(settings).primaryReal : false,
    waking: busy || state.heartbeatLive !== null,
    engineBusy:
      activeRuns(state.liveRuns).length > 0 ||
      projects.projects.some((p) => p.status === 'running' || p.status === 'awaiting'),
  })
  // A refusal that only the store could know (the click lost a race for the
  // engine slot) is REPORTED but does not latch the button off — the next
  // click is allowed to try again, and the message is replaced by whatever
  // actually happens then.
  const reason = known ?? refusal

  const fire = async (): Promise<void> => {
    if (busy || known) return
    setBusy(true)
    setRefusal(null)
    try {
      setRefusal(await wakeNow())
    } finally {
      setBusy(false)
    }
  }

  return { reason, disabled: busy || known !== null, busy, fire }
}
