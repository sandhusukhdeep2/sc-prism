// Keep settings' cached plugin-server names true to <vault>/mcp-servers.json.
// Called at app start (AppShell); the Settings panel refreshes the cache itself
// whenever it loads, saves or removes a server.
import { isNative, readMcpServers, resolveVaultDir } from './nativeEngine'
import { mcpServerNames } from './mcpServers'

export async function syncMcpServers(
  vaultPath: string,
  setNames: (names: string[]) => void,
): Promise<void> {
  if (!isNative()) return
  const vault = await resolveVaultDir(vaultPath)
  setNames(mcpServerNames(await readMcpServers(vault)))
}
