import { describe, expect, it } from 'vitest'
import { spanLine } from './engineConsole'
import type { EngineSpan } from './nativeEngine'

// Web research (web design, 2026-07-23). The narration surfaces that call
// `spanLine` directly (Workspace's EngineConsole + the Project run strip) must
// render a provider='web' tool_exec span legibly — an honest source label, not
// a bare "tool_exec" — and each governance outcome distinctly (M2/M3). Mirrors
// the existing MCP tool_exec rendering, so a block reads as governance and a
// withhold as a WIN, never an infra error.
function webSpan(attrs: Record<string, unknown>): EngineSpan {
  return { name: 'tool_exec', type: 'tool_exec', status: 'ok', attrs }
}

describe('spanLine — web tool_exec rendering', () => {
  it('labels a web_fetch call with the 🌐 source glyph and web·web_fetch', () => {
    const line = spanLine(webSpan({ provider: 'web', server: 'web', tool: 'web_fetch' }))
    expect(line).toContain('🌐')
    expect(line).toContain('web·web_fetch')
    expect(line.startsWith('✓')).toBe(true)
  })

  it('labels a web_search call with the 🔎 search glyph', () => {
    const line = spanLine(webSpan({ provider: 'web', server: 'web', tool: 'web_search' }))
    expect(line).toContain('🔎')
    expect(line).toContain('web·web_search')
  })

  it('surfaces a blocked web call as governance (⛔), not an infra error', () => {
    const line = spanLine(
      webSpan({ provider: 'web', server: 'web', tool: 'web_search', blocked: true }),
    )
    expect(line).toContain('⛔')
    expect(line).toContain('blocked')
  })

  it('surfaces a withheld web result as a 🔒 governance win', () => {
    const line = spanLine(
      webSpan({ provider: 'web', server: 'web', tool: 'web_fetch', withheld: true }),
    )
    expect(line).toContain('🔒')
    expect(line).toContain('withheld')
  })

  it('marks a web call that returned isError:true as failed (honest, not a fake ✓)', () => {
    const line = spanLine(webSpan({ provider: 'web', server: 'web', tool: 'web_fetch', is_error: true }))
    expect(line).toContain('✕') // standardised fail mark (U+2715), P11
    expect(line).toContain('failed')
  })
})

// WHAT the web call actually did (2026-08-17). The user's complaint: 44 fetches
// and 22 searches, and not one address or query ever shown — every web call read
// as the same generic row, which from his seat is indistinguishable from the
// feature not existing. `webtools.py` now records the destination and the
// outcome; these are the exact lines he must now see.
describe('spanLine — web disclosure (host / status / size / query / hits)', () => {
  it('reads a web_fetch as 🌐 web·web_fetch · <host> — <status>, <size>', () => {
    const line = spanLine(
      webSpan({
        provider: 'web',
        server: 'web',
        tool: 'web_fetch',
        url: 'https://docs.anthropic.com/en/docs/agents',
        host: 'docs.anthropic.com',
        status: 200,
        bytes: 49152,
      }),
    )
    expect(line).toContain('🌐 web·web_fetch · docs.anthropic.com — 200, 48 KB')
  })

  it('reads a web_search as 🔎 web·web_search · "<query>" — <n> results', () => {
    const line = spanLine(
      webSpan({
        provider: 'web',
        server: 'web',
        tool: 'web_search',
        query: 'mlx speculative decoding',
        result_count: 8,
      }),
    )
    expect(line).toContain('🔎 web·web_search · "mlx speculative decoding" — 8 results')
  })

  it('derives the host from the url when the span carries no host attr', () => {
    const line = spanLine(
      webSpan({ provider: 'web', server: 'web', tool: 'web_fetch', url: 'https://example.org/x?y=1' }),
    )
    expect(line).toContain('example.org')
  })

  it('says the real HTTP status on a failed fetch (404 ≠ "something went wrong")', () => {
    const line = spanLine(
      webSpan({
        provider: 'web',
        server: 'web',
        tool: 'web_fetch',
        host: 'example.com',
        status: 404,
        is_error: true,
      }),
    )
    expect(line).toContain('example.com — 404')
    expect(line).toContain('failed')
  })

  it('a withheld web result STILL shows as withheld, and still names its source', () => {
    const line = spanLine(
      webSpan({
        provider: 'web',
        server: 'web',
        tool: 'web_fetch',
        host: 'internal.example',
        status: 200,
        bytes: 2048,
        withheld: true,
      }),
    )
    expect(line).toContain('🔒')
    expect(line).toContain('withheld')
    expect(line).toContain('internal.example')
  })

  it('a blocked web call names NO destination — the privacy line, from the UI side', () => {
    // The engine records no url/query on a blocked span (it was blocked because
    // the argument looked like a secret), so there is nothing here to leak.
    const line = spanLine(
      webSpan({ provider: 'web', server: 'web', tool: 'web_search', blocked: true }),
    )
    expect(line).toContain('⛔')
    expect(line).toContain('blocked')
    expect(line).not.toContain('—')
  })

  it('falls back to exactly the old generic row when the span carries no detail', () => {
    const line = spanLine(webSpan({ provider: 'web', server: 'web', tool: 'web_fetch' }))
    expect(line).toContain('🌐 web·web_fetch')
    expect(line).not.toContain('—')
  })

  it('shows an MCP result SIZE but never an MCP argument', () => {
    // The safe half of the disclosure for MCP: how much came back, so a call
    // that returned a page and one that returned nothing are not the same row.
    const line = spanLine(
      webSpan({ provider: 'mcp', server: 'notion', tool: 'search_pages', bytes: 12288 }),
    )
    expect(line).toContain('⛭ notion·search_pages · 12 KB')
  })
})

