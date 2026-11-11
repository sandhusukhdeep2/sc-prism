import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resultForDisplay } from './resultDisplay'

// A run that writes files answers with ===FILE: path=== … ===END=== blocks (the
// engine's write-back contract). The project drawer's "Last result" rendered
// that text as it came, so the marker sat in the middle of a sentence:
// "…the deliverable. ===FILE: hello.md=== Hello, crew…" (2026-11-11).
describe('resultForDisplay — a file block reads as a named file', () => {
  it('names the file on its own line and drops the end marker', () => {
    expect(resultForDisplay('Done.\n===FILE: hello.md===\n# Hello, crew\n===END===\nBye')).toBe(
      'Done.\n\n**hello.md**\n\n# Hello, crew\n\nBye',
    )
  })

  it('keeps a path with folders as written', () => {
    expect(resultForDisplay('===FILE: docs/COPY.md===\ntext\n===END===')).toBe('**docs/COPY.md**\n\ntext')
  })

  it('leaves text without file blocks exactly as it was', () => {
    const plain = 'A result.\n\nWith two paragraphs and a *star*.'
    expect(resultForDisplay(plain)).toBe(plain)
  })

  it('touches only whole marker lines, never a sentence that mentions one', () => {
    const s = 'The reply had no ===FILE:=== blocks, so nothing was written.'
    expect(resultForDisplay(s)).toBe(s)
  })

  it('is what the project drawer renders', () => {
    expect(readFileSync('src/pages/Projects.tsx', 'utf8')).toMatch(/renderChatMarkdown\(resultForDisplay\(note\)\)/)
  })
})
