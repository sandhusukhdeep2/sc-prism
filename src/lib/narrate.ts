// SC Prism — Manager narration (the "hear it" depth of the Manager View).
// The Manager is a FACE, never a controller (ADR-007): these functions only
// READ real span data and render plain English. FACTUAL fields (agent, model,
// provider, route, reason) are INTERPOLATED from the span attrs — never
// free-generated — so the narration cannot say anything the engine didn't do.
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'
import { contradictionLine, isAttention } from './verdictOutcome'
import {
  formatBytes,
  webBytes,
  webHost,
  webQuery,
  webResultCount,
  webStatus,
} from './webSpan'

function isModelCall(s: EngineSpan): boolean {
  return s.type === 'model_call' || s.name === 'model_call'
}

// The governed tool sources whose activity this status line counts. `vault`
// (mission control, 2026-08-05) was silently dropped — so a run that read the
// user's notes, and even a run whose vault result was WITHHELD from the cloud,
// narrated exactly like a run that touched nothing. tier1/tier2 spans are
// span_type tool_exec too but carry no provider, so gating on the set also
// excludes them.
// `web` (2026-08-17) was dropped the same way `vault` had been: a run that made
// 44 fetches and 22 searches narrated exactly like a run that touched nothing.
const TOOL_PROVIDERS = new Set(['mcp', 'vault', 'web'])

/**
 * An honest one-phrase summary of governed tool activity + governance from the
 * run's spans (M4). Counts REAL `tool_exec` spans: notes the companion opened,
 * other tools used, calls a gate blocked, and results the egress gate withheld
 * from a cloud model — so a tool-using / tool-blocked run no longer reads
 * identically to a plain run. Vault reads are counted SEPARATELY because "he
 * read 3 of your notes" is a different fact from "he used 3 tools", and it is
 * the fact this product's promise is about. Empty string when there was no tool
 * activity (never fabricated).
 */
function toolPhrase(spans: EngineSpan[]): string {
  let used = 0
  let read = 0
  let looked = 0
  let blocked = 0
  let withheld = 0
  for (const s of spans) {
    if (s.type !== 'tool_exec') continue
    const a = s.attrs ?? {}
    if (typeof a.provider !== 'string' || !TOOL_PROVIDERS.has(a.provider)) continue
    if (a.blocked === true) blocked++
    else if (a.withheld === true) withheld++
    else if (a.provider === 'vault') read++
    else if (a.provider === 'web') looked++
    else used++
  }
  const parts: string[] = []
  if (read) parts.push(`📓 read ${read} vault ${read === 1 ? 'note' : 'notes'}`)
  // Counted SEPARATELY from `used`, because "he went out to the internet 6
  // times" is the fact the user said he never saw — folding it into a generic
  // tool count is how it stayed invisible.
  if (looked) parts.push(`🌐 ${looked} web ${looked === 1 ? 'lookup' : 'lookups'}`)
  if (used) parts.push(`⛭ used ${used} tool${used === 1 ? '' : 's'}`)
  if (blocked) parts.push(`⛔ blocked ${blocked} (governance)`)
  if (withheld) parts.push(`🔒 withheld ${withheld} result${withheld === 1 ? '' : 's'} from cloud`)
  return parts.join(' · ')
}

/**
 * The Manager's plain-English summary of ONE completed build step, spoken into
 * the project chat. Every FACT is interpolated from the Verdict's real fields
 * (models used, local routing, pass/fail, eval) — never free-generated, so the
 * Manager (a face, never a controller — ADR-007) can't claim anything the
 * engine didn't do.
 */
