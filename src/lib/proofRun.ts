// A PROOF RUN (design 2026-11-08 §B): one real call on the agent's model and
// one real, harmless call per granted tool, run through the ordinary engine
// path and graded from the verdict and THAT RUN's own spans. "Proven" means
// every call was real and the model that answered was the agent's own brand;
// anything less is "unproven" with the engine's cause.
//
// Reviewed 2026-11-08: the engine stamps spans with its own run id (the
// client's id is only a cancel handle), so a run's spans are found through its
// root span's task_id; MCP tools are not reachable on a solo run, so a proof
// exercises vault and web only; the engine runs a tool only when a reply is
// nothing but the call, so the prompt asks for the calls first.
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'
import { toolEnding } from './agentDossier'
import { spansForTask } from './delegation'

/** Output cap for the proof's model turns (`providers.maxTokens`). A TOTAL
 *  token budget would starve the tool loop: the companion prompt alone is a
 *  few hundred tokens. */
export const PROOF_MAX_TOKENS = 400
/** The one fixed, documented web lookup a proof may make. */
export const PROOF_WEB_URL = 'https://example.com/'

/** Capabilities a proof exercises. `tools` (MCP) is not reachable from a solo
 *  run; terminal, computer and writes are never exercised by a proof. */
const PROVABLE = ['vault', 'web'] as const
type Provable = (typeof PROVABLE)[number]

export type ProofBrand = 'local' | 'claude' | 'gemini'

export function proofCapabilities(tools: readonly string[]): string {
  return PROVABLE.filter((c) => tools.includes(c)).join(',')
}

/** One tool turn per provable grant, never fewer than one. */
export function proofToolTurns(tools: readonly string[]): number {
  return Math.max(1, PROVABLE.filter((c) => tools.includes(c)).length)
}

/** The fixed proof prompt: the tool calls FIRST, each as one harmless
 *  read-only thing, then the greeting. */
export function proofIntent(name: string, role: string, tools: readonly string[] = []): string {
  const asks: string[] = []
  if (tools.includes('vault')) asks.push('First, call your vault tool to list the top-level folders of the vault.')
  if (tools.includes('web')) asks.push(`${asks.length ? 'Then' : 'First,'} fetch ${PROOF_WEB_URL} with your web tool and quote its title.`)
  const greeting = asks.length
    ? `Finally, in one sentence, say hello and name yourself: you are ${name}, ${role}.`
    : `Say hello in one sentence and name yourself: you are ${name}, ${role}.`
  return [...asks, greeting].join(' ')
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

/** Did the brand that answered match the agent's? `models_used` entries read
 *  `provider · model`; a brand's CLI (`claude-cli`) counts as the brand. An
 *  absent list is not evidence either way and is not guessed at. */
function answeredOnBrand(modelsUsed: readonly string[] | undefined, brand: ProofBrand): boolean {
  if (!modelsUsed || modelsUsed.length === 0) return true
  return modelsUsed.some((m) => {
    const provider = m.split('·')[0].trim().toLowerCase()
    return provider === brand || provider.startsWith(`${brand}-`)
  })
}

const TOOL_NAMES: Record<Provable, (tool: string) => boolean> = {
  vault: (t) => t === 'vault_list' || t === 'vault_read' || t === 'vault_search',
  web: (t) => t === 'web_fetch' || t === 'web_search',
}

function attrStr(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : ''
}

export function gradeProof(
  verdict: Verdict | null,
  spans: readonly EngineSpan[],
  tools: readonly string[],
  brand: ProofBrand,
  now: number,
): ProofResult {
  const lines: ProofLine[] = []
  if (!verdict) {
    return { proven: false, at: now, lines, reason: 'the engine did not finish' }
  }
  const response = verdict.response
  const real = isRealText(response)
  // `models_used` is what the native engine reported (`provider · model`); the sim leaves `native` undefined.
  const modelsUsed = verdict.native?.models_used
  const onBrand = answeredOnBrand(modelsUsed, brand)
  lines.push({
    kind: 'model',
    label: 'answered on its model',
    ok: real && onBrand,
    detail: !real
      ? standInCause(response ?? '')
      : !onBrand
        ? `answered on ${(modelsUsed ?? []).join(', ')} — not on ${brand}`
        : firstSentence(response),
  })
  // THIS run's tool calls: the run's root span is found by task_id, and its
  // tool_exec spans hang under it. A client-side run id never reaches the engine.
  const mine = spansForTask(spans, verdict.taskId).filter((s) => s.type === 'tool_exec' || s.name === 'tool_exec')
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
    // The span's own cause first (`error` from the tool, `reason` from a gate),
    // then the ending — never a bare "failed" when the engine said more.
    const cause = attrStr(call.attrs, 'error') || attrStr(call.attrs, 'reason') || (ending === 'ok' ? 'failed' : ending)
    lines.push({
      kind: 'tool',
      label: cap,
      ok,
      detail: ok ? `${attrStr(call.attrs, 'tool')}${target ? ' ' + target : ''}` : `${cap}: ${cause}`,
    })
  }
  const failing = lines.find((l) => !l.ok)
  return { proven: !failing, at: now, lines, reason: failing ? failing.detail : '' }
}
