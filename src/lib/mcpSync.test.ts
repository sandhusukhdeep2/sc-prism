import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readMcpServers: vi.fn(async () => [] as { name: string; command: string[] }[]),
}))
vi.mock('./nativeEngine', () => h)

import { syncMcpServers } from './mcpSync'

// The registered plugin servers live in <vault>/mcp-servers.json; settings keeps
// a cached list of their names so the capability ceiling and a launch need no
// vault read. The cache is refreshed at app start and whenever Settings saves.
describe('syncMcpServers — the cached names follow the vault file', () => {
  beforeEach(() => {
    h.isNative.mockReturnValue(true)
    h.readMcpServers.mockReset()
  })

  it('caches the names registered in the vault', async () => {
    h.readMcpServers.mockResolvedValue([
      { name: 'files', command: ['npx', 'x'] },
      { name: 'github', command: ['gh-mcp'] },
    ])
    const set = vi.fn()
    await syncMcpServers('~/vault', set)
    expect(h.resolveVaultDir).toHaveBeenCalledWith('~/vault')
    expect(set).toHaveBeenCalledWith(['files', 'github'])
  })

  it('caches an empty list when nothing is registered, so a removed server stops riding runs', async () => {
    h.readMcpServers.mockResolvedValue([])
    const set = vi.fn()
    await syncMcpServers('~/vault', set)
    expect(set).toHaveBeenCalledWith([])
  })

  it('does nothing outside the installed app', async () => {
    h.isNative.mockReturnValue(false)
    const set = vi.fn()
    await syncMcpServers('~/vault', set)
    expect(set).not.toHaveBeenCalled()
  })

  it('is called at app start and after every change in Settings', () => {
    expect(readFileSync('src/components/AppShell.tsx', 'utf8')).toMatch(/syncMcpServers\(/)
    const settings = readFileSync('src/pages/Settings.tsx', 'utf8')
    // load, save and remove each refresh the cache
    expect((settings.match(/setMcpServers\(mcpServerNames\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
