/**
 * Tool RISK classification — the app-side MIRROR of the engine's source of truth.
 *
 * THE SOURCE OF TRUTH IS `engine/scprism_engine/toolrisk.py`. That module is
 * what ENFORCES this at the gate (`approval.ToolApprovalPolicy.decide`, called
 * from `ApprovalGate.call_tool` before any egress). Read it for the full
 * reasoning: the two classes, why a tool must be on an allowlist to be
 * read-only, why an unknown third-party MCP tool defaults to ACTING, and the
 * residual risks we accept and state plainly.
 *
 * This file exists because the APP has to say the same thing the engine does:
 * migrate the user's policy, and show him in Settings what runs freely and what
 * waits. A capability shown must be the one enforced — so `toolRisk.parity.test.ts`
 * reads the Python module off disk and fails if these two tables ever drift.
 * Do not edit the table here alone; edit the Python and let the test tell you.
 *
 * THE SHORT VERSION
 *   READ-ONLY  it only looks. It cannot write, send, spend, or change anything
 *              outside the process. Two of our own sources qualify, tool by
 *              tool: the vault reader and the web reader.
 *   ACTING     everything else — and everything we cannot PROVE is read-only,
 *              which includes every tool of every MCP server the user added,
 *              whatever its name says. Held, exactly as before.
 */

/** The two classes. */
export const READ_ONLY = 'read-only'
export const ACTING = 'acting'
export type ToolRisk = typeof READ_ONLY | typeof ACTING

/**
 * The name that carries the read-only CLASS in a policy. Mirrors
 * `toolrisk.READ_ONLY_GRANT`, and it reads the same in both of the policy's
 * fields:
 *
 *   in `granted` → "let the read-only class run without asking"
 *   in `require` → "require approval for the read-only class too", i.e. the
 *                  user deliberately chose hold-everything. It OVERRIDES the
 *                  grant (require beats granted, at the gate), and it is what
 *                  stops the launch migration from quietly re-freeing reads he
 *                  just tightened.
 *
 * Neither present is the old behaviour: every ungranted call is held.
 */
export const READ_ONLY_GRANT = 'read-only'

/**
 * provider → the exact tool names established read-only by reading that
 * source's code. Mirrors `toolrisk.FIRST_PARTY_READ_ONLY`.
 *
 * `provider` is the audit tag our own source classes stamp on their spans
 * ('vault' / 'web'); an MCP client stamps none and is tagged 'mcp'. The classification
 * deliberately does NOT key on the SERVER name, which is user-chosen: someone
 * may name an MCP server `vault`, and name-keying would hand a stranger's
 * server the free pass meant for the engine's own note reader.
 */
export const FIRST_PARTY_READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  vault: ['vault_list', 'vault_read', 'vault_search', 'project_status'],
  web: ['web_fetch', 'web_search'],
}

/**
 * READ_ONLY or ACTING for one tool call. Mirrors `toolrisk.classify`: read-only
 * requires BOTH a first-party provider AND a name on that provider's allowlist.
 * Anything else — unknown provider, unlisted name, missing provider, any MCP
 * tool — is ACTING. Never throws.
 */
export function classifyTool(provider: string | undefined, tool: string | undefined): ToolRisk {
  if (typeof provider !== 'string' || typeof tool !== 'string') return ACTING
  const allowed = FIRST_PARTY_READ_ONLY[provider]
  if (!allowed) return ACTING
  return allowed.includes(tool) ? READ_ONLY : ACTING
}

/** The two fields the gate reads. Structurally the vault's mcp-approvals.json. */
export interface RiskPolicyFields {
  require: readonly string[]
  granted: readonly string[]
}

/**
 * True when this policy lets the read-only class run unheld. Mirrors
 * `ToolApprovalPolicy.reads_run_free`: granted carries the class AND require
 * does not demand it back. Require wins, because a user tightening up must
 * never lose to a stale grant.
 */
export function readsRunFree(policy: RiskPolicyFields): boolean {
  return policy.granted.includes(READ_ONLY_GRANT) && !policy.require.includes(READ_ONLY_GRANT)
}

/**
 * The policy with reads freed (`free`) or held (`!free`) — every other name
 * preserved, in order. The SINGLE transform behind both the Settings switch and
 * the migration, so "let reading run" and "hold everything" are exact inverses
 * and neither can drift from the other.
 *
 * Freeing puts the class in `granted` and clears any require-side demand;
 * tightening does the reverse, and the require-side mark is what makes the
 * choice STICK across launches (the migration reads it and stands down).
 * Returns the SAME OBJECT when nothing changes — how callers know not to write.
 */
export function withReadsFree<T extends RiskPolicyFields>(policy: T, free: boolean): T {
  if (readsRunFree(policy) === free) return policy
  const require = free
    ? policy.require.filter((n) => n !== READ_ONLY_GRANT)
    : policy.require.includes(READ_ONLY_GRANT)
      ? [...policy.require]
      : [...policy.require, READ_ONLY_GRANT]
  const granted = free
    ? policy.granted.includes(READ_ONLY_GRANT)
      ? [...policy.granted]
      : [...policy.granted, READ_ONLY_GRANT]
    : policy.granted.filter((n) => n !== READ_ONLY_GRANT)
  return { ...policy, require, granted }
}

/**
 * True when the user has EXPLICITLY decided about the read-only class either
 * way — so the launch migration leaves the policy alone. Without this, tightening
 * back to hold-everything would silently un-tighten on the next app start: the
 * page would say "held", the gate would say "free". That is exactly the
 * shown-is-not-enforced failure this feature must not have.
 */
export function readsDecidedExplicitly(policy: RiskPolicyFields): boolean {
  return policy.require.includes(READ_ONLY_GRANT) || policy.granted.includes(READ_ONLY_GRANT)
}

/**
 * The plain-language lines Settings shows. They are DERIVED from the same table
 * the engine enforces, never hand-written next to it, so the page cannot claim
 * a capability the gate does not grant.
 */
export function readOnlyToolNames(): string[] {
  return Object.values(FIRST_PARTY_READ_ONLY).flatMap((names) => [...names])
}
