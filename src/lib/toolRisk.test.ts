import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ACTING,
  FIRST_PARTY_READ_ONLY,
  READ_ONLY,
  READ_ONLY_GRANT,
  classifyTool,
  readOnlyToolNames,
  readsDecidedExplicitly,
  readsRunFree,
  withReadsFree,
} from './toolRisk'

// ---------------------------------------------------------------------------
// PARITY — the engine is the source of truth; this file is a mirror.
//
// The worst failure mode this codebase has is showing the user a capability
// that is not the one enforced. The app's table and the engine's table are two
// copies of the same claim, so they are pinned together HERE, by reading the
// Python off disk: drift fails the build instead of silently granting (or
// silently holding) something the other half disagrees with.
// ---------------------------------------------------------------------------

// Relative to the repo root (vitest's cwd) — the real file the engine imports,
// not a copy of it.
const PY = readFileSync('engine/scprism_engine/toolrisk.py', 'utf8')

/** The `provider: frozenset({...})` entries of the Python allowlist. */
function pythonAllowlist(): Record<string, string[]> {
  // Anchor on the ASSIGNMENT, not the first mention (the module docstring names
  // the table too), then read to the closing brace of the literal.
  const start = PY.indexOf('FIRST_PARTY_READ_ONLY: Dict')
  expect(start).toBeGreaterThan(-1)
  const body = PY.slice(start)
  const table = body.slice(0, body.indexOf('\n}'))
  const out: Record<string, string[]> = {}
  const entry = /"([a-z_]+)":\s*frozenset\(\{([^}]*)\}\)/g
  let m: RegExpExecArray | null
  while ((m = entry.exec(table)) !== null) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((t) => t[1]).sort()
  }
  return out
}

describe('parity with engine/scprism_engine/toolrisk.py (the enforcing table)', () => {
  it('the allowlist parsed out of the Python is exactly the one this module ships', () => {
    const py = pythonAllowlist()
    expect(Object.keys(py).sort()).toEqual(Object.keys(FIRST_PARTY_READ_ONLY).sort())
    for (const [provider, tools] of Object.entries(py)) {
      expect([...FIRST_PARTY_READ_ONLY[provider]].sort()).toEqual(tools)
    }
    // sanity: the parse found something, so a rename cannot silently pass
    expect(Object.keys(py).length).toBeGreaterThan(0)
    expect(py.vault).toContain('vault_read')
  })

  it('the class-grant sentinel is spelled the same on both sides', () => {
    expect(PY).toContain(`READ_ONLY_GRANT = "${READ_ONLY_GRANT}"`)
    expect(PY).toContain(`READ_ONLY = "${READ_ONLY}"`)
    expect(PY).toContain(`ACTING = "${ACTING}"`)
  })
})

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

describe('classifyTool — read-only means PROVEN read-only', () => {
  it('classifies the six reads he was prompted for, by provider + name', () => {
    for (const tool of ['vault_read', 'vault_list', 'vault_search', 'project_status']) {
      expect(classifyTool('vault', tool)).toBe(READ_ONLY)
    }
    for (const tool of ['web_fetch', 'web_search']) {
      expect(classifyTool('web', tool)).toBe(READ_ONLY)
    }
  })

  it('defaults an UNKNOWN mcp tool to acting — a name is not evidence', () => {
    for (const tool of ['notion.create_page', 'notion.search', 'read_file', 'send_email']) {
      expect(classifyTool('mcp', tool)).toBe(ACTING)
    }
  })

  it('refuses to be spoofed: our tool NAME on a third-party provider is acting', () => {
    expect(classifyTool('mcp', 'vault_read')).toBe(ACTING)
    expect(classifyTool('mcp', 'web_fetch')).toBe(ACTING)
  })

  it('treats a missing/unknown provider and any junk input as acting', () => {
    expect(classifyTool(undefined, 'vault_read')).toBe(ACTING)
    expect(classifyTool('', 'vault_read')).toBe(ACTING)
    expect(classifyTool('Vault', 'vault_read')).toBe(ACTING)
    expect(classifyTool('vault', undefined)).toBe(ACTING)
    expect(classifyTool('plugin', 'anything')).toBe(ACTING)
  })

  it('holds a new tool on a first-party source until it is listed', () => {
    expect(classifyTool('vault', 'vault_write')).toBe(ACTING)
    expect(classifyTool('web', 'web_post')).toBe(ACTING)
  })
})

// ---------------------------------------------------------------------------
// The grant transform — one function, so free and tighten are exact inverses
// ---------------------------------------------------------------------------

describe('withReadsFree / readsRunFree', () => {
  it('adds the class grant, preserving every existing name in order', () => {
    expect(withReadsFree({ require: ['all'], granted: ['web_search', 'vault'] }, true)).toEqual({
      require: ['all'],
      granted: ['web_search', 'vault', READ_ONLY_GRANT],
    })
  })

  it('is idempotent both ways (same object back when nothing changes)', () => {
    const free = { require: ['all'], granted: ['vault', READ_ONLY_GRANT] }
    const held = { require: ['all'], granted: ['vault'] }
    expect(withReadsFree(free, true)).toBe(free)
    expect(withReadsFree(held, false)).toBe(held)
  })

  it('tightening marks `require` so the choice STICKS across launches', () => {
    const tight = withReadsFree({ require: ['all'], granted: ['vault', READ_ONLY_GRANT] }, false)
    expect(tight).toEqual({ require: ['all', READ_ONLY_GRANT], granted: ['vault'] })
    expect(readsRunFree(tight)).toBe(false)
    expect(readsDecidedExplicitly(tight)).toBe(true)
  })

  it('require BEATS granted — a leftover grant cannot un-tighten the user', () => {
    expect(readsRunFree({ require: ['all', READ_ONLY_GRANT], granted: [READ_ONLY_GRANT] })).toBe(false)
  })

  it('round-trips: free → tighten → free lands back on the freed policy', () => {
    const start = { require: ['all'], granted: ['vault', 'echo·add'] }
    const free = withReadsFree(start, true)
    expect(readsRunFree(free)).toBe(true)
    const tight = withReadsFree(free, false)
    expect(readsRunFree(tight)).toBe(false)
    // Freeing again returns to exactly the freed policy — the require-side mark
    // is cleared, not left behind to silently override the grant later.
    expect(withReadsFree(tight, true)).toEqual(free)
    expect(withReadsFree(tight, true).require).toEqual(['all'])
  })

  it('readsDecidedExplicitly is false only when the user has said nothing', () => {
    expect(readsDecidedExplicitly({ require: ['all'], granted: ['vault'] })).toBe(false)
    expect(readsDecidedExplicitly({ require: ['all'], granted: [READ_ONLY_GRANT] })).toBe(true)
    expect(readsDecidedExplicitly({ require: [READ_ONLY_GRANT], granted: [] })).toBe(true)
  })

  it('readOnlyToolNames lists exactly what Settings may claim runs freely', () => {
    expect(readOnlyToolNames().sort()).toEqual(
      Object.values(FIRST_PARTY_READ_ONLY).flatMap((n) => [...n]).sort(),
    )
    expect(readOnlyToolNames()).not.toContain('read_file')
  })
})
