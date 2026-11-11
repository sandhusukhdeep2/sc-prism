// The plugin (MCP) servers registered in Settings, as names a run can be given.
//
// 2026-11-11 audit: servers could be registered and tested in Settings
// (`<vault>/mcp-servers.json`), but no app-launched run ever received one — the
// bridge passed no `--mcp-server`, and the capability ceiling hard-coded zero
// servers. The registered NAMES are cached in settings (`settings.mcpServers`)
// so the ceiling and the launch read one list with no vault I/O. The engine
// still resolves each name against the vault's config and still governs every
// call (allow-list, sensitivity, approvals, the per-agent `tools` grant).

/** A name that is safe to hand to the engine as one command-line token. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Registered server names, in order, once each. Accepts the vault's
 *  registrations (`{name}`) or a cached list of names; drops everything else. */
export function mcpServerNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : ''
    if (SAFE_NAME.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** The value for the engine's `--mcp-server`: a comma list, '' when none. */
export function mcpServersArg(names: readonly string[]): string {
  return mcpServerNames([...names]).join(',')
}
