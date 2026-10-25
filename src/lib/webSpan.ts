// SC Prism — reading a WEB tool_exec span's disclosure attrs (2026-08-17).
//
// WHY THIS FILE EXISTS. The engine ran 66 real web calls for this user and every
// one of them rendered as the generic "fetching a page from the web…" — no URL,
// no query, no result — because the span carried no arguments and no outcome.
// From the user's seat that is indistinguishable from the feature not existing.
// `webtools.WebToolProvider.call_tool` now records what a web call actually did;
// this module is the ONE place the UI reads those attrs, so the run stream, the
// engine console and the plain-English narration cannot drift apart.
//
// THE PRIVACY LINE (stated in full in engine/scprism_engine/webtools.py, and
// this is the reader-facing half of it): a WEB argument is safe to record and
// show because it ALREADY LEFT THE MACHINE — the URL was requested over the
// wire, the query was sent to a search engine — so displaying it discloses
// nothing new. A LOCAL tool's arguments (a vault path, an MCP tool's params)
// have NOT egressed and may hold secrets, so they are never recorded and there
// is nothing here to render for them. Do not add a `vaultArgs`/`mcpArgs` reader
// to this file; that would be crossing the line from the UI side.
//
// Every reader below is DEFENSIVE in the honest direction: an attr the span did
// not really carry yields undefined / '' and the caller falls back to its
// generic phrase, never a guess.

/** A span's attrs bag, as the engine writes it. */
export type SpanAttrs = Record<string, unknown>

/** A string attr, or '' when absent/blank/not a string. Never invents. */
function str(a: SpanAttrs, key: string): string {
  const v = a[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** A finite non-negative number attr, or undefined. Never invents. */
function num(a: SpanAttrs, key: string): number | undefined {
  const v = a[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** The host of a URL, or '' when there is no usable URL to name. */
export function hostOfUrl(url: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(url.trim())
  if (!m) return ''
  // Strip any userinfo and port so the label is just the host.
  return m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '')
}

/**
 * WHERE a web call went. Prefers the engine's own `host` attr (it parsed the
 * final, post-redirect URL) and derives it from `url` otherwise. '' when the
 * span named neither — a call that never reached the network records neither,
 * and the UI must stay generic rather than guess a destination.
 */
export function webHost(a: SpanAttrs): string {
  return str(a, 'host') || hostOfUrl(str(a, 'url'))
}

/** The search query the span really carried, or ''. */
export function webQuery(a: SpanAttrs): string {
  return str(a, 'query')
}

/** The real HTTP status of a fetch, or undefined. */
export function webStatus(a: SpanAttrs): number | undefined {
  return num(a, 'status')
}

/** The real size of what came back, in bytes, or undefined. */
export function webBytes(a: SpanAttrs): number | undefined {
  return num(a, 'bytes')
}

/** How many hits a search really returned, or undefined (0 is a real answer). */
export function webResultCount(a: SpanAttrs): number | undefined {
  return num(a, 'result_count')
}

/** `48 KB` / `512 B` / `1.2 MB` — a size a person can read at a glance. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The console/timeline detail for one web tool_exec span — the part that turns
 * `🌐 web·web_fetch` into `🌐 web·web_fetch · docs.anthropic.com — 200, 48 KB`
 * and `🔎 web·web_search` into `🔎 web·web_search · "mlx multi token
 * prediction" — 8 results`.
 *
 * Returns '' when the span carried nothing real to say (a blocked call, which
 * deliberately records no argument, or an older span from before this landed),
 * so the caller's existing generic row is unchanged.
 */
export function webSpanDetail(a: SpanAttrs, tool: string): string {
  let left = ''
  const right: string[] = []
  if (tool === 'web_search') {
    const q = webQuery(a)
    if (q) left = `"${q}"`
    const n = webResultCount(a)
    if (n !== undefined) right.push(`${n} result${n === 1 ? '' : 's'}`)
  } else {
    left = webHost(a)
    const status = webStatus(a)
    if (status !== undefined) right.push(String(status))
    const bytes = webBytes(a)
    if (bytes !== undefined) right.push(formatBytes(bytes))
  }
  const tail = right.join(', ')
  if (left && tail) return `${left} — ${tail}`
  return left || tail
}
