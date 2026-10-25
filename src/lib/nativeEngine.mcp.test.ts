import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Native-mock pattern mirrored from LearningPanel.test.tsx: mock the Tauri
// core `invoke` so the MCP native-path branches (readMcpServers/
// writeMcpServers/runNativeMcpList) can be exercised end to end without a
// real Tauri IPC bridge.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { readMcpServers, runNativeMcpList, writeMcpServers } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

describe('MCP servers — native shell (real invoke mapping)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('readMcpServers parses a valid array from read_vault_file', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_vault_file') {
        return JSON.stringify([
          { name: 'filesystem', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'], allowed_tools: ['read_file'] },
        ])
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const servers = await readMcpServers('/vault')
    expect(servers).toEqual([
      { name: 'filesystem', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'], allowed_tools: ['read_file'] },
    ])
  })

  it('readMcpServers returns [] for malformed JSON (never throws)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_vault_file') return '{not valid json'
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const servers = await readMcpServers('/vault')
    expect(servers).toEqual([])
  })

  it('readMcpServers returns [] when the file is absent (read_vault_file resolves null)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_vault_file') return null
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const servers = await readMcpServers('/vault')
    expect(servers).toEqual([])
  })

  it('writeMcpServers persists via write_vault_note and returns true on success', async () => {
    let written: unknown
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'write_vault_note') {
        written = args
        return '/vault/mcp-servers.json'
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const ok = await writeMcpServers('/vault', [{ name: 'filesystem', command: ['npx', '-y', 'server'] }])
    expect(ok).toBe(true)
    expect((written as { relpath: string }).relpath).toBe('mcp-servers.json')
    expect(JSON.parse((written as { content: string }).content)).toEqual([
      { name: 'filesystem', command: ['npx', '-y', 'server'] },
    ])
  })

  it('runNativeMcpList maps a valid engine response to { ok: true, tools }', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_engine_mcp') return JSON.stringify({ server: 's', tools: [{ name: 't' }] })
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await runNativeMcpList('/vault', 's')
    expect(result).toEqual({ ok: true, server: 's', tools: [{ name: 't' }] })
  })

  it('runNativeMcpList maps a thrown engine error string to { ok: false, error }', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_engine_mcp') throw new Error('{"ok":false,"error":"boom"}')
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await runNativeMcpList('/vault', 's')
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('runNativeMcpList decodes an engine error containing quotes/newlines (no raw escapes shown)', async () => {
    // The engine writes a single clean JSON line to stderr; the real error text
    // may contain escaped quotes/newlines. The user must see the decoded string.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_engine_mcp')
        throw new Error('{"ok":false,"error":"can\'t run \\"server\\"\\nline two"}')
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await runNativeMcpList('/vault', 's')
    expect(result).toEqual({ ok: false, error: 'can\'t run "server"\nline two' })
  })

  it('runNativeMcpList keeps a non-JSON stderr message as-is', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_engine_mcp') throw new Error('python: command not found')
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await runNativeMcpList('/vault', 's')
    expect(result).toEqual({ ok: false, error: 'python: command not found' })
  })

  it('runNativeMcpList reports an honest error on a malformed engine response', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_engine_mcp') return JSON.stringify({ server: 's' }) // no tools array
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    const result = await runNativeMcpList('/vault', 's')
    expect(result).toEqual({ ok: false, error: 'unexpected response from the engine' })
  })
})
