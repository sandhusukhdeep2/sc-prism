// SC Prism — project interview chat prompts.
// Guides the AI to conduct a structured grill-first interview with clarifying
// questions, then emit a parseable plan block.

import type { Project, ProjectTurn } from './projects'
import { extractVerifyCommand, parsePlanBlock } from './projects'
import { newRunId, type EngineProviders } from './nativeEngine'
import {
  DEFAULT_TURN_BUDGET,
  UNREACHABLE_TEXT,
  cancelledText,
  stubText,
  waitWithBudget,
  type EngineStep,
  type StopFacts,
  type TurnBudget,
} from './runBudget'

/** Cap on how many transcript turns feed the interview prompt each round —
 * the FULL transcript up to this many turns, not just a short recent tail,
 * so a 5-question interview (10 turns) never loses its earliest answers. */
export const MAX_INTERVIEW_TRANSCRIPT_TURNS = 24

/** The window of transcript turns to inline as prompt context this round. */
export function interviewTranscriptWindow(transcript: ProjectTurn[]): ProjectTurn[] {
  return transcript.slice(-MAX_INTERVIEW_TRANSCRIPT_TURNS)
}

/** Strip literal ===PLAN=== / ===END=== marker occurrences (case-insensitive,
 * with optional surrounding whitespace) from interpolated values, so a hostile
 * project name or goal cannot smuggle a parseable plan block into the system
 * prompt. Only the prompt's own template may carry the markers. */
function stripPlanMarkers(value: string): string {
  return value.replace(/\s*===(?:PLAN|END)===\s*/gi, '')
}

/**
 * Generate a system prompt for interviewing a project lead about project `p`.
 * Instructs the AI to act as the project's lead, ask ONE clarifying question at
 * a time (3-5 total), covering audience, style, content, constraints, and
 * finally emit a plan block in the exact ===PLAN=== format.
 */
export function interviewSystemPrompt(p: Project): string {
  const name = stripPlanMarkers(p.name)
  const goal = stripPlanMarkers(p.goal)
  return `You are the lead for a project called "${name}" with the goal: "${goal}"

Your job is to clarify the project scope by asking ONE clarifying question at a time. You will ask 3-5 questions total, covering topics like:
- Who is the audience for this project?
- What is the style or approach we should take?
- What content or features are most important?
- Are there constraints (time, budget, technical limits) we should know about?

Use plain language—no jargon. Listen carefully to each answer before moving to the next question.

After you have asked all 3-5 questions and received the final answer, emit exactly one plan block in this format (copy this format exactly — the ===PLAN=== and ===END=== marker lines and numbered steps):

===PLAN===
brief: <one-line project brief>
1. <first step>
2. <second step>
===END===

IMPORTANT: The FIRST step in the plan must always be:
"Write PROJECT.md: one page describing the project goal and stack"

IMPORTANT: every step's deliverable must be one or more files the step writes — never bare analysis. A research, mapping, or analysis step must say which file captures its findings (e.g. "write docs/<topic>.md capturing ..."). The build system only accepts steps that produce files; a step asking for prose alone will fail.

After the plan block, emit nothing else—no additional narration, explanation, or commentary.

Begin by asking the first question.`
}

/**
 * Check if the given text contains a valid, parseable plan block.
 * Returns true if parsePlanBlock(text) succeeds and returns a non-null result.
 *
 * Note: B4's parse handler also prepends the PROJECT.md first step defensively
 * if it's missing, so this just needs to verify the block parses correctly.
 */
export function isPlanReady(text: string): boolean {
  const parsed = parsePlanBlock(text)
  return parsed !== null
}

/** Injected dependencies for `runInterviewTurn` — everything the pure engine
 * needs to run one turn without importing the store (avoids a circular
 * import) or React. Both `ProjectView.askProject` and the store's bound
 * runner supply the same shape, backed by their own settings/refs. */
