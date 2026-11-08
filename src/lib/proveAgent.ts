// ONE PATH to prove an agent — the ceremony and the crew card both use it.
// A proof is an ordinary engine run (`runNativeTask`) attributed to the agent
// (agentName / stage 'proof'), with its granted capabilities, a 400-token
// budget and one tool turn, on its own model (local → the local route, a cloud
// brand → auto). It is graded from the verdict and that run's own spans; it
// never throws — an engine that fails to finish is an unproven result.
import type { AgentModel, AgentProof } from './agents'
import type { EngineProviders } from './nativeEngine'
import { newRunId, readSpansTail, runNativeTask } from './nativeEngine'
import { PROOF_BUDGET, PROOF_TOOL_TURNS, gradeProof, proofCapabilities, proofIntent, type ProofResult } from './proofRun'

export function agentSlugForRun(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

export async function proveAgent(
  agent: { name: string; role: string; model: AgentModel; tools?: readonly string[] },
  vaultPath: string,
  providers: EngineProviders,
  runId: string = newRunId(),
): Promise<ProofResult> {
  const tools = agent.tools ?? []
  let verdict: Awaited<ReturnType<typeof runNativeTask>> = null
  try {
    verdict = await runNativeTask(
      proofIntent(agent.name.trim(), agent.role.trim()),
      vaultPath,
      { ...providers, agentName: agentSlugForRun(agent.name), stage: 'proof', agentCapabilities: proofCapabilities(tools) },
      runId,
      agent.model === 'local' ? 'local' : 'auto',
      undefined,
      PROOF_BUDGET,
      PROOF_TOOL_TURNS,
      'converse',
    )
  } catch {
    verdict = null
  }
  let spans: Awaited<ReturnType<typeof readSpansTail>> = []
  try {
    spans = await readSpansTail(vaultPath, 200)
  } catch {
    spans = []
  }
  return gradeProof(verdict, spans, runId, tools, Date.now())
}

/** What a card or header says about an agent's proof. */
export function proofChipText(proof: AgentProof | undefined): string {
  if (!proof) return 'not yet proven'
  if (proof.proven) return `proven ✓ ${new Date(proof.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
  return `unproven — ${proof.reason || 'not yet proven'}`
}
