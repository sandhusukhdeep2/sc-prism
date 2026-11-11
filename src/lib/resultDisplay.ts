// A run's result, as the project drawer shows it.
//
// A run that writes files answers with the engine's write-back contract:
//
//     ===FILE: relative/path.ext===
//     …the file…
//     ===END===
//
// The drawer rendered that text as it came, so the marker landed in the middle
// of a sentence. For display, a marker line becomes the file's name on its own
// line and the end marker goes; the stored result is not changed. Only WHOLE
// marker lines are touched — a sentence that mentions the format stays as is.

const FILE_LINE = /^===FILE:\s*([^=\n]+?)\s*===$/
const END_LINE = /^===END===$/

export function resultForDisplay(note: string): string {
  if (!note.includes('===FILE:')) return note
  const out: string[] = []
  const blank = () => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  }
  for (const raw of note.split('\n')) {
    const line = raw.trim()
    const file = FILE_LINE.exec(line)
    if (file) {
      blank()
      out.push(`**${file[1]}**`, '')
      continue
    }
    if (END_LINE.test(line)) {
      blank()
      continue
    }
    out.push(raw)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
