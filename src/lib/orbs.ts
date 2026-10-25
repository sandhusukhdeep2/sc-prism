// orbs — the "feel it" depth for Manager View: the team as model-colored
// orbs (agentOrbs derives the data; OrbView renders it). Pure + deterministic
// like modelColor: same spans in, same orbs out, no I/O, no invented state.
//
// HONESTY: an orb exists only for an agent with a REAL model_call span — no
// span, no orb. The pulse/glow this feeds is gated on the caller's `running`
// flag (a real signal), never on anything derived here.
import type { EngineSpan } from './nativeEngine'
import { modelColor } from './modelColor'

export interface AgentOrb {
  agent: string
  model: string
  provider: string
  color: string
  // Mirrors RunStream's status glyph exactly: 'ok' (✓) / 'failed' (✕) / and
  // 'running' for an IN-FLIGHT span (status neither ok nor error). A running
  // span must NOT be painted as passed — OrbView shows no colored ring for it,
  // only the whole-cluster pulse, so the two views never disagree.
  outcome: 'ok' | 'failed' | 'running'
}

/**
 * One orb per distinct agent that has a model_call span — its LATEST such
 * span (spans arrive oldest-first, same convention as RunStream) decides the
 * outcome. Order = first appearance, so the cluster reads left-to-right the
 * same way the task unfolded (task-as-spine, same principle as RunStream).
 */
export function agentOrbs(spans: EngineSpan[]): AgentOrb[] {
  const order: string[] = []
  const latest = new Map<string, EngineSpan>()

  for (const s of spans) {
    const isModelCall = s.type === 'model_call' || s.name === 'model_call'
    if (!isModelCall) continue
    const a = s.attrs ?? {}
    const agent = typeof a.agent === 'string' ? a.agent : undefined
    if (!agent) continue
    if (!latest.has(agent)) order.push(agent)
    latest.set(agent, s) // later spans overwrite earlier ones — "latest wins"
  }

  return order.map((agent) => {
    const s = latest.get(agent)!
    const a = s.attrs ?? {}
    const provider = String(a.provider ?? '')
    const model = typeof a.model === 'string' ? a.model : ''
    // A span that never reached a model is NOT an answer, whatever its status.
    // An offline/unreachable provider closes its span `ok` with `is_real:false`
    // — so reading `status` alone lit three healthy monograms and counted "3
    // answered" on a run where the critic had never been reached, directly
    // beneath a column that correctly marked it unreachable. This is the exact
    // class of lie f2766c6 exists to kill, and it was surviving here.
    const unreachable = a.is_real === false
    const outcome: AgentOrb['outcome'] = unreachable
      ? 'failed'
      : s.status === 'error'
        ? 'failed'
        : s.status === 'ok'
          ? 'ok'
          : 'running'
    const color = modelColor(provider + (model ? ' · ' + model : ''))
    return { agent, model, provider, color, outcome }
  })
}
