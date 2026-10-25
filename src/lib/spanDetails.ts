// spanDetails — the honest IN/OUT body behind each action row (project-room
// spec, 2026-08-29; the bar is the founder's own Claude Code transcript:
// every action expands into what was asked and what came back).
//
// Every line derives from attrs the span REALLY carries — a missing attr
// yields no line, and a span with nothing to show expands to nothing. The
// privacy line is structural: the engine never records model prompts or
// vault/MCP arguments, so nothing here could show them; web arguments and
// tier-1 commands ARE recorded (already egressed / user-configured) and so
// may appear.
import type { EngineSpan } from './nativeEngine'

export interface SpanDetail {
  in: string[]
  out: string[]
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function spanDetails(sp: EngineSpan): SpanDetail {
  const a = (sp.attrs ?? {}) as Record<string, unknown>
  const IN: string[] = []
  const OUT: string[] = []

  if (sp.name === 'tier1' && sp.type === 'tool_exec') {
    const cmds = Array.isArray(a.commands) ? a.commands.filter((c): c is string => typeof c === 'string') : []
    if (cmds.length) IN.push(`$ ${cmds.join(' && ')}`)
    if (s(a.cwd)) IN.push(`cwd ${s(a.cwd)}`)
    if (a.skipped === true && s(a.skip_reason)) OUT.push(s(a.skip_reason))
    else if (a.passed === true) OUT.push('checks passed')
    else if (a.passed === false) {
      const failed = Array.isArray(a.failed_commands) ? a.failed_commands.length : 0
      OUT.push(failed ? `FAILED — ${failed} command${failed === 1 ? '' : 's'}` : 'FAILED')
    }
    return { in: IN, out: OUT }
  }

  if (sp.type === 'model_call') {
    if (s(a.reason)) IN.push(`route: ${s(a.reason)}`)
    if (s(a.round)) IN.push(`turn: ${s(a.round)}`)
    const tin = n(a.tokens_in)
    const tout = n(a.tokens_out)
    if (tin != null || tout != null) OUT.push(`tokens ${tin ?? 0} in → ${tout ?? 0} out`)
    if (s(a.cache)) OUT.push(`cache ${s(a.cache)}`)
    if (a.is_real === false) OUT.push('stub — no real completion')
    return { in: IN, out: OUT }
  }

  if (sp.type === 'retrieval') {
    if (s(a.query)) IN.push(`query: ${s(a.query)}`)
    const inj = n(a.injected)
    if (inj != null) OUT.push(`${inj} note${inj === 1 ? '' : 's'} injected${n(a.injected_tokens) != null ? ` · ${n(a.injected_tokens)} tok` : ''}`)
    return { in: IN, out: OUT }
  }

  if (sp.type === 'tool_exec' && a.provider === 'terminal') {
    if (s(a.command)) IN.push(`$ ${s(a.command)}`)
    if (s(a.cwd)) IN.push(`cwd ${s(a.cwd)}`)
    const exit = n(a.exit_code)
    if (exit != null) OUT.push(exit === 0 ? 'exit 0 — succeeded' : `exit ${exit} — FAILED`)
    return { in: IN, out: OUT }
  }

  if (sp.type === 'tool_exec' && a.provider === 'files') {
    if (s(a.path)) OUT.push(`${a.action === 'updated' ? 'updated' : 'added'} ${s(a.path)}`)
    return { in: IN, out: OUT }
  }

  if (sp.type === 'tool_exec') {
    // Governed tool call: web args are recorded (already egressed); vault
    // shows the note PATH only; MCP shows the tool name only.
    if (s(a.tool)) IN.push(`${s(a.server) || s(a.provider)}·${s(a.tool)}`)
    if (s(a.url)) IN.push(s(a.url))
    if (s(a.query)) IN.push(`"${s(a.query)}"`)
    if (s(a.path)) IN.push(s(a.path))
    const bytes = n(a.bytes)
    if (bytes != null) OUT.push(`${bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B'} back`)
    const results = n(a.results)
    if (results != null) OUT.push(`${results} results`)
    if (a.blocked === true) OUT.push('blocked by governance')
    if (a.withheld === true) OUT.push('result withheld from cloud (sensitive)')
    if (a.is_error === true) OUT.push('failed')
    return { in: IN, out: OUT }
  }

  if (sp.name === 'tier2') {
    const score = n(a.score)
    const thr = n(a.threshold)
    if (thr != null) IN.push(`threshold ${thr}`)
    if (score != null) OUT.push(`scored ${score}${a.passed === true ? ' — passed' : a.passed === false ? ' — below' : ''}`)
    return { in: IN, out: OUT }
  }

  if (sp.name === 'verdict') {
    if (s(a.outcome)) OUT.push(s(a.outcome))
    if (s(a.outcome_reason)) OUT.push(s(a.outcome_reason))
    return { in: IN, out: OUT }
  }

  return { in: IN, out: OUT }
}
