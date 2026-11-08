// Who handed work to whom, read from the spans alone.
//
// A team run's work turns are `model_call` spans carrying `agent` (and, when
// the engine knows it, `stage` or `round`). When two consecutive turns belong
// to different agents, the work changed hands — that is the whole definition.
// Nothing is drawn that two spans do not establish, and the label is the
// engine's own word for the later turn ('' when it gave none; never invented).
import type { EngineSpan } from './nativeEngine'

export interface Handoff {
  from: string
  to: string
  /** The later turn's `stage`, else `round <n>`, else ''. */
  label: string
}

function agentOf(s: EngineSpan): string {
  const v = s.attrs?.agent
  return typeof v === 'string' ? v : ''
}

/** A WORK turn: a model_call that is not the Tier-2 judge's own `eval` call. */
function isWorkTurn(s: EngineSpan): boolean {
  return (s.type === 'model_call' || s.name === 'model_call') && s.name !== 'eval' && agentOf(s) !== ''
}

function labelOf(s: EngineSpan): string {
  const stage = s.attrs?.stage
  if (typeof stage === 'string' && stage.trim()) return stage.trim()
  const round = s.attrs?.round
  if (typeof round === 'number' && Number.isFinite(round)) return `round ${round}`
  return ''
}

export function handoffs(spans: readonly EngineSpan[]): Handoff[] {
  const turns = spans.filter(isWorkTurn).slice().sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  const out: Handoff[] = []
  for (let i = 1; i < turns.length; i++) {
    const from = agentOf(turns[i - 1])
    const to = agentOf(turns[i])
    if (from === to) continue
    const h = { from, to, label: labelOf(turns[i]) }
    const last = out[out.length - 1]
    if (last && last.from === h.from && last.to === h.to && last.label === h.label) continue
    out.push(h)
  }
  return out
}
