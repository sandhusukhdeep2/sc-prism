// agentDossier — everything ONE coworker really did on a run.
//
// The board (CrewBoard / pipeline.ts) answers "who is on this job and what are
// they doing right now?". This answers the question you ask by clicking one of
// them: "what is THIS agent actually doing, and on whose model, and why there?"
//
// Sukhdeep's standing complaint was never that the app lacked a picture — it
// was that the picture did not let him check on an individual coworker. A crew
// cluster that cannot be opened is decoration.
//
// THE RULES, same as pipeline.ts, because the same lie is available here:
//  1. Every field is read from a span attr the ENGINE wrote. Nothing is
//     inferred, averaged or filled in. An attr the engine did not write yields
//     an empty field, and the panel says nothing rather than something plausible.
//  2. Tokens are SUMMED from real `tokens_in`/`tokens_out`, never estimated. A
//     turn that reported none contributes nothing (not a guess).
//  3. `live` is the caller's real liveness AND an open span — a paused run can
//     never make an agent look busy. Same rule, same reason, as the board.
//  4. Routing is quoted, not paraphrased: `reason` is the engine's own sentence
//     for why this call went where it went ("vault content read -> kept local
//     (no egress)"). It is the most useful thing on the panel and the easiest
//     to accidentally invent, so it is passed through verbatim or left empty.
//  5. A tool call reports what really happened to it, including the endings
//     that are NOT success: blocked by a gate, held for approval, result
//     withheld from a cloud POST. Those are governance wins and the panel
//     shows them as first-class outcomes, never as failures or as nothing.
import type { EngineSpan } from './nativeEngine'
import { IDLE_HUE, modelColor } from './modelColor'

/** One model turn this agent took: what answered, why there, what it cost. */
export interface DossierTurn {
  /** `provider · model`, or '' when the span named neither. */
  ai: string
  /** The engine's OWN sentence for why the call routed where it did. */
  reason: string
  /** True only when the span said so — an on-device turn. */
  local: boolean
  tokensIn: number
  tokensOut: number
  /** Wall time for this turn, ms. 0 when the span carried no duration. */
  ms: number
  /** The engine's raw `round` attr, verbatim ('' when it carried none). */
  stage: string
  /** Still open — the engine has not closed this span. */
  open: boolean
  /** The span said the answer was a genuine model reply, not a stand-in. */
  real: boolean
  /**
   * The provider stopped because it hit the OUTPUT CAP — this turn's text is
   * cut off, not finished.
   *
   * Worth its own field because of what a truncated reply from a reasoning
   * model actually looks like. Measured on Sukhdeep's local endpoint: when the
   * cap bites, the server returns the model's raw internal monologue as the
   * answer ("We need answer user's request. Need produce final...") and leaves
   * `reasoning_content` empty. Shown without this flag it reads as an agent
   * that has lost its mind; shown with it, it reads as an answer that ran out
   * of room, which is what it is and which the user can act on.
   */
  truncated: boolean
}

/** One tool this agent ran, and how it really ended. */
export interface DossierTool {
  /** The tool's name, from the `tool` attr. */
  name: string
  /** What it was pointed at — a vault path, a query, a URL. '' when none. */
  target: string
  /**
   * How it ended, in the engine's terms:
   *  'ok'       — it ran and returned
   *  'blocked'  — a gate refused it (a governance WIN, not a failure)
   *  'held'     — parked waiting for a human decision
   *  'withheld' — it ran, but its result was kept out of a cloud POST
   *  'failed'   — it really errored
   */
  ending: 'ok' | 'blocked' | 'held' | 'withheld' | 'failed'
  ms: number
}

/** The whole file on one coworker. */
export interface AgentDossier {
  agent: string
  /** Tint from the model that really answered its LATEST turn. */
  color: string
  /** `provider · model` of the latest turn — what it is running on now. */
  ai: string
  /** May this agent pulse? Open span AND a genuinely live run. */
  live: boolean
  turns: DossierTurn[]
  tools: DossierTool[]
  /** Real sums over the turns above. */
  tokensIn: number
  tokensOut: number
  /** Total model time, ms — the sum of real span durations. */
  modelMs: number
  /** Distinct stages this agent appeared at, in the order they happened. */
  stages: string[]
  /** True when EVERY turn ran on-device. The 🔒 claim, and it must be total. */
  allLocal: boolean
}

