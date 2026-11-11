import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A SENTENCE IS NEVER MONO (clear-room spec 2026-11-09 §B, applied to the whole
// Work page 2026-11-11). Hints, captions, empty states and the composer's own
// words were set in monospace, which made the page read like a terminal.
// Monospace stays for what it is for: paths, ids, commands and records.
const src = readFileSync('src/pages/Workspace.tsx', 'utf8')

const SENTENCES = [
  'ws__desksummary',
  'ws__navempty',
  'ws__lastcrew',
  'ws__statslink',
  'chat__empty',
  'msg__typing',
  'chat__imagenote',
  'chat__attacherror',
  'chat__metertext',
  'chat__confirmq',
  'chat__targethint',
  'chat__routing',
  'chat__whohint',
  'chat__override-btn',
  'chat__hint',
]

describe('the Work page sets its sentences as text', () => {
  for (const cls of SENTENCES) {
    it(`${cls} is not monospace`, () => {
      const withMono = new RegExp(`${cls}(?![\\w-])[^"'\`\\n]*\\bmono\\b|\\bmono\\b[^"'\`\\n]*${cls}(?![\\w-])`)
      expect(src).not.toMatch(withMono)
    })
  }
  it('records and ids keep their monospace', () => {
    expect(src).toMatch(/msg__seathead mono/)
    expect(src).toMatch(/msg__noticefile mono/)
  })
})
