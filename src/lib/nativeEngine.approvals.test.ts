import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Native-mock pattern mirrored from nativeEngine.mcp.test.ts: mock the Tauri
// core `invoke` so the approval I/O native-path branches (readMcpApprovals /
// writeMcpApprovals / grantToolApproval) run end to end without a real bridge.
// `readHeldToolCalls` is PURE (operates on already-read spans) so it needs no
// native shell at all — it is exercised first, plainly.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  decideApproval,
  dropAlreadyGranted,
  ensureToolPolicyMigrated,
  grantToolApproval,
  migrateReadOnlyGrant,
  migrateToolPolicy,
  migrateVaultGrant,
  readHeldToolCalls,
  readMcpApprovals,
  readPendingApprovals,
  writeMcpApprovals,
} from './nativeEngine'
import type { EngineSpan, McpApprovalPolicy, PendingApproval } from './nativeEngine'
import { READ_ONLY, READ_ONLY_GRANT, classifyTool, readsRunFree, withReadsFree } from './toolRisk'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}
function goBrowser() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

// ---------------------------------------------------------------------------
// readHeldToolCalls (pure)
// ---------------------------------------------------------------------------

describe('readHeldToolCalls (pure — real held spans only)', () => {
  it('keeps held tool_exec spans, dedupes by server+tool keeping the latest at, newest-first', () => {
    const spans: EngineSpan[] = [
      { name: 'tool_exec', type: 'tool_exec', start: 100, attrs: { server: 'echo', tool: 'add', held: true } },
      // same server·tool held again, later — the later `at` wins
      { name: 'tool_exec', type: 'tool_exec', start: 300, attrs: { server: 'echo', tool: 'add', held: true } },
      { name: 'tool_exec', type: 'tool_exec', start: 200, attrs: { server: 'fs', tool: 'write_file', held: true, args: { path: '/tmp/x' } } },
    ]
    // `start` is engine epoch SECONDS; `at` must be milliseconds (start * 1000).
    expect(readHeldToolCalls(spans)).toEqual([
      { server: 'echo', tool: 'add', at: 300_000 },
      { server: 'fs', tool: 'write_file', why: 'path=/tmp/x', at: 200_000 },
    ])
  })

  it('matches on name==="tool_exec" even when the span has no explicit type', () => {
    const spans: EngineSpan[] = [{ name: 'tool_exec', start: 5, attrs: { server: 's', tool: 't', held: true } }]
    expect(readHeldToolCalls(spans)).toEqual([{ server: 's', tool: 't', at: 5_000 }])
  })

  it('converts `start` (engine epoch SECONDS) to `at` in epoch MILLISECONDS — a real recent span reads as seconds/minutes ago, not ~1000x too old', () => {
    // A real ApprovalGate span carries `time.time()` seconds, e.g. 2 minutes ago.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const startSeconds = nowSeconds - 120
    const spans: EngineSpan[] = [
      { name: 'tool_exec', type: 'tool_exec', start: startSeconds, attrs: { server: 'echo', tool: 'add', held: true } },
    ]
    const [item] = readHeldToolCalls(spans)
    expect(item.at).toBe(startSeconds * 1000)
    // Sanity: `at` must be close to `Date.now()`, not tens of thousands of days off.
    expect(Math.abs(Date.now() - (item.at as number))).toBeLessThan(5 * 60_000)
  })

  it('ignores non-held tool_exec spans and held-but-non-tool spans', () => {
    const spans: EngineSpan[] = [
      { name: 'tool_exec', type: 'tool_exec', start: 1, attrs: { server: 'echo', tool: 'add', held: false } },
      { name: 'tool_exec', type: 'tool_exec', start: 2, attrs: { server: 'echo', tool: 'run' } }, // held absent
      { name: 'model_call', type: 'model_call', start: 3, attrs: { held: true } }, // held but not a tool_exec
      { name: 'route', type: 'route', start: 4, attrs: {} },
    ]
    expect(readHeldToolCalls(spans)).toEqual([])
  })

  it('returns [] when there are no spans', () => {
    expect(readHeldToolCalls([])).toEqual([])
  })

  it('derives why: explicit why > args summary > non-boilerplate reason; drops the engine "held:" boilerplate', () => {
    const one = (attrs: Record<string, unknown>): EngineSpan => ({ name: 'tool_exec', type: 'tool_exec', start: 1, attrs })
    expect(readHeldToolCalls([one({ server: 's', tool: 't', held: true, why: 'custom note' })])[0].why).toBe('custom note')
    expect(readHeldToolCalls([one({ server: 's', tool: 't', held: true, args: { a: 1, b: 'x' } })])[0].why).toBe('a=1, b=x')
    expect(readHeldToolCalls([one({ server: 's', tool: 't', held: true, reason: 'needs sign-off' })])[0].why).toBe('needs sign-off')
    // the engine's real held span carries this generic reason — it must NOT surface (it just restates the label)
    expect(
      readHeldToolCalls([one({ server: 's', tool: 't', held: true, reason: 'held: tool needs approval — not run' })])[0].why,
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dropAlreadyGranted (pure — the F2 honesty cross-check against the policy)
// ---------------------------------------------------------------------------

describe('dropAlreadyGranted (pure — an already-granted tool must not surface as held)', () => {
  const echoAdd = { server: 'echo', tool: 'add', at: 1 }
  const fsWrite = { server: 'fs', tool: 'write_file', at: 2 }

  it('drops a held call whose TOOL name is already granted', () => {
    expect(dropAlreadyGranted([echoAdd, fsWrite], ['add'])).toEqual([fsWrite])
  })

  it('drops a held call whose SERVER name is already granted', () => {
    expect(dropAlreadyGranted([echoAdd, fsWrite], ['fs'])).toEqual([echoAdd])
  })

  it('keeps a held call whose tool and server are both NOT granted', () => {
    expect(dropAlreadyGranted([echoAdd, fsWrite], ['some-other-tool'])).toEqual([echoAdd, fsWrite])
  })

  it('empty granted list is a no-op (every held call still needs approval)', () => {
    expect(dropAlreadyGranted([echoAdd, fsWrite], [])).toEqual([echoAdd, fsWrite])
  })

  it('does NOT treat the "all" sentinel in granted as a wildcard match — "all" belongs to `require`, not `granted`', () => {
    expect(dropAlreadyGranted([echoAdd, fsWrite], ['all'])).toEqual([echoAdd, fsWrite])
  })

  // The read-only CLASS grant, mirrored (2026-08-17). What the desk shows must
  // be what the gate enforces — in BOTH directions.
  const vaultRead = { server: 'vault', tool: 'vault_read', at: 3, provider: 'vault' }
  const mcpRead = { server: 'fs', tool: 'read_file', at: 4, provider: 'mcp' }

  it('drops a held READ once the read-only class is granted (it would not be held again)', () => {
    expect(dropAlreadyGranted([vaultRead, fsWrite], [READ_ONLY_GRANT])).toEqual([fsWrite])
  })

  it('keeps a third-party mcp tool whose name only SOUNDS like a read', () => {
    expect(dropAlreadyGranted([mcpRead], [READ_ONLY_GRANT])).toEqual([mcpRead])
  })

  it('keeps a held read whose span carried no provider — unclassifiable stays listed', () => {
    const noProvider = { server: 'vault', tool: 'vault_read', at: 5 }
    expect(dropAlreadyGranted([noProvider], [READ_ONLY_GRANT])).toEqual([noProvider])
  })

  it('honours the require-side override: a user who tightened back sees his reads again', () => {
    expect(dropAlreadyGranted([vaultRead], [READ_ONLY_GRANT], ['all', READ_ONLY_GRANT])).toEqual([
      vaultRead,
    ])
  })
})

// ---------------------------------------------------------------------------
// readMcpApprovals / writeMcpApprovals / grantToolApproval (native)
// ---------------------------------------------------------------------------

describe('MCP approvals I/O — native shell (real invoke mapping)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })
  afterEach(() => {
    goBrowser()
  })

  it('readMcpApprovals parses {require, granted} from read_vault_file', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_vault_file') return JSON.stringify({ require: ['echo'], granted: ['add'] })
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    expect(await readMcpApprovals('/vault')).toEqual({ require: ['echo'], granted: ['add'] })
  })

  it('readMcpApprovals returns the empty default when the file is absent', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_vault_file') return null
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    expect(await readMcpApprovals('/vault')).toEqual({ require: [], granted: [] })
  })

  it('readMcpApprovals returns the default for malformed JSON or a non-object (never throws)', async () => {
    // read_vault_file (the only invoke readMcpApprovals makes) yields each bad
    // shape in turn: unparseable text, then a JSON array (not the {…} object).
    invokeMock.mockResolvedValueOnce('{not valid json')
    expect(await readMcpApprovals('/vault')).toEqual({ require: [], granted: [] })
    invokeMock.mockResolvedValueOnce('[1,2,3]')
    expect(await readMcpApprovals('/vault')).toEqual({ require: [], granted: [] })
  })

  it('writeMcpApprovals persists via write_vault_note (relpath mcp-approvals.json) and returns true', async () => {
    let written: Record<string, unknown> | undefined
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'write_vault_note') {
        written = args
        return '/vault/mcp-approvals.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const ok = await writeMcpApprovals('/vault', { require: ['fs'], granted: ['read'] })
    expect(ok).toBe(true)
    expect((written as { relpath: string }).relpath).toBe('mcp-approvals.json')
    expect(JSON.parse((written as { content: string }).content)).toEqual({ require: ['fs'], granted: ['read'] })
  })

  it('grantToolApproval adds the tool to granted, preserves require, and returns true', async () => {
    let written: Record<string, unknown> | undefined
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_vault_file') return JSON.stringify({ require: ['fs'], granted: ['read'] })
      if (cmd === 'write_vault_note') {
        written = args
        return '/vault/mcp-approvals.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const ok = await grantToolApproval('/vault', 'write_file')
    expect(ok).toBe(true)
    expect(JSON.parse((written as { content: string }).content)).toEqual({
      require: ['fs'],
      granted: ['read', 'write_file'],
    })
  })

  it('grantToolApproval de-dupes an already-granted tool (no duplicate written)', async () => {
    let written: Record<string, unknown> | undefined
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_vault_file') return JSON.stringify({ require: [], granted: ['ls'] })
      if (cmd === 'write_vault_note') {
        written = args
        return '/vault/mcp-approvals.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const ok = await grantToolApproval('/vault', 'ls')
    expect(ok).toBe(true)
    expect(JSON.parse((written as { content: string }).content)).toEqual({ require: [], granted: ['ls'] })
  })
})

describe('MCP approvals I/O — non-native (browser) is inert', () => {
  beforeEach(() => {
    goBrowser()
    invokeMock.mockReset()
  })

  it('readMcpApprovals returns the empty default and never touches the bridge', async () => {
    expect(await readMcpApprovals('/vault')).toEqual({ require: [], granted: [] })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('writeMcpApprovals and grantToolApproval return false without calling the bridge', async () => {
    expect(await writeMcpApprovals('/vault', { require: [], granted: ['x'] })).toBe(false)
    expect(await grantToolApproval('/vault', 'x')).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The vault-grant MIGRATION (2026-08-11 acceptance walk, A1).
//
// The regression this pins, taken from a REAL install: `granted` had grown one
// approved tool name at a time via the desk, so it carried four vault tool names
// but NOT the server-level `vault` grant — and not `vault_search`, which the
// user had simply never been asked about. `withVaultGranted` only ran when the
// user RE-SAVED their posture, which an existing install never does, so
// `vault_search` stayed held forever: with the blocking broker on, every
// heartbeat wake stalled on it and died at the 240s client cancel, burning the
// engine lock each cadence. The union has to be a migration, not a side effect.
// ---------------------------------------------------------------------------

/** The user's live ~/sc-vault/mcp-approvals.json at the time of the walk. */
const HIS_POLICY: McpApprovalPolicy = {
  require: ['all'],
  granted: ['web_search', 'web_fetch', 'read_file', 'project_status', 'vault_read', 'vault_list'],
}

/**
 * The engine's own decision, mirrored: a call is HELD when it (or its server, or
 * "all") is required and neither its tool name, its server name nor "all" is
 * granted — and, since 2026-08-17, when the read-only CLASS grant does not cover
 * it either. Byte-for-byte the logic of ToolApprovalPolicy.decide in
 * engine/scprism_engine/approval.py — so "allowed" here means allowed there.
 *
 * `provider` is the serving source's audit tag, the only input the risk
 * classification trusts (see toolRisk.ts). Omitted → acting → held, exactly as
 * the engine fails safe when a caller does not supply one.
 */
function decide(
  policy: McpApprovalPolicy,
  server: string,
  tool: string,
  provider?: string,
): 'allow' | 'hold' {
  const required = policy.require.includes('all') || policy.require.includes(tool) || policy.require.includes(server)
  if (!required) return 'allow'
  const granted = policy.granted.includes('all') || policy.granted.includes(tool) || policy.granted.includes(server)
  if (granted) return 'allow'
  if (readsRunFree(policy) && classifyTool(provider, tool) === READ_ONLY) return 'allow'
  return 'hold'
}

const VAULT_TOOLS = ['vault_list', 'vault_read', 'vault_search', 'project_status']

describe('migrateVaultGrant (pure) — his exact policy shape', () => {
  it('BEFORE the migration his policy holds vault_search — the call the wake died on', () => {
    expect(decide(HIS_POLICY, 'vault', 'vault_search')).toBe('hold')
  })

  it('AFTER the migration every vault tool is allowed, including vault_search', () => {
    const migrated = migrateVaultGrant(HIS_POLICY)
    for (const tool of VAULT_TOOLS) {
      expect(decide(migrated, 'vault', tool)).toBe('allow')
    }
  })

  it('preserves `require` exactly and leaves the mcp/web grants untouched', () => {
    const migrated = migrateVaultGrant(HIS_POLICY)
    expect(migrated.require).toEqual(['all'])
    // every pre-existing name survives, in order — only `vault` is appended
    expect(migrated.granted).toEqual([...HIS_POLICY.granted, 'vault'])
    // and the input object itself is never mutated
    expect(HIS_POLICY.granted).not.toContain('vault')
  })

  it('does NOT widen anything else: mcp/web tools he never granted stay held', () => {
    const migrated = migrateVaultGrant(HIS_POLICY)
    expect(decide(migrated, 'fs', 'write_file')).toBe('hold')
    expect(decide(migrated, 'echo', 'add')).toBe('hold')
    // …while the ones he DID grant by name keep working, unchanged
    expect(decide(migrated, 'web', 'web_search')).toBe('allow')
  })

  it('is idempotent — an already-migrated policy is returned by identity (nothing to write)', () => {
    const once = migrateVaultGrant(HIS_POLICY)
    expect(migrateVaultGrant(once)).toBe(once)
  })

  it('leaves an INACTIVE policy (empty require) untouched — it can hold nothing', () => {
    const inactive: McpApprovalPolicy = { require: [], granted: [] }
    expect(migrateVaultGrant(inactive)).toBe(inactive)
  })
})

// ---------------------------------------------------------------------------
// The READ-ONLY CLASS migration (2026-08-17).
//
// "this software is asking for permission every time. I think lots of the time
// it's asked again and again." His spans: 32 held calls — web_fetch 8x,
// vault_read 8x, web_search 6x, project_status 6x, read_file 2x, vault_list 2x.
// EVERY ONE a read. With the `all` sentinel each new tool NAME costs its own
// prompt, and an unattended wake that meets one stalls until the timeout.
//
// His decision: let it work, hold only risky tools. The migration grants the
// read-only CLASS — not a name list that goes stale, and not the `all` wildcard.
// ---------------------------------------------------------------------------

describe('migrateReadOnlyGrant (pure) — his exact policy shape', () => {
  it('BEFORE: the reads he was prompted for are held even after the vault grant', () => {
    const vaultOnly = migrateVaultGrant(HIS_POLICY)
    // web_fetch/web_search/project_status happen to be granted BY NAME already —
    // that is the "asked again and again" mechanism: each name had to be bought
    // with its own prompt. vault_search never was, and web tools on a fresh
    // install never are.
    expect(decide(vaultOnly, 'web', 'web_fetch', 'web')).toBe('allow') // bought earlier
    const fresh: McpApprovalPolicy = { require: ['all'], granted: [] }
    expect(decide(fresh, 'web', 'web_fetch', 'web')).toBe('hold')
    expect(decide(fresh, 'vault', 'vault_search', 'vault')).toBe('hold')
  })

  it('AFTER: every read-only tool runs unheld — including ones he never approved', () => {
    const migrated = migrateToolPolicy({ require: ['all'], granted: [] })
    for (const [provider, tool] of [
      ['vault', 'vault_read'],
      ['vault', 'vault_list'],
      ['vault', 'vault_search'],
      ['vault', 'project_status'],
      ['web', 'web_fetch'],
      ['web', 'web_search'],
    ]) {
      expect(decide(migrated, provider, tool, provider)).toBe('allow')
    }
  })

  it('ACTING tools are still held — the veto the user keeps is untouched', () => {
    const migrated = migrateToolPolicy(HIS_POLICY)
    expect(decide(migrated, 'fs', 'write_file', 'mcp')).toBe('hold')
    expect(decide(migrated, 'notion', 'create_page', 'mcp')).toBe('hold')
    expect(decide(migrated, 'mail', 'send_email', 'mcp')).toBe('hold')
  })

  it('an UNKNOWN mcp tool defaults to HELD, however harmless its name sounds', () => {
    const migrated = migrateToolPolicy({ require: ['all'], granted: [] })
    expect(decide(migrated, 'notion', 'notion.search', 'mcp')).toBe('hold')
    expect(decide(migrated, 'fs', 'read_file', 'mcp')).toBe('hold')
    // our own tool NAME, served by a third-party server, is still held: the
    // class keys on the PROVIDER, which our source classes stamp and a stranger
    // cannot. (A server the user NAMES `vault` is a separate, older matter —
    // the name-level `vault` grant predates this and is unchanged.)
    expect(decide(migrated, 'notion', 'vault_read', 'mcp')).toBe('hold')
  })

  it('preserves `require` exactly and every existing granted name, in order', () => {
    const migrated = migrateReadOnlyGrant(HIS_POLICY)
    expect(migrated.require).toEqual(['all'])
    expect(migrated.granted).toEqual([...HIS_POLICY.granted, READ_ONLY_GRANT])
    expect(HIS_POLICY.granted).not.toContain(READ_ONLY_GRANT) // input never mutated
  })

  it('is idempotent — already migrated is returned by identity (nothing to write)', () => {
    const once = migrateReadOnlyGrant(HIS_POLICY)
    expect(migrateReadOnlyGrant(once)).toBe(once)
    const both = migrateToolPolicy(HIS_POLICY)
    expect(migrateToolPolicy(both)).toBe(both)
  })

  it('leaves an INACTIVE policy (empty require) untouched — it can hold nothing', () => {
    const inactive: McpApprovalPolicy = { require: [], granted: [] }
    expect(migrateReadOnlyGrant(inactive)).toBe(inactive)
    expect(migrateToolPolicy(inactive)).toBe(inactive)
  })

  it('TIGHTENING BACK to hold-everything really holds the reads again', () => {
    // A fresh install (no per-name grants), so the ONLY thing freeing web_fetch
    // is the class — which is exactly what tightening takes away.
    const free = migrateToolPolicy({ require: ['all'], granted: ['echo·add'] })
    expect(decide(free, 'web', 'web_fetch', 'web')).toBe('allow')
    const tightened = withReadsFree(free, false)
    expect(decide(tightened, 'web', 'web_fetch', 'web')).toBe('hold')
    // …and the user's own earlier grants survive the tightening — including the
    // server-level `vault` grant from the 2026-08-11 migration, which keeps the
    // companion's eyes on its own notes open. Tightening takes back the CLASS,
    // not the names he (or an earlier migration) already granted.
    expect(tightened.granted).toContain('echo·add')
    expect(tightened.granted).toContain('vault')
  })

  it('the class grant is NOT a wildcard — it never behaves like `all`', () => {
    const migrated = migrateToolPolicy({ require: ['all'], granted: [] })
    expect(migrated.granted).not.toContain('all')
    expect(decide(migrated, 'anything', 'anything', 'mcp')).toBe('hold')
  })
})

describe('ensureToolPolicyMigrated — the migration reaches the real file', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })
  afterEach(() => {
    goBrowser()
  })

  it('rewrites his file with the server-level grant, preserving require + every other name', async () => {
    let written: Record<string, unknown> | undefined
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_vault_file') return JSON.stringify(HIS_POLICY)
      if (cmd === 'write_vault_note') {
        written = args
        return '/vault/mcp-approvals.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const policy = await ensureToolPolicyMigrated('/vault')
    expect((written as { relpath: string }).relpath).toBe('mcp-approvals.json')
    // His file after the migration: require untouched, every name he ever
    // approved still there, plus the vault server grant and the read-only class.
    expect(JSON.parse((written as { content: string }).content)).toEqual({
      require: ['all'],
      granted: [...HIS_POLICY.granted, 'vault', READ_ONLY_GRANT],
    })
    expect(policy.granted).toContain('vault')
    expect(readsRunFree(policy)).toBe(true)
    // He does not have to re-save anything in Settings for this to take effect.
  })

  it('writes NOTHING when both grants are already there (idempotent on every later launch)', async () => {
    const calls: string[] = []
    invokeMock.mockImplementation(async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'read_vault_file') {
        return JSON.stringify({ require: ['all'], granted: ['web_search', 'vault', READ_ONLY_GRANT] })
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    await ensureToolPolicyMigrated('/vault')
    expect(calls).toEqual(['read_vault_file'])
  })

  it('writes ONCE, not twice, when only one of the two grants is missing', async () => {
    const writes: string[] = []
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_vault_file') return JSON.stringify({ require: ['all'], granted: ['vault'] })
      if (cmd === 'write_vault_note') {
        writes.push(args.content as string)
        return '/vault/mcp-approvals.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    await ensureToolPolicyMigrated('/vault')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0])).toEqual({ require: ['all'], granted: ['vault', READ_ONLY_GRANT] })
  })

  it('NEVER re-frees reads a user deliberately tightened — a heal must not overrule a choice', async () => {
    // The Settings switch writes the require-side mark when it tightens. If the
    // migration ignored it, the next launch would silently free reads again:
    // the page would say "held", the gate would say "free". That is the exact
    // shown-is-not-enforced failure this feature must not have.
    const calls: string[] = []
    invokeMock.mockImplementation(async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'read_vault_file') {
        return JSON.stringify({ require: ['all', READ_ONLY_GRANT], granted: ['vault'] })
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    const policy = await ensureToolPolicyMigrated('/vault')
    expect(calls).toEqual(['read_vault_file']) // nothing written
    expect(readsRunFree(policy)).toBe(false)
    expect(decide(policy, 'web', 'web_fetch', 'web')).toBe('hold')
  })

  it('writes NOTHING when there is no approvals file — a migration never conjures a posture', async () => {
    const calls: string[] = []
    invokeMock.mockImplementation(async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'read_vault_file') return null
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    expect(await ensureToolPolicyMigrated('/vault')).toEqual({ require: [], granted: [] })
    expect(calls).toEqual(['read_vault_file'])
  })

  it('is inert in a browser (no bridge call at all)', async () => {
    goBrowser()
    invokeMock.mockReset()
    expect(await ensureToolPolicyMigrated('/vault')).toEqual({ require: [], granted: [] })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Mid-run BLOCKING approval — readPendingApprovals / decideApproval (native
// invoke mapping + non-native safety). These surface a PAUSED run and answer it.
// ---------------------------------------------------------------------------

describe('blocking-approval I/O — native shell (real invoke mapping)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })
  afterEach(() => {
    goBrowser()
  })

  it('readPendingApprovals maps read_pending_approvals rows straight through', async () => {
    const rows: PendingApproval[] = [
      { id: 'id2', server: 'echo', tool: 'add', at: 200 },
      { id: 'id1', run_id: 'r1', server: 'fs', tool: 'write_file', args_summary: '{"p":1}', at: 100 },
    ]
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_pending_approvals') {
        expect(args).toEqual({ vault: '/vault' })
        return rows
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    expect(await readPendingApprovals('/vault')).toEqual(rows)
  })

  it('readPendingApprovals returns [] when the bridge yields a non-array (defensive)', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    expect(await readPendingApprovals('/vault')).toEqual([])
    invokeMock.mockResolvedValueOnce({ not: 'an array' })
    expect(await readPendingApprovals('/vault')).toEqual([])
  })

  it('readPendingApprovals returns [] (never throws) when the bridge errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'))
    expect(await readPendingApprovals('/vault')).toEqual([])
  })

  it('decideApproval writes the decision via write_approval_decision and returns true', async () => {
    let seen: Record<string, unknown> | undefined
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'write_approval_decision') {
        seen = args
        return undefined
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    expect(await decideApproval('/vault', 'id2', 'allow')).toBe(true)
    expect(seen).toEqual({ vault: '/vault', id: 'id2', decision: 'allow' })
    expect(await decideApproval('/vault', 'id1', 'deny')).toBe(true)
    expect(seen).toEqual({ vault: '/vault', id: 'id1', decision: 'deny' })
  })

  it('decideApproval returns false (never throws) when the write fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rename failed'))
    expect(await decideApproval('/vault', 'id2', 'allow')).toBe(false)
  })
})

describe('blocking-approval I/O — non-native (browser) is inert', () => {
  beforeEach(() => {
    goBrowser()
    invokeMock.mockReset()
  })

  it('readPendingApprovals returns [] and decideApproval false without touching the bridge', async () => {
    expect(await readPendingApprovals('/vault')).toEqual([])
    expect(await decideApproval('/vault', 'id', 'allow')).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
