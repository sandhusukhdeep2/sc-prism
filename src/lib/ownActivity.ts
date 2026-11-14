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
  /** Turns that really got an answer: closed, a real completion, no error.
   *  What "proven by its work" rests on. */
  answered: number
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
  const answered = turns.filter((s) => s.status === 'ok' && s.attrs?.is_real !== false).length

  if (live && isOpen(latest)) {
    return { state: 'working', label: 'working…', turns: turns.length, answered, toolCalls, tokens, allLocal }
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
  return { state: noAnswer ? 'failed' : 'ok', label: parts.join(' · '), turns: turns.length, answered, toolCalls, tokens, allLocal }
}

/** One of the agent's own work turns, in the span's own figures. */
export interface RecordTurn {
  /** The engine's `round` attr: 'proof', '1', 'synthesis', a wake's label… */
  stage: string
  /** `provider · model` that really took the turn ('' when the span named neither). */
  ai: string
  local: boolean
  tokensIn: number
  tokensOut: number
  /** Wall time in ms; 0 when the span carried none (still open). */
  ms: number
  result: 'answered' | 'no answer' | 'working'
  /** The engine's cause for a turn with no answer, verbatim. */
  cause?: string
  /** When the turn started, epoch ms (the span's `start` is engine seconds). */
  at: number
}

export interface AgentRecord {
  /** Newest first, at most `limit`. */
  turns: RecordTurn[]
  /** Tools it called, most used first. */
  tools: { name: string; count: number }[]
}

/**
 * THE AGENT'S RECORD (2026-11-11): what it has really done, for its own page —
 * the latest turns and the tools it called, read from the spans that carry its
 * name. Nothing is inferred: an agent with no span of its own has an empty
 * record, and the page says so.
 */
export function agentRecord(spans: readonly EngineSpan[], agent: string, limit = 8): AgentRecord {
  const key = seatKey(agent)
  if (!key) return { turns: [], tools: [] }
  const mine = spans
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => seatKey(str(s.attrs, 'agent')) === key)
  const turns = mine
    .filter(({ s }) => isWork(s))
    .sort((a, b) => (b.s.start ?? 0) - (a.s.start ?? 0) || b.i - a.i)
    .slice(0, Math.max(0, limit))
    .map(({ s }): RecordTurn => {
      const a = s.attrs
      const round = a?.round
      const noAnswer = a?.is_real === false || s.status === 'error'
      const cause = str(a, 'error')
      return {
        stage: typeof round === 'string' ? round : typeof round === 'number' ? String(round) : '',
        ai: [str(a, 'provider'), str(a, 'model')].filter(Boolean).join(' · '),
        local: a?.is_local === true,
        tokensIn: num(a, 'tokens_in'),
        tokensOut: num(a, 'tokens_out'),
        ms: typeof s.duration_ms === 'number' && Number.isFinite(s.duration_ms) ? s.duration_ms : 0,
        result: isOpen(s) ? 'working' : noAnswer ? 'no answer' : 'answered',
        ...(noAnswer && cause ? { cause } : {}),
        at: Math.round((s.start ?? 0) * 1000),
      }
    })
  const counts = new Map<string, number>()
  for (const { s } of mine) {
    if (!isTool(s)) continue
    const name = str(s.attrs, 'tool')
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const tools = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { turns, tools }
}