function attrStr(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function attrNum(attrs: Record<string, unknown> | undefined, key: string): number {
  const v = attrs?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** `provider · model`, or just one of them, or '' when the span named neither. */
export function aiLabel(attrs: Record<string, unknown> | undefined): string {
  const provider = attrStr(attrs, 'provider')
  const model = attrStr(attrs, 'model')
  if (provider && model) return `${provider} · ${model}`
  return provider || model || ''
}

/**
 * How a tool call ended, read from the attrs the engine actually writes.
 *
 * Order matters and is deliberate: a call that was BLOCKED by a gate may also
 * carry `ok:false`, and reporting that as "failed" would turn a governance win
 * into a bug report. The refusal is the truer statement, so it is checked first.
 */
export function toolEnding(attrs: Record<string, unknown> | undefined): DossierTool['ending'] {
  if (attrs?.blocked === true) return 'blocked'
  if (attrs?.held === true || attrs?.awaiting === true) return 'held'
  if (attrs?.withheld === true) return 'withheld'
  if (attrs?.is_error === true || attrs?.ok === false) return 'failed'
  return 'ok'
}

/** What the tool was pointed at, whichever of the target attrs it carried. */
export function toolTarget(attrs: Record<string, unknown> | undefined): string {
  return (
    attrStr(attrs, 'path') ||
    attrStr(attrs, 'query') ||
    attrStr(attrs, 'url') ||
    attrStr(attrs, 'server') ||
    ''
  )
}

/**
 * Build the dossier for ONE agent from the spans of ONE run.
 *
 * `live` is the caller's real run-level liveness (`activeRuns(...).length > 0`),
 * exactly as the board passes it. Without it no turn may be called open, so a
 * paused run cannot animate.
 *
 * Returns null when this agent has no spans at all — there is no file to open
 * on a coworker that never ran, and an empty panel implying otherwise is the
 * kind of confident blank this app does not ship.
 */
export function agentDossier(
  spans: readonly EngineSpan[],
  agent: string,
  live: boolean,
): AgentDossier | null {
  const name = (agent ?? '').trim()
  if (!name) return null

  const turns: DossierTurn[] = []
  const tools: DossierTool[] = []
  const stages: string[] = []
  let tokensIn = 0
  let tokensOut = 0
  let modelMs = 0

  for (const span of spans) {
    const attrs = span.attrs ?? {}
    if (attrStr(attrs, 'agent') !== name) continue
    const ms = typeof span.duration_ms === 'number' ? span.duration_ms : 0

    if (span.type === 'model_call') {
      // An open span is one the engine never closed. `status` is the engine's
      // own word for it; a closed span with no duration is still closed.
      const open = live && span.status !== 'ok' && span.status !== 'error'
      const stage = attrStr(attrs, 'round')
      if (stage && !stages.includes(stage)) stages.push(stage)
      const tin = attrNum(attrs, 'tokens_in')
      const tout = attrNum(attrs, 'tokens_out')
      tokensIn += tin
      tokensOut += tout
      modelMs += ms
      turns.push({
        ai: aiLabel(attrs),
        reason: attrStr(attrs, 'reason'),
        local: attrs.is_local === true,
        tokensIn: tin,
        tokensOut: tout,
        ms,
        stage,
        open,
        real: attrs.is_real === true,
        truncated: attrs.truncated === true,
      })
      continue
    }

    if (span.type === 'tool_exec') {
      tools.push({
        name: attrStr(attrs, 'tool') || span.name || 'tool',
        target: toolTarget(attrs),
        ending: toolEnding(attrs),
        ms,
      })
    }
  }

  if (turns.length === 0 && tools.length === 0) return null

  const latest = turns[turns.length - 1]
  return {
    agent: name,
    // The tint names the model that really answered LAST. No turns at all (a
    // tool-only agent) has no model to name, so it stays grey rather than
    // borrowing a colour from a call that never happened.
    color: latest?.ai ? modelColor(latest.ai) : IDLE_HUE,
    ai: latest?.ai ?? '',
    live: turns.some((t) => t.open),
    turns,
    tools,
    tokensIn,
    tokensOut,
    modelMs,
    stages,
    // "Everything stayed on your Mac" is only sayable when EVERY turn did.
    // One cloud turn makes it false, and an agent with no turns cannot claim it.
    allLocal: turns.length > 0 && turns.every((t) => t.local),
  }
}

/** Every agent that really appears in these spans, in first-seen order. */
export function agentsInRun(spans: readonly EngineSpan[]): string[] {
  const out: string[] = []
  for (const span of spans) {
    const agent = attrStr(span.attrs, 'agent')
    if (agent && !out.includes(agent)) out.push(agent)
  }
  return out
}

/** "3 turns · 12.4k in / 900 out" — the one-line cost of a coworker, real sums
 *  only. Empty parts are omitted rather than shown as zero. */
export function dossierCostLine(d: AgentDossier): string {
  const bits: string[] = []
  if (d.turns.length) bits.push(`${d.turns.length} turn${d.turns.length === 1 ? '' : 's'}`)
  if (d.tokensIn || d.tokensOut) bits.push(`${compact(d.tokensIn)} in / ${compact(d.tokensOut)} out`)
  if (d.modelMs) bits.push(secs(d.modelMs))
  return bits.join(' · ')
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function secs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/**
 * The plain sentence for where this agent's work ran.
 *
 * Reuses the engine's own `reason` when it gave one, because the engine knows
 * something the UI cannot infer — that a vault read forced the run local, for
 * instance. Falls back to the bare fact (on-device / sent to a cloud model),
 * and to silence when even that is unknown.
 */
export function routingLine(d: AgentDossier): string {
  const reason = d.turns.map((t) => t.reason).filter(Boolean).pop()
  if (reason) return reason
  if (!d.turns.length) return ''
  if (d.allLocal) return 'ran on your Mac'
  return 'answered by a cloud model'
}
