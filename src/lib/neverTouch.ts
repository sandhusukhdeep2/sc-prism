/** Deterministic prose→glob mapping for the engine's --never-touch flag.
 *  For each trimmed non-empty entry E: T = E without leading '/'; emit T and `${T}/**`.
 *  Deduped, order-preserving. Engine matching is case-insensitive already. */
export function neverTouchGlobs(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const entry of entries) {
    const trimmed = entry.trim()
    // Skip empty entries
    if (trimmed.length === 0) continue

    // Strip leading '/' to get the canonical form
    const canonical = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed

    // Skip if we've already seen this canonical form
    if (seen.has(canonical)) continue

    seen.add(canonical)
    result.push(canonical)
    result.push(`${canonical}/**`)
  }

  return result
}
