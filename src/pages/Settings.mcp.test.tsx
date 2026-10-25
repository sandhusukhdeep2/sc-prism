import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// Native bridges: nativeEngine.ts calls the Tauri path plugin (resolveVaultDir's
// default-vault-dir path) and `invoke` (read_vault_file / write_vault_note /
// run_engine_mcp / check_extensions / read_training_count). Mocked so the
// native-path tests below can drive the real MCP servers UI without a real
// Tauri IPC bridge — mirrors LearningPanel.test.tsx's pattern.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/fake/appdata',
  homeDir: async () => '/fake/home',
  join: async (...parts: string[]) => parts.filter(Boolean).join('/'),
}))

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

describe('Settings — MCP servers section (browser / non-native)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders the kicker and an honest disabled row, without throwing', () => {
    expect(() => renderSettings()).not.toThrow()
    expect(screen.getByText('Tools · MCP servers')).toBeInTheDocument()
    expect(screen.getByText(/register mcp servers in the installed app/i)).toBeInTheDocument()
    // No server rows, no add/edit form, when not native.
    expect(screen.queryByLabelText(/mcp server name/i)).not.toBeInTheDocument()
  })
})

describe('Settings — MCP servers section (native shell)', () => {
  // Simple in-memory vault file so write_vault_note / read_vault_file behave
  // like a real (if tiny) filesystem across calls within one test.
  let storedMcpJson: string | null

  beforeEach(() => {
    localStorage.clear()
    goNative()
    invokeMock.mockReset()
    storedMcpJson = null
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'check_extensions':
          return { deepeval: false, lightrag: false, llm: false, bifrost: false }
        case 'read_training_count':
          return 0
        case 'read_vault_file':
          if (args?.relpath === 'mcp-servers.json') return storedMcpJson
          return null
        case 'write_vault_note':
          if (args?.relpath === 'mcp-servers.json') {
            storedMcpJson = String(args.content)
            return '/fake/vault/mcp-servers.json'
          }
          return '/fake/vault/' + String(args?.relpath)
        case 'run_engine_mcp':
          return JSON.stringify({
            server: args?.server,
            tools: [{ name: 'read_file' }, { name: 'list_dir' }],
          })
        default:
          throw new Error(`unexpected invoke: ${cmd}`)
      }
    })
  })

  afterEach(() => {
    localStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('shows an honest empty state before any server is registered', async () => {
    renderSettings()
    expect(await screen.findByText(/no servers yet/i)).toBeInTheDocument()
  })

  it('rejects an empty form with an honest inline message (no server added)', async () => {
    renderSettings()
    await screen.findByText(/no servers yet/i)

    fireEvent.click(screen.getByRole('button', { name: /save server/i }))
    expect(await screen.findByText(/a name and a command are both required/i)).toBeInTheDocument()
  })

  it('adds a server, tests it (real tool names from the engine), then removes it', async () => {
    renderSettings()
    await screen.findByText(/no servers yet/i)

    fireEvent.change(screen.getByLabelText(/mcp server name/i), { target: { value: 'filesystem' } })
    fireEvent.change(screen.getByLabelText(/mcp server command/i), {
      target: { value: 'npx -y @modelcontextprotocol/server-filesystem /tmp' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save server/i }))

    // The server now appears in the list; the config was persisted as valid
    // JSON matching the engine's load_mcp_servers contract.
    expect(await screen.findByText('filesystem')).toBeInTheDocument()
    expect(screen.getByText('npx -y @modelcontextprotocol/server-filesystem /tmp')).toBeInTheDocument()
    expect(screen.getByText('all tools')).toBeInTheDocument()
    expect(storedMcpJson).not.toBeNull()
    expect(JSON.parse(storedMcpJson as string)).toEqual([
      { name: 'filesystem', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    ])

    // Test button hits the real engine handshake (run_engine_mcp) and shows
    // the REAL tool names it returned — never a fabricated list.
    fireEvent.click(screen.getByRole('button', { name: /test filesystem/i }))
    expect(await screen.findByText(/2 tools: read_file, list_dir/i)).toBeInTheDocument()

    // Remove is a two-step in-app confirm (no native dialog): the ✕ arms it,
    // an explicit "confirm" performs the durable removal, then the shrunken
    // list persists and the empty state returns.
    fireEvent.click(screen.getByRole('button', { name: /^remove filesystem$/i }))
    // Still present until confirmed — one click never removes.
    expect(screen.getByText('filesystem')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /confirm remove filesystem/i }))
    await waitFor(() => expect(screen.queryByText('filesystem')).not.toBeInTheDocument())
    expect(await screen.findByText(/no servers yet/i)).toBeInTheDocument()
    expect(JSON.parse(storedMcpJson as string)).toEqual([])
  })

  it('rejects a duplicate server name with an honest inline message', async () => {
    storedMcpJson = JSON.stringify([{ name: 'filesystem', command: ['npx', '-y', 'server'] }])
    renderSettings()
    expect(await screen.findByText('filesystem')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/mcp server name/i), { target: { value: 'filesystem' } })
    fireEvent.change(screen.getByLabelText(/mcp server command/i), { target: { value: 'npx -y other' } })
    fireEvent.click(screen.getByRole('button', { name: /save server/i }))

    expect(await screen.findByText(/a server named "filesystem" already exists/i)).toBeInTheDocument()
  })

  it('surfaces the real engine error on a failed test, never a fabricated tool list', async () => {
    storedMcpJson = JSON.stringify([{ name: 'flaky', command: ['npx', '-y', 'flaky-server'] }])
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'check_extensions':
          return { deepeval: false, lightrag: false, llm: false, bifrost: false }
        case 'read_training_count':
          return 0
        case 'read_vault_file':
          return args?.relpath === 'mcp-servers.json' ? storedMcpJson : null
        case 'run_engine_mcp':
          throw new Error('{"ok":false,"error":"connection refused"}')
        default:
          throw new Error(`unexpected invoke: ${cmd}`)
      }
    })

    renderSettings()
    expect(await screen.findByText('flaky')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /test flaky/i }))
    expect(await screen.findByText('connection refused')).toBeInTheDocument()
    expect(screen.queryByText(/tools:/i)).not.toBeInTheDocument()
  })
})
