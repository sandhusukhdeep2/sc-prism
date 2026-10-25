// Shared "live engine console" plumbing — the span-tail narration pattern
// used first by Workspace's EngineConsole and reused verbatim by the Project
// run stage's narration strip (Task B5). Extracted so both read/format spans
// identically instead of drifting.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { isNative, readSpansTail, resolveVaultDir, type EngineSpan } from './nativeEngine'
import { FAIL_GLYPH, OK_GLYPH } from './glyphs'
import { formatBytes, webSpanDetail } from './webSpan'

// One formatted line of the live engine console.
export function spanLine(s: EngineSpan): string {
  const icon = s.status === 'ok' ? OK_GLYPH : s.status === 'error' ? FAIL_GLYPH : '·'
  const ms = s.duration_ms != null ? `${s.duration_ms >= 1000 ? (s.duration_ms / 1000).toFixed(1) + 's' : Math.round(s.duration_ms) + 'ms'}` : ''
  const a = s.attrs ?? {}
  if (s.type === 'model_call' || s.name === 'model_call') {
    const real = a.is_real ? 'REAL' : 'stub'
    return `${icon} model_call → ${a.provider ?? '?'} · ${a.model ?? '?'} · ${real} · ${a.tokens_in ?? 0}→${a.tokens_out ?? 0} tok · ${ms}`
  }
  if (s.name === 'route' || s.type === 'route') {
    return `${icon} route → ${a.route ?? a.target ?? '?'} (${a.reason ?? ''})`
  }
  // Governed tool call (v2b): MCP tools (provider==='mcp'), web-research tools
  // (provider==='web', web design 2026-07-23) and the engine's own VAULT tools
  // (provider==='vault', mission control 2026-08-05 — these were silently
  // dropped to the generic line, so the console never said the companion had
  // opened the user's notes at all). tier1/tier2 also use span_type tool_exec
  // but carry no provider — gate on provider so only real tool calls land here.
  // Web calls get an honest source label (🌐 fetch / 🔎 search) instead of the
  // MCP plug so the URL/source reads legibly; a vault call reads 📓 and NAMES
  // the note when the span carries one.
  //
  // WHAT the call actually did (2026-08-17): a web row now carries the real
  // destination + outcome — `🌐 web·web_fetch · docs.anthropic.com — 200, 48 KB`
  // / `🔎 web·web_search · "mlx multi token prediction" — 8 results` — and an
  // MCP row carries the SIZE of what came back. Both read the span's own attrs
  // via lib/webSpan; a span that carries none falls back to exactly the old
  // generic row. Web arguments are shown because they already egressed; vault
  // and MCP arguments are NEVER recorded and so can never appear here — THE
  // PRIVACY LINE, stated in full in engine/scprism_engine/webtools.py.
  // File writes + terminal commands (no-black-box, 2026-08-31): the two rows
  // the founder named — which file was added/updated, which command ran.
  if (s.type === 'tool_exec' && a.provider === 'files') {
    const action = a.action === 'updated' ? 'updated' : 'added'
    return `✍️ ${action} ${typeof a.path === 'string' ? a.path : '?'}`
  }
  if (s.type === 'tool_exec' && a.provider === 'terminal') {
    const cmd = typeof a.command === 'string' ? a.command : s.name
    const exit = typeof a.exit_code === 'number' ? ` · exit ${a.exit_code}` : ''
    return `${a.is_error ? FAIL_GLYPH : OK_GLYPH} $ ${cmd}${exit}${ms ? ' · ' + ms : ''}`
  }
  if (s.type === 'tool_exec' && (a.provider === 'mcp' || a.provider === 'web' || a.provider === 'vault')) {
    const web = a.provider === 'web'
    const vault = a.provider === 'vault'
    const server = typeof a.server === 'string' ? a.server : web ? 'web' : vault ? 'vault' : 'mcp'
    const tool = typeof a.tool === 'string' ? a.tool : s.name
    const glyph = web ? (tool === 'web_search' ? '🔎' : '🌐') : vault ? '📓' : '⛭'
    // Only when the span really carries a path — never a guessed filename.
    const path = vault && typeof a.path === 'string' && a.path ? ` · ${a.path}` : ''
    const id = `${glyph} ${server}·${tool}${path}`
    // Governance the user MUST see, each visually distinct (M2/M3):
    // a block is not an infra error, and a withhold is a WIN, not a failure.
    // A withheld web result still names WHERE it came from — the whole point of
    // the 🔒 line is "we fetched this and kept it off the cloud".
    const detail = web ? webSpanDetail(a, tool) : ''
    if (a.blocked) return `⛔ ${id} · blocked (governance: allow-list / sensitivity)`
    if (a.withheld)
      return `🔒 ${id}${detail ? ' · ' + detail : ''} · result withheld from cloud (sensitive)`
    // MCP gets the safe half only: how much came back, never the arguments.
    const mcpSize =
      !web && !vault && typeof a.bytes === 'number' && Number.isFinite(a.bytes)
        ? formatBytes(a.bytes)
        : ''
    const extra = detail || mcpSize
    // A tool that returned isError:true FAILED even though the span status may
    // read ok — read attrs.is_error, not just the span status (M-minor).
    const failed = a.is_error === true || s.status === 'error'
    return `${failed ? FAIL_GLYPH : OK_GLYPH} ${id}${extra ? ' · ' + extra : ''}${failed ? ' · failed' : ''}${ms ? ' · ' + ms : ''}`
  }
  if (s.name.startsWith('run:')) return `${icon} run finished · ${ms}`
  const extra =
    s.name === 'tier1' || s.name === 'tier2'
      ? a.passed === undefined
        ? ''
        : a.passed
          ? ' · passed'
          : ' · FAILED'
      : ''
  return `${icon} ${s.name}${extra}${ms ? ' · ' + ms : ''}`
}

export interface SpanTail {
  lines: string[]
  spans: EngineSpan[]
  seen: number
  boxRef: RefObject<HTMLDivElement>
}

/**
 * Tails the vault's span stream — the live "engine console" feed shared by
 * every narration surface. One fetch on mount; while `running`, polls every
 * 1200ms exactly like Workspace's original EngineConsole. `boxRef` is meant
 * for the scrolling container so the caller can auto-scroll to bottom.
 */
export function useSpanTail(vaultPath: string, running: boolean): SpanTail {
  const [lines, setLines] = useState<string[]>([])
  const [spans, setSpans] = useState<EngineSpan[]>([])
  const [seen, setSeen] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    const fetchTail = async () => {
      const vault = await resolveVaultDir(vaultPath)
      const tail = await readSpansTail(vault, 40)
      if (cancelled) return
      setLines(tail.map(spanLine))
      setSpans(tail)
      setSeen(tail.length)
    }
    void fetchTail()
    if (!running) return
    const t = setInterval(() => void fetchTail(), 1200)
    return () => {
      cancelled = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, vaultPath])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return { lines, spans, seen, boxRef }
}