export function narrateRun(v: Verdict): string {
  const models =
    v.native?.models_used && v.native.models_used.length > 0
      ? v.native.models_used.join(' · ')
      : v.route?.routeLabel || v.modelRoute || 'your model'
  const usedLocal =
    v.route?.target === 'local' ||
    (v.native?.models_used ?? []).some((m) => m.toLowerCase().startsWith('local'))
  const localNote = usedLocal ? ' 🔒 The private work stayed on the local model.' : ''
  // M4: a real governance signal — blocked writes/tools (the engine's own
  // count) — so a tool-blocked step no longer reads identically to a plain one.
  const blocks = v.native?.blocks ?? 0
  const govNote =
    blocks > 0 ? ` 🛡 Governance blocked ${blocks} action${blocks === 1 ? '' : 's'} before it ran.` : ''
  if (v.passed) {
    const evalNote =
      typeof v.tier2?.evalScore === 'number' ? ` (eval ${v.tier2.evalScore.toFixed(2)})` : ''
    return `Ran your team on this step — ${models}.${localNote}${govNote} Verified: Tier-1 tests and the Tier-2 review passed${evalNote}.`
  }
  // ATTENTION — the engine's third outcome. Saying "it did not pass
  // verification" over a run whose Tier-1 checks genuinely ran and passed is
  // the exact false report this change exists to stop; it names WHICH tier
  // objected instead. The step still stops (the checkpoint gates on `passed`).
  if (isAttention(v)) {
    const evalNote =
      typeof v.tier2?.evalScore === 'number' ? ` at ${v.tier2.evalScore.toFixed(2)}` : ''
    const contradiction = contradictionLine(v)
    const judgeNote = contradiction ? ` ⚠ And ${contradiction}.` : ''
    return `Ran your team on this step — ${models}.${localNote}${govNote} Tier-1 tests ran over the files it wrote and PASSED, but the Tier-2 reviewer dissented${evalNote} — so this needs a look, not a redo. I stopped short of checkpointing it.${judgeNote}`
  }
  return `Ran your team on this step — ${models}.${localNote}${govNote} It did not pass verification, so I stopped here rather than write unverified work.`
}

/**
 * A calm one-line status for the top of the engine console — e.g.
 * `🔒 private lookup on local · research → gemini · reasoning → claude`.
 * One phrase per agent (its first turn), in span order (task-as-spine).
 * The lock marks any turn that stayed on the local model, so "keys stayed on
 * local" is visible at a glance. Empty string when there are no model_call
 * spans (nothing to narrate — never a fabricated status).
 */
