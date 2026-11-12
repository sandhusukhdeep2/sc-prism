// EACH AI'S THINKING EFFORT IS ITS OWN (2026-11-12).
//
// Settings holds an effort level per provider. Only the primary's used to be
// forwarded, and the engine applied that one level to every provider in the
// run: a critic seat on Gemini was sent the level chosen for Claude, thought
// for up to two minutes over a seventy-token answer, and timed out — three
// times on the owner's machine, each stalling a whole team run.
//
// The engine is now given the full list (`SCPRISM_EFFORTS`), and a provider
// gets its own level or none at all.

/** The provider names the engine routes to. */
const ENGINE_PROVIDERS = new Set([
  'local',
  'claude',
  'openai',
  'gemini',
  'claude-cli',
  'gemini-cli',
  'codex-cli',
])

const LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * `provider=level` for every enabled provider, comma-joined — the value of the
 * engine's `SCPRISM_EFFORTS`. A provider with no level (or one that is not on
 * the ladder) is listed with an empty level, which the engine reads as "its
 * own default": being listed is what stops it inheriting another's.
 *
 * A custom OpenAI-compatible endpoint is the engine's `local` path, and only
 * stands in for it when it is the primary (that is the only time the bridge
 * substitutes it). The list is never empty — an empty value would read as an
 * older caller and bring the single run-wide level back.
 */
export function effortsArg(
  providers: readonly { id: string; effort?: string; enabled: boolean; primary?: boolean }[],
): string {
  const levels = new Map<string, string>()
  for (const p of providers) {
    if (!p.enabled) continue
    const known = ENGINE_PROVIDERS.has(p.id)
    if (!known && !p.primary) continue
    const name = known ? p.id : 'local'
    const level = (p.effort ?? '').trim().toLowerCase()
    // A custom primary speaks for `local` and outranks the real local entry.
    if (levels.has(name) && known && name === 'local') continue
    levels.set(name, LEVELS.has(level) ? level : '')
  }
  if (levels.size === 0) levels.set('local', '')
  return [...levels].map(([name, level]) => `${name}=${level}`).join(',')
}
