import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A SENTENCE IS NEVER MONO (clear-room spec §B), applied to the skill cards
// 2026-11-11. A card set its usage line and every chip in 9.5px monospace,
// "portable markdown — usable by any agent runtime" included. The skill's
// name and the agents it is granted to are ids and keep their monospace.
const css = readFileSync('src/pages/Skills.css', 'utf8')
const rule = (sel: string) =>
  css.match(new RegExp('(^|\\n)' + sel.replace(/[.]/g, '\\.') + ' \\{[^}]*\\}'))?.[0] ?? ''

describe('skill cards set their words as text', () => {
  for (const sel of ['.skill-card__stats', '.prov', '.portable', '.chip-warn', '.role-chip']) {
    it(`${sel} is not monospace and is large enough to read`, () => {
      const r = rule(sel)
      expect(r, sel).not.toBe('')
      expect(r, sel).not.toMatch(/font-family: var\(--font-mono\)/)
      const size = Number(r.match(/font-size: ([\d.]+)px/)?.[1] ?? 0)
      expect(size, sel).toBeGreaterThanOrEqual(10.5)
    })
  }
  it('ids keep their monospace', () => {
    expect(rule('.skill-card__name')).toMatch(/font-family: var\(--font-mono\)/)
    expect(rule('.skill-card__foot')).toMatch(/font-family: var\(--font-mono\)/)
  })
})
