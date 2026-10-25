// A stable color per model/provider — the visual language shared by the run
// stream (RunStream) and, later, the orb view (Manager View "read it"
// depth). Pure + deterministic: same input always yields the same key/color,
// no I/O, no randomness. Keyed by provider, or a "provider · model" label —
// only the provider half decides the color so every span from the same
// provider reads as one color regardless of which model it called.

export interface ModelHue {
  key: string
  color: string
  label: string
}

// Known providers get a fixed, tasteful, theme-legible color (readable on
// both the dark console body and the light rail). Chosen to stay distinct
// from the app's status colors (--ok/--warn/--danger in theme/tokens.css) so
// a model chip never reads as a pass/fail signal.
//
// Visual system v2 (spec 2026-08-18) re-tuned these to the palette Sukhdeep
// approved, so a monogram, an orb, a run-stream chip and an attribution dot all
// name the same model in the same colour on every page:
//   claude = coral-red · local = the private-model green · gemini = violet.
// The colours are FILLS; text placed on one uses --v2-on-fill (near-black),
// which clears 4.5:1 on all four of them.
const KNOWN_HUES: Record<string, ModelHue> = {
  local: { key: 'local', color: '#6e9a83', label: 'local' }, // green — "your own machine" (--v2-local)
  gemini: { key: 'gemini', color: '#8a7fd6', label: 'gemini' }, // violet
  claude: { key: 'claude', color: '#ce6969', label: 'claude' }, // coral-red (--v2-coral)
  openai: { key: 'openai', color: '#2fb8a6', label: 'openai' }, // teal
}

/** Grey — an agent that is idle, or a provider that is not connected. It is a
 *  NON-claim: never used for a model that really answered. */
export const IDLE_HUE = '#c9cdd6'

// Suffixes that decorate a provider id without changing which provider it
// is (e.g. the CLI-backed providers this app routes through).
const STRIP_SUFFIXES = ['-cli', '-subscription']

function normalizeProvider(providerOrLabel: string): string {
  const raw = providerOrLabel.split(' · ')[0] ?? ''
  let p = raw.trim().toLowerCase()
  for (const suffix of STRIP_SUFFIXES) {
    if (p.endsWith(suffix)) p = p.slice(0, -suffix.length)
  }
  return p
}

/**
 * Normalize a provider id or a "provider · model" label down to a stable
 * key: one of the known providers ('local' | 'gemini' | 'claude' | 'openai')
 * when recognized, or the normalized provider string itself so unknown
 * providers still get a distinct, stable key instead of collapsing together.
 */
export function modelKey(providerOrLabel: string): string {
  const p = normalizeProvider(providerOrLabel)
  if (p in KNOWN_HUES) return p
  if (p.includes('claude') || p.includes('anthropic')) return 'claude'
  if (p.includes('gemini') || p.includes('google')) return 'gemini'
  if (p.includes('openai') || p.includes('gpt')) return 'openai'
  if (p.includes('local')) return 'local'
  return p || 'unknown'
}

// A small, fast string hash (djb2-style) so an unknown provider still gets a
// deterministic, stable hue — never fabricated-looking randomness, just a
// consistent function of the key.
function hashHue(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = (h * 33 + key.charCodeAt(i)) >>> 0
  }
  return h % 360
}

/** The hex/HSL color for a provider id or "provider · model" label. */
export function modelColor(providerOrLabel: string): string {
  const key = modelKey(providerOrLabel)
  const known = KNOWN_HUES[key]
  if (known) return known.color
  const hue = hashHue(key)
  return `hsl(${hue}, 55%, 55%)`
}

/** The full hue record (key/color/label) — used by callers that also want a display label. */
export function modelHue(providerOrLabel: string): ModelHue {
  const key = modelKey(providerOrLabel)
  const known = KNOWN_HUES[key]
  if (known) return known
  return { key, color: modelColor(providerOrLabel), label: key }
}