export function narrateStatus(spans: EngineSpan[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const s of spans) {
    if (!isModelCall(s)) continue
    const a = s.attrs ?? {}
    const agent = String(a.agent ?? '').trim()
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    const provider = String(a.provider ?? '?').trim() || '?'
    const local = a.is_local === true || a.route === 'local'
    const reason = String(a.reason ?? '').trim()
    const what = reason || agent // the reason ("private lookup") else the role name
    parts.push(local ? `🔒 ${what} on local` : `${what} → ${provider}`)
  }
  // M4: append the tool/governance phrase so a tool-using or tool-blocked run
  // reads differently from a plain one. Only when there was model activity to
  // narrate (keeps the "nothing to narrate -> empty string" contract).
  if (parts.length > 0) {
    const tp = toolPhrase(spans)
    if (tp) parts.push(tp)
  }
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Plain-English narration (Mission Control Part 2, 2026-08-05 spec)
//
// ONE real span -> ONE sentence, so the chat column can say what is happening
// without the user reading a trace. The binding rules, in force everywhere
// below:
//
//   1. Every line maps 1:1 to a span the engine actually emitted. Nothing is
//      invented, inferred or padded.
//   2. Names, models, agents, tools, hosts come from `span.attrs` ONLY. A
//      missing attr yields a GENERIC honest phrase ("your AI", "a connected
//      tool") — never a guessed model or agent name.
//   3. An unrecognised span kind gets an honest generic line naming the raw
//      engine step, rather than a guess about what that step does.
// ---------------------------------------------------------------------------

/** A string attr, or '' when absent/blank/not a string. Never invents. */
function attr(s: EngineSpan, key: string): string {
  const v = (s.attrs ?? {})[key]
  return typeof v === 'string' ? v.trim() : ''
}

// The host-of-a-URL reader used to live here; it now lives in ./webSpan
// (`hostOfUrl`) so the console, the run stream and this narration all read a web
// span's disclosure attrs through ONE module and cannot drift apart.

/** Is this span still open (neither ok nor error)? Drives tense. */
function inFlight(s: EngineSpan): boolean {
  return s.status !== 'ok' && s.status !== 'error'
}

/** `provider · model`, or just whichever one the span carries, or ''. */
function modelPhrase(s: EngineSpan): string {
  const model = attr(s, 'model')
  const provider = attr(s, 'provider')
  if (model && provider) return `${provider} · ${model}`
  return model || provider
}

/**
 * Did the gateway STUB this model turn? The engine opens a model_call with
 * provider/model BEFORE the call and sets `is_real` when it closes, so a closed
 * span with `is_real === false` means nothing was actually sent (missing key,
 * unreachable host, unsigned-in CLI) and no reply came back. Narrating that as
 * "your AI replied on claude · claude-sonnet-4-5" is exactly the fabrication
 * this module exists to prevent — engineConsole.spanLine prints REAL/stub off
 * the same attr, and the chat says "unreachable — nothing was sent".
 * An OPEN span has no `is_real` yet, so this is false while a call is genuinely
 * in flight.
 */
function stubbed(s: EngineSpan): boolean {
  return (s.attrs ?? {}).is_real === false
}

/** The model_call / eval family — a real model turn. */
function narrateModelCall(s: EngineSpan): string {
  const agent = attr(s, 'agent')
  const who = agent || 'your AI' // no agent attr → generic, never a made-up role
  const on = modelPhrase(s)
  const local = (s.attrs ?? {}).is_local === true || attr(s, 'route') === 'local'
  // "on <model>" only when the span really named one; 🔒 only when it really
  // said the turn stayed local.
  const where = on ? ` on ${local ? '🔒 ' : ''}${on}` : local ? ' on 🔒 your local model' : ''
  // A stub is the headline: no reply happened, whatever else the span carries.
  if (stubbed(s)) return on ? `couldn't reach ${on} — nothing was sent` : "couldn't reach your AI — nothing was sent"
  if (s.status === 'error') return `${who} hit an error${where}`
  if (inFlight(s)) return `${who} is thinking${where}…`
  return `${who} replied${where}`
}

/** A governed tool call (web / vault / MCP), including its governance outcome. */
function narrateTool(s: EngineSpan): string {
  const a = s.attrs ?? {}
  const provider = attr(s, 'provider')
  const tool = attr(s, 'tool')
  const server = attr(s, 'server')
  const id = tool ? (server && server !== provider ? `${server}·${tool}` : tool) : ''
  // Governance first — a hold / block / withhold is the headline, not a detail.
  //
  // The OUTCOME before the pause: the blocking approval broker emits TWO
  // held=true spans (engine approval.py) — the pause itself, then the outcome
  // carrying `resolved`. Reading only `held` made an already-approved (or
  // declined, or timed-out) tool keep saying "waiting for your OK", a hold the
  // user had in fact already answered.
  const resolved = attr(s, 'resolved')
  if (resolved) {
    const what = id || 'that tool'
    if (resolved === 'allow') return `you approved ${what}`
    if (resolved === 'deny') return `you declined ${what}`
    if (resolved === 'timeout') return `${what} timed out waiting for your OK`
    // An outcome word this app doesn't know: say the pause ended, claim nothing
    // about which way it went.
    return `${what} — your approval was answered`
  }
  if (a.held === true) return id ? `waiting for your OK to use ${id}` : 'waiting for your OK on a tool'
  if (a.blocked === true) {
    return id ? `blocked ${id} — your rules said no` : 'blocked a tool call — your rules said no'
  }
  if (a.withheld === true) {
    // Say WHICH kind of thing was kept back: a vault withhold is the promise
    // being kept ("your notes stayed here"), not a generic redaction.
    return provider === 'vault'
      ? 'kept your vault content off the cloud'
      : 'kept a tool result off the cloud (sensitive)'
  }
  const failed = a.is_error === true || s.status === 'error'
  if (provider === 'web') {
    // LIVE as of 2026-08-17. These branches were dead code: the engine recorded
    // no url/host/query, so all 66 of this user's real web calls fell through to
    // "fetching a page from the web…" — from his seat, indistinguishable from
    // the feature not existing. `webtools.py` now records WHERE the call went
    // and WHAT came back. Saying it out loud is safe for the same reason
    // recording it is: a web argument ALREADY LEFT THE MACHINE (the URL was
    // requested; the query was sent to a search engine). A vault or MCP
    // argument has NOT egressed, is never recorded, and so has no counterpart
    // branch here — THE PRIVACY LINE, stated in full in
    // engine/scprism_engine/webtools.py.
    //
    // Still attr-gated in the honest direction: a span carrying no host/query
    // (a blocked call records neither, deliberately) gets exactly the old
    // generic phrase rather than a guessed destination.
    const host = webHost(a)
    if (tool === 'web_search') {
      const q = webQuery(a)
      const n = webResultCount(a)
      // The hit count answers "did it find anything?" — 0 is a real answer and
      // is spoken, not hidden.
      const hits = n === undefined ? '' : ` — ${n} result${n === 1 ? '' : 's'}`
      if (failed) return q ? `couldn't search the web for “${q}”` : "couldn't search the web"
      if (inFlight(s)) return q ? `searching the web for “${q}”…` : 'searching the web…'
      return q ? `searched the web for “${q}”${hits}` : `searched the web${hits}`
    }
    const status = webStatus(a)
    const bytes = webBytes(a)
    if (failed) {
      // A real HTTP status is the difference between "that page is gone" and
      // "something went wrong" — said only when the span really knows it.
      const why = status === undefined ? '' : ` (${status})`
      return host ? `couldn't fetch ${host}${why}` : `couldn't fetch that page${why}`
    }
    if (inFlight(s)) return host ? `fetching ${host}…` : 'fetching a page from the web…'
    const size = bytes === undefined ? '' : ` — ${formatBytes(bytes)}`
    return host ? `fetched ${host}${size}` : `fetched a page from the web${size}`
  }
  if (provider === 'vault') {
    // Explicit present/past pairs — no clever stemming (that turns "reading"
    // into "readed"). A read NAMES the note when the span carries its path (a
    // real fact from the result, never a guess) — "reading your vault" is a
    // weaker disclosure than "reading notes/health.md".
    // The DEFAULT is deliberately "using", not "reading": an unrecognised vault
    // tool (a future vault_write, say) is not proof of a read, and claiming the
    // gentler verb for a write would be a fabrication in the safe direction.
    const note = attr(s, 'path')
    const [now, done] =
      tool === 'vault_list'
        ? ['listing your vault', 'listed your vault']
        : tool === 'vault_search'
          ? ['searching your vault', 'searched your vault']
          : tool === 'project_status'
            ? ['checking your project statuses', 'checked your project statuses']
            : tool === 'vault_read'
              ? note
                ? [`reading ${note}`, `read ${note}`]
                : ['reading your vault', 'read your vault']
              : note
                ? [`using ${note} in your vault`, `used ${note} in your vault`]
                : ['using your vault', 'used your vault']
    if (failed) return `${now} failed`
    return inFlight(s) ? `${now}…` : done
  }
  // MCP (or any other governed source that named itself).
  const label = id || 'a connected tool'
  if (failed) return `${label} failed`
  if (inFlight(s)) return `using ${label}…`
  return `used ${label}`
}

/**
 * ONE real span → ONE plain-English sentence. Never returns '' — an
 * unrecognised span still yields an honest generic line naming the raw engine
 * step, so a user can never see a narration that claims more than the engine
 * actually reported.
 */
export function narrateSpan(s: EngineSpan): string {
  const a = s.attrs ?? {}
  const name = (s.name ?? '').trim()

  // The root span, emitted when the whole run ends.
  if (name.startsWith('run:')) return 'the run finished'

  // Governed tool sources (web / vault / MCP) — tier1/tier2 are also
  // span_type tool_exec but carry no provider, so gate on provider exactly
  // like engineConsole.spanLine and RunStream do.
  if (s.type === 'tool_exec' && (a.provider === 'mcp' || a.provider === 'web' || a.provider === 'vault')) {
    return narrateTool(s)
  }

  // Tier-2's model-backed judge is a model_call span NAMED 'eval' — check the
  // name before the model_call family so grading never reads as "thinking".
  if (name === 'eval') {
    const on = modelPhrase(s)
    const where = on ? ` on ${on}` : ''
    // Same stub law as a model turn: a judge the gateway never reached graded
    // nothing, so it must not read as a grading that happened.
    if (stubbed(s)) return on ? `couldn't reach ${on} to grade the result` : "couldn't reach a model to grade the result"
    if (s.status === 'error') return `grading the result failed${where}`
    return inFlight(s) ? `grading the result${where}…` : `graded the result${where}`
  }

  if (s.type === 'model_call' || name === 'model_call') return narrateModelCall(s)

  if (name === 'tier1') {
    if (a.skipped === true) {
      // THREE different truths, and saying the wrong one is a lie: a user who
      // configured `npm test` did NOT leave the verify command unset — this run
      // simply had no codebase (chat, a manager report, a heartbeat wake) to
      // point it at. `skipped_commands` is non-empty in exactly that case. And
      // a bound NEW project whose workspace has no package.json yet (early
      // steps run before the step that writes it) has a project — "no project
      // bound" would be false — so the engine's own reason tells them apart.
      const unrun = Array.isArray(a.skipped_commands) ? a.skipped_commands : []
      if (unrun.length > 0) {
        return String(a.skip_reason ?? '').includes('workspace has no project')
          ? 'nothing to verify yet — the workspace has no project manifest, so your checks were skipped'
          : 'nothing to verify — no project bound, so your checks were skipped'
      }
      return 'no verify command set — skipped your checks'
    }
    if (a.passed === true) return 'your checks passed'
    if (a.passed === false) return 'your checks failed'
    return 'running your verify command…'
  }

  if (name === 'tier2') {
    if (a.passed === true) return 'the review passed'
    if (a.passed === false) return 'the review failed'
    return 'reviewing the work…'
  }

  if (name === 'verdict') {
    if (a.passed === true) return 'done — passed'
    if (a.passed === false) return 'done — failed'
    return 'writing the verdict…'
  }

  if (name === 'plan') return inFlight(s) ? 'planning the steps…' : 'planned the steps'
  if (name === 'memory' || s.type === 'retrieval') {
    return inFlight(s) ? 'looking through what it remembers…' : 'looked through what it remembers'
  }
  if (name === 'dispatch') return inFlight(s) ? 'handing the task to the model…' : 'handed the task to the model'
  if (name === 'stop') return inFlight(s) ? 'checking it is really done…' : 'checked it is really done'
  if (name === 'training') return 'recorded what it learned'
  if (name === 'workflow') return inFlight(s) ? 'running a saved workflow…' : 'ran a saved workflow'
  if (name === 'project_writes') {
    if (a.ok === false) return 'writing your project files failed'
    return inFlight(s) ? 'writing your project files…' : 'wrote your project files'
  }
  // PAST TENSE below — deliberately, and this is not a style choice. Telemetry
  // appends a span to spans.jsonl only when it CLOSES, so every span a narration
  // surface can see is already finished. These four used to read as if they were
  // still happening ("routing this to local…"), which is the same fabrication in
  // miniature: a step presented as in-progress that had already completed.
  if (name === 'route') {
    const target = attr(s, 'route') || attr(s, 'target')
    return target ? `routed this to ${target}` : 'picked where to run this'
  }
  if (name.startsWith('gate:')) {
    const tool = name.slice(5).trim()
    return tool ? `checked permission for ${tool}` : 'checked permission for a tool'
  }
  if (name.startsWith('vault_write:')) {
    const path = name.slice('vault_write:'.length).trim()
    return path ? `saved ${path} to your vault` : 'saved a note to your vault'
  }

  // UNKNOWN span kind — an honest generic line. We name the raw engine step
  // (a real fact) and claim nothing about what it does.
  return name ? `working — engine step “${name}”` : 'working — an engine step with no name'
}

export interface NarrationLine {
  key: string
  text: string
}

/**
 * The narration stream for a set of REAL spans: one line per span, with
 * consecutive duplicates collapsed (five identical tool calls read as one
 * line, not five), keeping the newest `limit`. [] in → [] out: with no spans
 * there is nothing honest to say, so the caller shows its own waiting copy.
 */
export function narrationLines(spans: EngineSpan[], limit = 4): NarrationLine[] {
  const out: NarrationLine[] = []
  spans.forEach((s, i) => {
    const text = narrateSpan(s)
    const prev = out[out.length - 1]
    if (prev && prev.text === text) return
    out.push({ key: `${i}-${text}`, text })
  })
  return limit > 0 ? out.slice(-limit) : out
}