export interface InterviewTurnDeps {
  native: boolean
  buildProviders: () => { providers: EngineProviders; primaryReal: boolean }
  resolveVault: () => Promise<string>
  /** `runId` is the launch's cancellation handle — pass it straight through to
   *  the engine so a timeout here can actually kill the child. */
  runTask: (
    prompt: string,
    vault: string,
    providers: EngineProviders,
    runId: string,
  ) => Promise<{ response?: string } | null>
  /** Kill the engine child for `runId` (nativeEngine.cancelEngineRun). Omitted
   *  in tests/browser, where there is no subprocess to kill. */
  cancelRun?: (runId: string) => void
  isRealCompletion: (s: string | undefined) => boolean
  appendTurn: (id: string, turn: ProjectTurn) => void
  updateProject: (id: string, patch: Partial<Project>) => void
  onTurn?: (turn: ProjectTurn) => void // display hook (e.g. dispatch to the chat thread)
  /** Hard override for BOTH bounds — tests pass a few ms. Production passes
   *  nothing and gets the measured `budget` below. */
  timeoutMs?: number
  /** The measured budget for this exchange (`runBudget.turnBudget`). Omitted →
   *  the historical 90s stall, so an unmeasured machine behaves as before. */
  budget?: TurnBudget
  /** Newest closed engine step, from the vault's span tail. Serves two jobs:
   *  it is the PROGRESS proof that keeps a live-but-slow run alive, and it is
   *  the evidence the stop message cites for what the run was doing. Omitted in
   *  the browser/tests → the wait degrades to one flat measured wall. */
  lastStep?: () => Promise<EngineStep | null>
  /** The engine's own words for why a non-real reply is non-real (AppStore
   *  `offlineReason`). Injected rather than imported — AppStore imports THIS
   *  module, so importing back would be circular. */
  offlineReason?: (text: string | undefined) => string
}

/**
 * How ONE interview turn ended — a tagged union so no caller has to guess, and
 * so the three no-answer endings can never again be collapsed into "timed out
 * or the AI could not be reached" (the false line the user was shown when every
 * call had in fact answered).
 */
export type InterviewEnding =
  | { kind: 'reply'; planReady: boolean }
  /** WE cancelled it. `facts` carries elapsed, which bound bit, and the last
   *  step we could see — everything the honest message needs. */
  | { kind: 'cancelled'; facts: StopFacts }
  /** Nothing came back at all — a genuine unreachable/error. */
  | { kind: 'unreachable' }
  /** A placeholder came back instead of a completion. */
  | { kind: 'stub'; reason: string }
  | { kind: 'no-engine' }
  | { kind: 'no-provider' }

/**
 * Run ONE interview turn. Records the user's message (if any), asks the AI
 * the next clarifying question (or receives the plan), records the reply,
 * and — when the reply carries a parseable plan — promotes the project to
 * `planned` (adding the mandatory PROJECT.md first step if the model omitted
 * it). Shared by `ProjectView.askProject` and the store's `send()` so the two
 * callers can never drift.
 *
 * Returns HOW the turn ended, so the run row and the chat bubble tell the same
 * true story instead of each inferring one.
 */
