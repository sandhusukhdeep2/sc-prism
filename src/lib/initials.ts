/** Up to two initials from a person's name — the first letter of the first and
 *  last words. Empty for an empty name, so the caller can fall back to a neutral
 *  glyph rather than inventing someone. Uses code points, not UTF-16 units, so
 *  a name that starts outside the BMP is not split in half. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = [...words[0]][0]
  const last = words.length > 1 ? [...words[words.length - 1]][0] : ''
  return (first + last).toUpperCase()
}
