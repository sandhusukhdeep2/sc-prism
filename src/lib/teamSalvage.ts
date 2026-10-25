import type { EngineSpan } from './nativeEngine'

/**
 * What a stopped team run ACTUALLY got done, in one line, from its own spans.
 *
 * The five-minute wall is deliberate and stays. What was not deliberate is
 * that hitting it threw the work away in silence: a real run on 2026-08-31 had
 * three models answer and eight web lookups succeed — including the page that
 * held the answer — and the user was told only "try a smaller task".
 *
 * Every number here is counted from spans the engine already wrote, so the line
 * can never claim work that did not happen. Returns '' when there is genuinely
 * nothing to report, so the caller can append nothing rather than pad the
 * message with an empty boast.
 */
export function teamSalvageLine(spans: readonly EngineSpan[], runId: string): string {
  // The caller's run id is a CANCEL handle — src-tauri uses it to kill the
  // child, and it never reaches the engine, which mints its own `run_id` for
  // spans. So an id that matches nothing is the NORMAL case, not an error, and
  // filtering on it silently produced no line at all on every real run.
  // The app holds one engine slot at a time (TEAM_BUSY_TEXT refuses a second),
  // so the last run in the tail is the run that just stopped.
  const matches = runId ? spans.filter((s) => s.run_id === runId) : []
  const lastRun = [...spans].reverse().find((s) => s.run_id)?.run_id
  const mine =
    matches.length > 0
      ? matches
      : spans.filter((s) => !s.run_id || !lastRun || s.run_id === lastRun)

  const seats = new Map<string, string>()
  let ok = 0
  let failed = 0
  const hosts = new Set<string>()

  for (const s of mine) {
    const a = s.attrs ?? {}
    if (s.name === 'model_call') {
      const seat = typeof a.agent === 'string' ? a.agent.trim() : ''
      const model = typeof a.model === 'string' ? a.model.trim() : ''
      if (seat && !seats.has(seat)) seats.set(seat, model)
      continue
    }
    if (s.name !== 'tool_exec') continue
    const tool = typeof a.tool === 'string' ? a.tool : ''
    if (tool !== 'web_search' && tool !== 'web_fetch') continue
    if (a.is_error === true) {
      failed += 1
      continue
    }
    ok += 1
    const url = typeof a.url === 'string' ? a.url : ''
    if (url) {
      try {
        hosts.add(new URL(url).hostname.replace(/^www\./, ''))
      } catch {
        /* a malformed URL is simply not named — never guessed at */
      }
    }
  }

  // A local model id is often the whole quantisation recipe (54 chars on
  // Sukhdeep's own server). The line names WHICH model, it is not a manifest.
  const shortModel = (m: string): string => (m.length > 22 ? `${m.slice(0, 21)}…` : m)

  const parts: string[] = []
  if (seats.size > 0) {
    const named = [...seats.entries()]
      .map(([seat, model]) => (model ? `${seat} (${shortModel(model)})` : seat))
      .join(', ')
    parts.push(`${seats.size} seat${seats.size === 1 ? '' : 's'} answered — ${named}`)
  }
  if (ok > 0) {
    const reads = [...hosts].slice(0, 3).join(', ')
    parts.push(
      `${ok} web lookup${ok === 1 ? '' : 's'} succeeded${reads ? ` (read ${reads})` : ''}`,
    )
  }
  if (failed > 0) parts.push(`${failed} failed`)
  if (parts.length === 0) return ''

  return `Before we stopped it: ${parts.join(' · ')}. The full trail is in Console.`
}