export async function runInterviewTurn(
  project: Project,
  userText: string,
  deps: InterviewTurnDeps,
): Promise<InterviewEnding> {
  const record = (turn: ProjectTurn): void => {
    deps.appendTurn(project.id, turn)
    deps.onTurn?.(turn)
  }

  if (userText.trim()) {
    record({ role: 'user', text: userText.trim() })
  }

  if (!deps.native) {
    record({ role: 'ai', text: 'Project interviews need the installed app.' })
    return { kind: 'no-engine' }
  }

  const { providers, primaryReal } = deps.buildProviders()
  if (!primaryReal) {
    record({ role: 'ai', text: 'No primary AI is connected yet — connect a real provider first.' })
    return { kind: 'no-provider' }
  }

  const transcript = interviewTranscriptWindow(project.transcript)
    .map((m) => `${m.role === 'user' ? 'user' : 'you'}: ${m.text}`)
    .join('\n')
  const prompt = [
    interviewSystemPrompt(project),
    '',
    transcript ? `Conversation so far:\n${transcript}` : 'Conversation so far: (none)',
    userText ? `user: ${userText}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const vault = await deps.resolveVault()
  // Cancellable launch (mission-control audit H5). A bare race left the engine
  // child ALIVE after a client timeout, and every run appends to the ONE
  // spans.jsonl — so an abandoned interview kept writing spans that the next
  // run to register picked up as its own. Mint a real run id, hand it to the
  // engine, and KILL the child when we give up.
  //
  // The BOUND itself is no longer a flat 90s wall (2026-08-16). That wall was
  // set when every turn was cloud-fast; the moment an interview reads the vault
  // the egress floor pins the rest of the run to the local model, and on this
  // machine a local turn costs 60-70s — so a healthy 187s interview was killed
  // and reported as an unreachable provider. Now: a measured stall window that
  // the run re-earns each time the engine finishes a step, under an absolute
  // ceiling (see `runBudget`). The floor is untouched — nothing here routes.
  const budget = deps.budget ?? DEFAULT_TURN_BUDGET
  const stallMs = deps.timeoutMs ?? budget.stallMs
  const ceilingMs = deps.timeoutMs ?? budget.ceilingMs
  const runId = newRunId()
  const outcome = await waitWithBudget(deps.runTask(prompt, vault, providers, runId), {
    stallMs,
    ceilingMs,
    progress: deps.lastStep ? async () => (await deps.lastStep!())?.at ?? null : undefined,
  })

  if (!outcome.done) {
    deps.cancelRun?.(runId)
    // What was it doing when we pulled the plug? Real span evidence only — no
    // evidence means the message makes no claim about the model.
    let lastStep: EngineStep | undefined
    try {
      lastStep = (await deps.lastStep?.()) ?? undefined
    } catch {
      lastStep = undefined
    }
    const facts: StopFacts = {
      elapsedMs: outcome.elapsedMs,
      reason: outcome.reason,
      stallMs,
      ceilingMs,
      lastStep,
      localTypicalMs: budget.localTypicalMs,
    }
    record({ role: 'ai', text: cancelledText(facts) })
    return { kind: 'cancelled', facts }
  }

  const verdict = outcome.value

  if (verdict && deps.isRealCompletion(verdict.response)) {
    const reply = verdict.response as string
    record({ role: 'ai', text: reply })
    if (project.status === 'new') deps.updateProject(project.id, { status: 'interviewing' })

    let planReady = false
    if (isPlanReady(reply)) {
      const parsed = parsePlanBlock(reply)
      if (parsed) {
        planReady = true
        const firstMentionsProjectMd = /PROJECT\.md/i.test(parsed.plan[0] ?? '')
        const plan = firstMentionsProjectMd
          ? parsed.plan
          : ['Write PROJECT.md: one page describing the project goal and stack', ...parsed.plan]
        const patch: Partial<Project> = { brief: parsed.brief, plan, status: 'planned' }
        // The verify command the plan itself names becomes the project's
        // Tier-1 gate — only when the user hasn't set one, and never invented
        // (extractVerifyCommand returns '' rather than guess).
        if (!project.verifyCommand.trim()) {
          const verifyCommand = extractVerifyCommand(plan, project.goal)
          if (verifyCommand) patch.verifyCommand = verifyCommand
        }
        deps.updateProject(project.id, patch)
      }
    }
    return { kind: 'reply', planReady }
  }

  // Not a cancellation — the engine returned. Two DIFFERENT things live here and
  // they used to share one false sentence: a placeholder (something answered,
  // just not a model) and nothing at all (genuinely unreachable).
  const response = verdict?.response
  if (typeof response === 'string' && response.trim()) {
    const reason = deps.offlineReason?.(response) ?? ''
    record({ role: 'ai', text: stubText(reason) })
    return { kind: 'stub', reason }
  }
  record({ role: 'ai', text: UNREACHABLE_TEXT })
  return { kind: 'unreachable' }
}