// Vault disclosure (2026-08-05 audit). The console filtered tool_exec spans to
// mcp/web and silently dropped provider='vault' to the generic line — so the one
// piece of activity this product's promise turns on (the companion opened your
// notes) was the one piece the live console never named.
function vaultSpan(attrs: Record<string, unknown>): EngineSpan {
  return { name: 'tool_exec', type: 'tool_exec', status: 'ok', attrs }
}

describe('spanLine — vault tool_exec rendering', () => {
  it('labels a vault_read with the 📓 glyph, vault·vault_read and the note path', () => {
    const line = spanLine(
      vaultSpan({ provider: 'vault', server: 'vault', tool: 'vault_read', path: 'notes/health.md' }),
    )
    expect(line).toContain('📓')
    expect(line).toContain('vault·vault_read')
    expect(line).toContain('notes/health.md')
    expect(line.startsWith('✓')).toBe(true)
  })

  it('names no file when the span carries no path (never a guessed filename)', () => {
    const line = spanLine(vaultSpan({ provider: 'vault', server: 'vault', tool: 'vault_list' }))
    expect(line).toContain('vault·vault_list')
    expect(line).not.toContain(' · notes')
  })

  it('surfaces a held/blocked vault call as governance (⛔), not an infra error', () => {
    const line = spanLine(
      vaultSpan({ provider: 'vault', server: 'vault', tool: 'vault_read', blocked: true }),
    )
    expect(line).toContain('⛔')
    expect(line).toContain('blocked')
  })

  it('gives a withheld vault result the same 🔒 affordance web tools get', () => {
    const line = spanLine(
      vaultSpan({ provider: 'vault', server: 'vault', tool: 'vault_read', withheld: true }),
    )
    expect(line).toContain('🔒')
    expect(line).toContain('withheld')
  })

  it('marks a refused read as failed (honest, not a fake ✓)', () => {
    const line = spanLine(
      vaultSpan({ provider: 'vault', server: 'vault', tool: 'vault_read', is_error: true }),
    )
    expect(line).toContain('✕')
    expect(line).toContain('failed')
  })
})

// No-black-box (2026-08-31, the founder's one remaining concern): the chat
// stream names every file the run added or updated and every terminal
// command it ran — straight from spans the engine now emits per file / per
// command, never summarized away.
describe('file-write and terminal rows', () => {
  it('a file_write span reads as its honest action + path', () => {
    const line = spanLine({
      run_id: 'r', span_id: 's', name: 'file_write', type: 'tool_exec', status: 'ok',
      attrs: { provider: 'files', path: 'docs/BRAND.md', action: 'added' },
    } as never)
    expect(line).toContain('added docs/BRAND.md')
  })

  it('a terminal span reads as the command + exit', () => {
    const line = spanLine({
      run_id: 'r', span_id: 's', name: 'tool_exec', type: 'tool_exec', status: 'ok',
      duration_ms: 900,
      attrs: { provider: 'terminal', command: 'npm test', exit_code: 0, is_error: false },
    } as never)
    expect(line).toContain('$ npm test')
    expect(line).toContain('exit 0')
  })
})
