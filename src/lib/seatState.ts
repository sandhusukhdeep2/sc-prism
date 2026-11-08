// What ONE seat on the crew board says about its agent right now, read from
// that agent's own spans — never from a plan, a timer or a guess.
//
// The words are narrate.ts's vocabulary so the board, the chat and the run
// stream describe the same span the same way: thinking · reading your notes ·
// searching the web · using <server · tool> · blocked · withheld · no answer ·
// done. A refused turn carries the engine's own cause (the `error` attr the
// gateway writes since 2026-11-08) so the seat can say WHY there was no answer.
import type { EngineSpan } from './nativeEngine'
import { toolEnding, toolTarget } from './agentDossier'

export type SeatKind = 'thinking' | 'tool' | 'blocked' | 'withheld' | 'no-answer' | 'done' | 'idle'

export interface SeatState {
  kind: SeatKind
  text: string
  /** The engine's cause for a refused / stood-in turn, verbatim. */
  cause?: string
  /** tokens_in + tokens_out over this agent's WORK turns — "tokens so far". */
  tokens: number
}

const VAULT_TOOLS = new Set(['vault_read', 'vault_list', 'vault_search'])
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

function str(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : ''
}

function num(attrs: Record<string, unknown> | undefined, key: string): number {
  const v = attrs?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Not closed by the engine: the same test narrate.ts and RunStream apply. */
function isOpen(s: EngineSpan): boolean {
  return s.status !== 'ok' && s.status !== 'error'
}

/** A WORK turn. The Tier-2 judge's own `eval` call is a model_call span too,
 *  but it is not this agent doing its job (observability.run_series draws the
 *  same line). */
function isWorkCall(s: EngineSpan): boolean {
  return (s.type === 'model_call' || s.name === 'model_call') && s.name !== 'eval'
}

function isTool(s: EngineSpan): boolean {
  return s.type === 'tool_exec' || s.name === 'tool_exec'
}

export function seatState(spans: readonly EngineSpan[], agent: string, live: boolean): SeatState {
  const mine = spans.filter((s) => str(s.attrs, 'agent') === agent && (isWorkCall(s) || isTool(s)))
  const tokens = mine
    .filter(isWorkCall)
    .reduce((n, s) => n + num(s.attrs, 'tokens_in') + num(s.attrs, 'tokens_out'), 0)
  if (mine.length === 0) return { kind: 'idle', text: '', tokens }

  // The latest span decides. `>=` so two spans at the same instant resolve to
  // the one the engine wrote last.
  const latest = mine.reduce((a, b) => ((b.start ?? 0) >= (a.start ?? 0) ? b : a))
  const a = latest.attrs
  // An open span on a run that is NOT live reads as its closed form: a parked
  // run is not thinking, whatever its last span's status says.
  const open = live && isOpen(latest)

  if (isTool(latest)) {
    const ending = toolEnding(a)
    // A capability refusal (capabilities.py writes `refused: true`) is a gate
    // saying no — the same story as a blocked tool, never a failure.
    if (ending === 'blocked' || a?.refused === true) return { kind: 'blocked', text: 'blocked', tokens }
    if (ending === 'withheld') return { kind: 'withheld', text: 'withheld', tokens }
    if (open) {
      const name = str(a, 'tool')
      const server = str(a, 'server')
      if (VAULT_TOOLS.has(name) || server === 'vault') return { kind: 'tool', text: 'reading your notes', tokens }
      if (WEB_TOOLS.has(name) || server === 'web') return { kind: 'tool', text: 'searching the web', tokens }
      const label = [server, name].filter(Boolean).join(' · ') || toolTarget(a) || 'a tool'
      return { kind: 'tool', text: `using ${label}`, tokens }
    }
    if (latest.status === 'error' || ending === 'failed') {
      const cause = str(a, 'error')
      return cause ? { kind: 'no-answer', text: 'failed', cause, tokens } : { kind: 'no-answer', text: 'failed', tokens }
    }
    return { kind: 'done', text: 'done', tokens }
  }

  if (open) return { kind: 'thinking', text: 'thinking', tokens }
  // No completion: the gateway's stand-in (`is_real: false`) OR a turn the
  // engine closed with status=error (telemetry.py writes the exception into
  // `error` with no is_real at all). Both are "no answer", never "done".
  if (a?.is_real === false || latest.status === 'error') {
    const cause = str(a, 'error')
    return cause ? { kind: 'no-answer', text: 'no answer', cause, tokens } : { kind: 'no-answer', text: 'no answer', tokens }
  }
  // The engine writes a span only when it closes, so on a LIVE run a closed
  // turn means "this agent has answered", not that the work is done — "done"
  // is for a finished run.
  return { kind: 'done', text: live ? 'answered' : 'done', tokens }
}
