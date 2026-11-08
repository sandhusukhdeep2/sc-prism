// A PROOF RUN (design 2026-11-08 §B): one real call on the agent's model and
// one real, harmless call per granted tool, run through the ordinary engine
// path (`runNativeTask` with agentName / stage 'proof' / agentCapabilities),
// then graded from the verdict and that run's own spans. "Proven" means every
// call was real; anything less is "unproven" with the engine's cause.
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'
import { toolEnding } from './agentDossier'

export const PROOF_BUDGET = 400
export const PROOF_TOOL_TURNS = 1
/** The one fixed, documented web lookup a proof may make. */
export const PROOF_WEB_URL = 'https://example.com/'

/** Capabilities a proof will exercise; the rest are never touched by a proof. */
const PROVABLE = ['vault', 'web', 'tools'] as const

export function proofIntent(name: string, role: string): string {
  return `Say hello in one sentence and name yourself: you are ${name}, ${role}.`
}

export function proofCapabilities(tools: readonly string[]): string {
  return PROVABLE.filter((c) => tools.includes(c)).join(',')
}

export interface ProofLine {
  kind: 'model' | 'tool'
  label: string
  ok: boolean
  detail: string
}

export interface ProofResult {
  proven: boolean
  at: number
  lines: ProofLine[]
  /** '' when proven, else the first failing line's detail. */
  reason: string
}

// The gateway's own markers for "this is not model output" — the same three
// prefixes projectRun.ts and the store check (kept local: no store import
// from a leaf module).
function isRealText(text: string | undefined): text is string {
  return !!text && !text.startsWith('[offline:') && !text.startsWith('[stub:') && !text.startsWith('[rejected:')
}

/** The reason behind a stand-in, for a human — the client twin of the engine's
 *  `gateway.stand_in_cause`: `[kind:provider:model] detail`. */
function standInCause(text: string): string {
  const t = text.trim()
  if (!t.startsWith('[')) return 'the provider returned no completion'
  const close = t.indexOf('] ')
  const head = (close >= 0 ? t.slice(1, close) : t.slice(1)).split(':')
  const kind = head[0] ?? ''
  const provider = head[1] || 'the provider'
  const detail = close >= 0 ? t.slice(close + 2).trim() : ''
  if (kind === 'rejected') {
    const rest = detail.replace(/^provider refused the request/, '').trim()
    return `${provider} refused the request${rest ? ' ' + rest : ''}`
  }
  if (!detail || detail.startsWith('handled:')) return `${provider} returned no completion`
  return detail
}

function firstSentence(text: string): string {
  const m = text.trim().match(/^[^.!?\n]{1,160}[.!?]?/)
  return (m ? m[0] : text.trim().slice(0, 160)).trim()
}

const TOOL_NAMES: Record<(typeof PROVABLE)[number], (tool: string) => boolean> = {
  vault: (t) => t === 'vault_list' || t === 'vault_read' || t === 'vault_search',
  web: (t) => t === 'web_fetch' || t === 'web_search',
  // Any MCP tool: the proof asks the granted servers to `list`, and the span
  // carries that server's tool name, whatever it is.
  tools: (t) => t !== '' && !/^(vault_|web_)/.test(t),
}

function attrStr(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : ''
}

export function gradeProof(
  verdict: Verdict | null,
  spans: readonly EngineSpan[],
  runId: string,
  tools: readonly string[],
  now: number,
): ProofResult {
  const lines: ProofLine[] = []
  if (!verdict) {
    return { proven: false, at: now, lines, reason: 'the engine did not finish' }
  }
  const response = verdict.response
  const real = isRealText(response)
  lines.push({
    kind: 'model',
    label: 'answered on its model',
    ok: real,
    detail: real ? firstSentence(response) : standInCause(response ?? ''),
  })
  const mine = spans.filter((s) => s.run_id === runId && (s.type === 'tool_exec' || s.name === 'tool_exec'))
  for (const cap of PROVABLE) {
    if (!tools.includes(cap)) continue
    const call = mine.find((s) => TOOL_NAMES[cap](attrStr(s.attrs, 'tool')))
    if (!call) {
      lines.push({ kind: 'tool', label: cap, ok: false, detail: `${cap} was not called` })
      continue
    }
    const ending = toolEnding(call.attrs)
    const ok = ending === 'ok' && call.status !== 'error'
    const target = attrStr(call.attrs, 'path') || attrStr(call.attrs, 'url') || attrStr(call.attrs, 'server')
    lines.push({
      kind: 'tool',
      label: cap,
      ok,
      detail: ok ? `${attrStr(call.attrs, 'tool')}${target ? ' ' + target : ''}` : `${cap}: ${ending === 'ok' ? 'failed' : ending}`,
    })
  }
  const failing = lines.find((l) => !l.ok)
  return { proven: !failing, at: now, lines, reason: failing ? failing.detail : '' }
}
