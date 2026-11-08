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
import { newRunId, readSpansTail, runNativeTask } from './nativeEngine'
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
  let verdict: Awaited<ReturnType<typeof runNativeTask>> = null
  try {
    verdict = await runNativeTask(
      proofIntent(agent.name.trim(), agent.role.trim(), tools),
      vaultPath,
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
    spans = await readSpansTail(vaultPath, 400)
  } catch {
    spans = []
  }
  return gradeProof(verdict, spans, tools, agent.model, Date.now())
}

/** What a card or header says about an agent's proof. */
export function proofChipText(proof: AgentProof | undefined): string {
  if (!proof) return 'not yet proven'
  if (proof.proven) return `proven ✓ ${new Date(proof.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
  return `unproven — ${proof.reason || 'not yet proven'}`
}
