// What ONE agent's card says about ITS OWN work, read from the spans that
// carry its name (the engine writes `agent` on every model turn and, since
// 2026-11-09, on every tool call made during its turn). Never from the
// model-wide tally: five tiles reading "73 runs on local · 14% pass" was one
// global number wearing five agents' names.
import type { EngineSpan } from './nativeEngine'

export type OwnState = 'working' | 'ok' | 'failed'

export interface OwnActivity {
  state: OwnState
  label: string
  turns: number
  toolCalls: number
  tokens: number
  allLocal: boolean
}

function str(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : ''
}
function num(attrs: Record<string, unknown> | undefined, key: string): number {
  const v = attrs?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
const isWork = (s: EngineSpan) => (s.type === 'model_call' || s.name === 'model_call') && s.name !== 'eval'
const isTool = (s: EngineSpan) => s.type === 'tool_exec' || s.name === 'tool_exec'
const isOpen = (s: EngineSpan) => s.status !== 'ok' && s.status !== 'error'

/** `null` when the log holds no turn of this agent's own — the card then
 *  falls back to the model-wide line, which says what IT counts. */
/** The engine writes the seat's name as it was given — a team run uses the
 *  slug ('reviewer-verifier'), the companion its display name ('Sukh') — so
 *  both sides are compared as slugs. */
export function seatKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function ownActivity(spans: readonly EngineSpan[], agent: string, live: boolean): OwnActivity | null {
  const key = seatKey(agent)
  if (!key) return null
  const mine = spans.filter((s) => seatKey(str(s.attrs, 'agent')) === key)
  const turns = mine.filter(isWork)
  if (turns.length === 0) return null
  const toolCalls = mine.filter(isTool).length
  const tokens = turns.reduce((n, s) => n + num(s.attrs, 'tokens_in') + num(s.attrs, 'tokens_out'), 0)
  const allLocal = turns.every((s) => s.attrs?.is_local === true)
  const latest = turns.reduce((a, b) => ((b.start ?? 0) >= (a.start ?? 0) ? b : a))

  if (live && isOpen(latest)) {
    return { state: 'working', label: 'working…', turns: turns.length, toolCalls, tokens, allLocal }
  }
  const noAnswer = latest.attrs?.is_real === false || latest.status === 'error'
  const cause = str(latest.attrs, 'error')
  const last = noAnswer ? `last no answer${cause ? ` — ${cause}` : ''}` : 'last answered'
  const parts = [
    `${turns.length} turn${turns.length === 1 ? '' : 's'}`,
    last,
    `${tokens.toLocaleString()} tokens`,
    ...(toolCalls > 0 ? [`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`] : []),
    ...(allLocal ? ['all on your Mac'] : []),
  ]
  return { state: noAnswer ? 'failed' : 'ok', label: parts.join(' · '), turns: turns.length, toolCalls, tokens, allLocal }
}
