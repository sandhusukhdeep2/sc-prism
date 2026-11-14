// ONE PATH to prove an agent — the ceremony and the crew card both use it.
// A proof is an ordinary engine run (`runNativeTask`) attributed to the agent
// (agentName / stage 'proof'): on the provider that really runs the agent's
// brand (pinned, so a claude agent is never "proven" on the local primary), with
// the user's own capability ceiling plus the agent's grants (the engine
// intersects them — without the ceiling it grants nothing), an output cap, one
// tool turn per grant, Tier-1 stripped (a proof never runs the project's tests).
// Graded from the verdict and that run's own spans; it never throws.
import type { AgentModel, AgentProof } from './agents'
import type { Settings } from './settings'
import type { EngineSpan } from './nativeEngine'
import { newRunId, readSpansTail, resolveVaultDir, runNativeTask } from './nativeEngine'
import { resolveProviderToken } from './roster'
import { appRunCapabilities } from './delegation'
import { buildManagerProviders } from '../store/AppStore'
import { PROOF_MAX_TOKENS, gradeProof, proofCapabilities, proofIntent, proofToolTurns, type ProofResult } from './proofRun'

export function agentSlugForRun(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

/** The button's words: a local proof is free; a cloud brand costs cents. */
export function proofButtonLabel(model: AgentModel): string {
  return model === 'local' ? 'Prove it' : `Prove on ${model} · costs cents`
}

export async function proveAgent(
  agent: { name: string; role: string; model: AgentModel; tools?: readonly string[] },
  vaultPath: string,
  settings: Settings,
  runId: string = newRunId(),
): Promise<ProofResult> {
  const tools = agent.tools ?? []
  // The provider that really runs this brand (a 'claude' agent on a claude-cli
  // setup resolves to claude-cli). Switched off → say so, run nothing: the
  // fallback would be the user's primary, and that proves a different model.
  const provider = resolveProviderToken(settings, agent.model)
  if (!provider || !provider.enabled) {
    return { proven: false, at: Date.now(), lines: [], reason: `${agent.model} is switched off — turn it on in Settings` }
  }
  const { providers } = buildManagerProviders(settings, provider.id)
  const provs = {
    ...providers,
    agentName: agentSlugForRun(agent.name),
    stage: 'proof',
    userCapabilities: appRunCapabilities(settings).join(','),
    agentCapabilities: proofCapabilities(tools),
    webResearch: tools.includes('web') ? true : providers.webResearch,
    maxTokens: PROOF_MAX_TOKENS,
  }
  // The stored path is the user's words (`~/sc-vault`); the engine joins a
  // relative path to its OWN cwd — inside the app bundle — so resolve it here,
  // as every store caller does, and read the tail from the same directory.
  let vault: string
  try {
    vault = await resolveVaultDir(vaultPath)
  } catch {
    return { proven: false, at: Date.now(), lines: [], reason: 'the vault folder could not be found' }
  }
  let verdict: Awaited<ReturnType<typeof runNativeTask>> = null
  try {
    verdict = await runNativeTask(
      proofIntent(agent.name.trim(), agent.role.trim(), tools),
      vault,
      provs,
      runId,
      agent.model === 'local' ? 'local' : 'auto',
      undefined,
      0,
      proofToolTurns(tools),
      'converse',
    )
  } catch {
    verdict = null
  }
  let spans: Awaited<ReturnType<typeof readSpansTail>> = []
  try {
    spans = await readSpansTail(vault, 400)
  } catch {
    spans = []
  }
  return gradeProof(verdict, spans, tools, agent.model, Date.now())
}

/** The ceremony's live tail: this proof's tool calls so far, read from the
 *  resolved vault. The engine stamps its own run id, so the proof's spans are
 *  found by the agent and the stage it was attributed with. */
export async function proofLiveLines(vaultPath: string, name: string): Promise<EngineSpan[]> {
  const vault = await resolveVaultDir(vaultPath)
  const tail = await readSpansTail(vault, 200)
  const slug = agentSlugForRun(name)
  return tail.filter((s) => s.type === 'tool_exec' && s.attrs?.agent === slug && s.attrs?.round === 'proof')
}

/** What a card or header says about an agent's proof. */
export interface ProofView {
  text: string
  tone: 'proven' | 'unproven' | 'none'
  /** Whether the card offers Prove: there is something left to find out. */
  canProve: boolean
  /** The engine's own cause for a failed proof. */
  reason?: string
}

/**
 * What a card says about proof, and whether it offers Prove.
 *
 * Proof is "it answers on its model". A proof on record says what it says. With
 * none on record, a seat whose own turns were ANSWERED in real runs is proven
 * by that work — the card used to read "not yet proven" directly above "74
 * turns · last answered", and offer to prove it again for money (2026-11-14).
 */
export function proofView(proof: AgentProof | undefined, own: { answered: number } | null): ProofView {
  if (proof?.proven) return { text: proofChipText(proof), tone: 'proven', canProve: false }
  if (proof) return { text: proofChipText(proof), tone: 'unproven', canProve: true, ...(proof.reason ? { reason: proof.reason } : {}) }
  if (own && own.answered > 0) return { text: 'proven ✓ in real runs', tone: 'proven', canProve: false }
  return { text: 'not yet proven', tone: 'none', canProve: true }
}

export function proofChipText(proof: AgentProof | undefined): string {
  if (!proof) return 'not yet proven'
  if (proof.proven) return `proven ✓ ${new Date(proof.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
  return `unproven — ${proof.reason || 'not yet proven'}`
}
