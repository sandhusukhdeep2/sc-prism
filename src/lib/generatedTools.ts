// SC Prism — generated tools, made visible.
//
// The four gates live in the engine and are enforced there. This is the part
// that lets the user SEE the state of each one. A gate whose state you cannot
// observe is a gate you have to take on faith, which is the opposite of the
// point of having gates at all.
//
// Every state here is derived from the manifest on disk. Nothing is inferred
// from what the interface wishes were true, and the UI can never make a tool
// callable — `activate_tool` in the engine refuses on its own terms, so a
// screen that forgot to check would still be refused.

import {
  isNative,
  listVaultDir,
  readVaultFile,
  resolveVaultDir,
  writeVaultNote,
} from './nativeEngine'

export interface ToolRow {
  name: string
  description: string
  permissions: Record<string, string[]>
  data_class: string
  execution_target: string
  /** GATE 1 — you approved what it MAY do. Grants nothing on its own. */
  scope_approved_by?: string | null
  /** GATE 4 — activated. Requires a passing sandbox run, so only the engine
   *  can set it; no screen may. */
  approved_by: string | null
  passing_tests: number
  quarantined: boolean
  quarantineReason?: string
  /** Vault-relative path of the manifest, for activation. */
  path?: string
}

export interface ToolState {
  id: 'needs-scope' | 'needs-proof' | 'active' | 'quarantined'
  label: string
  detail: string
  callable: boolean
  pinnedLocal: boolean
  canApproveScope: boolean
}

export function toolState(t: ToolRow): ToolState {
  const pinnedLocal = t.data_class === 'confidential' || t.execution_target === 'local_only'

  // Quarantine is a fact about WHERE the tool lives, and it beats anything the
  // manifest claims — a manifest is user-editable text on disk.
  if (t.quarantined) {
    return {
      id: 'quarantined',
      label: 'Quarantined — failed a gate',
      detail: t.quarantineReason
        ? `Reason: ${t.quarantineReason}. Kept for inspection; it cannot be called.`
        : 'Kept for inspection; it cannot be called.',
      callable: false,
      pinnedLocal,
      canApproveScope: false,
    }
  }

  if (!t.scope_approved_by && !t.approved_by) {
    return {
      id: 'needs-scope',
      label: 'Waiting for you — approve its scope',
      detail: 'Nothing has been built yet. You decide what it would be allowed to do.',
      callable: false,
      pinnedLocal,
      canApproveScope: true,
    }
  }

  if (t.passing_tests <= 0) {
    return {
      id: 'needs-proof',
      label: 'Scope approved — not yet proven',
      detail:
        'It has to pass a sandbox run against your own real examples before it ' +
        'can be activated. No fixtures, no registration.',
      callable: false,
      pinnedLocal,
      canApproveScope: false,
    }
  }

  return {
    id: 'active',
    label: 'Active — your crew can call it',
    detail: `Approved by ${t.approved_by}, proven on ${t.passing_tests} test case${
      t.passing_tests === 1 ? '' : 's'
    } from your own data.`,
    callable: true,
    pinnedLocal,
    canApproveScope: false,
  }
}

/**
 * Every generated tool in the vault, active or not.
 *
 * Reads BOTH `tools/generated/` and `tools/quarantine/`, because a tool that
 * failed a gate is exactly the one the user most needs to see — and it is
 * never returned as callable.
 */
export async function readGeneratedTools(vaultPath?: string): Promise<ToolRow[]> {
  if (!isNative()) return []
  try {
    const vault = await resolveVaultDir(vaultPath)
    // `listVaultTree` is markdown-only, so it can never see a manifest.
    const files = await listVaultDir(vault, 'tools')
    const manifests = files.filter((p) =>
      /^tools\/(generated|quarantine)\/[^/]+\/manifest\.json$/i.test(p),
    )
    const out: ToolRow[] = []
    for (const rel of manifests) {
      const raw = await readVaultFile(vault, rel)
      if (!raw) continue
      try {
        const m = JSON.parse(raw) as Record<string, unknown>
        out.push({
          name: String(m.name ?? rel),
          description: String(m.description ?? ''),
          permissions: (m.permissions as Record<string, string[]>) ?? {},
          data_class: String(m.data_class ?? 'confidential'),
          execution_target: String(m.execution_target ?? 'local_only'),
          scope_approved_by: (m.scope_approved_by as string) || null,
          approved_by: (m.approved_by as string) || null,
          passing_tests: Number(m.passing_tests ?? 0),
          quarantined: rel.includes('/quarantine/'),
          quarantineReason: (m.quarantine_reason as string) || undefined,
          path: rel,
        })
      } catch {
        // A malformed manifest is skipped, not fatal — one bad tool must not
        // hide the rest of the toolset from the person trying to review it.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}


/**
 * GATE 1 — record that the user approved this tool's scope.
 *
 * Safe for the interface to write, because it grants nothing: a scope-approved
 * tool is still inert, and every later gate still has to pass. What the
 * interface must NEVER write is `approved_by` or `passing_tests` — those are
 * Gate 4, and they require a sandbox run the engine performs. `activate_tool`
 * refuses on its own terms regardless, so this is belt and braces rather than
 * the only guard.
 */
export async function approveToolScope(
  tool: ToolRow,
  approver: string,
  vaultPath?: string,
): Promise<boolean> {
  if (!isNative() || !tool.path) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const raw = await readVaultFile(vault, tool.path)
    if (!raw) return false
    const m = JSON.parse(raw) as Record<string, unknown>
    m.scope_approved_by = approver
    m.scope_approved_at = new Date().toISOString()
    return (await writeVaultNote(vault, tool.path, JSON.stringify(m, null, 2))) !== null
  } catch {
    return false
  }
}
