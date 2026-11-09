import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Since the rail became five places (2026-11-08), Skills, Memory, Vault and
// Training are tabs of ONE Library page. The old routes still render, but a
// link that points at them lands the user on a bare page with no tabs and no
// place in the rail. Every in-app link opens the tab instead.
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsxFiles(p)
    return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : []
  })
}

describe('links open the Library tab, not the old standalone page', () => {
  it('no link in src targets /vault, /memory, /skills or /training directly', () => {
    const offenders: string[] = []
    for (const f of tsxFiles('src')) {
      if (f.endsWith('App.tsx') || f.endsWith('Library.tsx')) continue
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/to="\/(vault|memory|skills|training)"/g)) offenders.push(`${f}: ${m[0]}`)
    }
    expect(offenders).toEqual([])
  })
})
