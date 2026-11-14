import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A SENTENCE IS NEVER MONO (clear-room spec 2026-11-09 §B), applied to the
// Memory page 2026-11-11. Monospace stays for paths and for token figures.
const src = readFileSync('src/pages/Memory.tsx', 'utf8')

const SENTENCES = ['okf__stats', 'okf__errnote', 'okf__clean', 'okf__reason', 'mem-budget__note', 'tier__desc']

describe('the Memory page sets its sentences as text', () => {
  for (const cls of SENTENCES) {
    it(`${cls} is not monospace`, () => {
      const withMono = new RegExp(`${cls}(?![\\w-])[^"'\`\\n]*\\bmono\\b|\\bmono\\b[^"'\`\\n]*${cls}(?![\\w-])`)
      expect(src).not.toMatch(withMono)
    })
  }
  it('says "nothing measured" as a sentence, apart from the token figures', () => {
    expect(src).toMatch(/className="mem-budget__note"/)
  })
  it('paths keep their monospace', () => {
    expect(src).toMatch(/okf__path mono/)
  })
})
