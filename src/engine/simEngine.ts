// SC Prism — simulated engine.
// runTask streams events (PLAN → ROUTE → EXECUTE → TIER 1 → TIER 2 → WRITE-BACK) with
// small delays so the UI can animate, then resolves the produced Verdict. No I/O, no
// Math.random: everything is seeded off a hash of the intent so a given intent is reproducible.

import type {
  Agent,
  EngineEvent,
  ModelId,
  RouteDecision,
  Sensitivity,
  TaskContract,
  Tier1Result,
  Tier2Result,
  Verdict,
} from './types'
import { providerModel, type Settings } from '../lib/settings'

// ---------- real OpenAI-compatible model call (optional) ----------

// Minimal shape of an OpenAI-compatible chat completion response.
interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

// If the primary provider is enabled and has a base URL, POST the intent to its
// /v1/chat/completions endpoint. Returns the assistant text, or null on any
// error/timeout so the caller can fall back to the pure simulation.
async function callPrimaryModel(
  settings: Settings | undefined,
  intent: string,
): Promise<string | null> {
  if (!settings) return null
  const primary = settings.providers.find(
    (p) => p.primary && p.enabled && p.baseUrl.trim().length > 0,
  )
  if (!primary) return null

  const base = primary.baseUrl.trim().replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(primary.apiKey.trim() ? { Authorization: `Bearer ${primary.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: providerModel(primary),
        messages: [
          {
            role: 'system',
            content:
              'You are SC Prism, a coding companion. Reply in one or two concise sentences ' +
              'describing how you would implement the requested change.',
          },
          { role: 'user', content: intent },
        ],
        max_tokens: 220,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as ChatCompletion
    const text = data.choices?.[0]?.message?.content?.trim()
    return text && text.length > 0 ? text : null
  } catch {
    clearTimeout(timer)
    return null
  }
}

// ---------- deterministic pseudo-randomness (seeded by the intent) ----------

// FNV-1a hash of the intent — the single seed everything derives from.
function hashIntent(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// xorshift32 — a tiny reproducible stream of 0..1 values from a seed.
function makeRng(seed: number): () => number {
  let x = seed || 0x9e3779b9
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 100000) / 100000
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let taskCounter = 1040

// ---------- classification ----------

const SENSITIVE_WORDS = [
  'secret',
  'password',
  'key',
  'token',
  'credential',
  'pii',
  'customer',
  'private',
  'internal',
  'confidential',
  'auth',
  'payment',
  'invoice',
]

const REASONING_WORDS = [
  'architect',
  'design',
  'refactor',
  'strategy',
  'plan',
  'complex',
  'reason',
  'analyze',
  'migrate',
  'optimize',
  'debug',
  'investigate',
]

function extractKeywords(intent: string): string[] {
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
}

function classify(intent: string): { sensitivity: Sensitivity; reasoningLoad: number } {
  const lower = intent.toLowerCase()
  const sensitiveHits = SENSITIVE_WORDS.filter((w) => lower.includes(w)).length
  const reasoningHits = REASONING_WORDS.filter((w) => lower.includes(w)).length

  let sensitivity: Sensitivity = 'public'
  if (sensitiveHits >= 2) sensitivity = 'restricted'
  else if (sensitiveHits === 1) sensitivity = 'confidential'
  else if (/\b(uploader|api|service|server|repo|vault)\b/.test(lower)) sensitivity = 'internal'

  // reasoning load in 0..1 — longer, more "thinky" intents pull toward cloud.
  const lengthFactor = Math.min(intent.length / 120, 1)
  const reasoningLoad = Math.min(0.25 * reasoningHits + 0.4 * lengthFactor, 1)

  return { sensitivity, reasoningLoad }
}

function route(contract: TaskContract): RouteDecision {
  const sensitive =
    contract.sensitivity === 'confidential' || contract.sensitivity === 'restricted'

  // Sensitive data never leaves the machine — force local. Otherwise heavy reasoning goes cloud.
  if (sensitive) {
    return {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via Bifrost',
      reason: `${contract.sensitivity} data — kept on-device`,
      routeLabel: `${contract.sensitivity} → local · qwen2.5-coder`,
    }
  }

  if (contract.reasoningLoad >= 0.55) {
    // Alternate the two cloud models deterministically by keyword shape.
    const model: ModelId = contract.keywords.length % 2 === 0 ? 'claude-sonnet' : 'gemini-pro'
    return {
      target: 'cloud',
      model,
      via: 'via Bifrost',
      reason: 'high reasoning load — cloud frontier model',
      routeLabel: `${contract.sensitivity} → cloud · ${model}`,
    }
  }

  return {
    target: 'local',
    model: 'qwen2.5-coder',
    via: 'via Bifrost',
    reason: 'routine change — local model is enough',
    routeLabel: `${contract.sensitivity} → local · qwen2.5-coder`,
  }
}

// ---------- pathing / naming ----------

function writebackPath(intent: string): string {
  const slug =
    intent
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join('-') || 'task'
  return `notes/${slug}.md`
}

function agentTaskFile(intent: string): string {
  const noun = extractKeywords(intent)[0] ?? 'module'
  return `${noun}.ts`
}

// ---------- the run ----------

export async function runTask(
  intent: string,
  onEvent: (e: EngineEvent) => void,
  settings?: Settings,
): Promise<Verdict> {
  const seed = hashIntent(intent)
  const rand = makeRng(seed)
  const started = Date.now()

  // --- PLAN: build the Task Contract ---
  const { sensitivity, reasoningLoad } = classify(intent)
  const contract: TaskContract = {
    id: `A-${++taskCounter}`,
    intent,
    sensitivity,
    keywords: extractKeywords(intent),
    reasoningLoad,
    createdAt: started,
  }
  onEvent({ type: 'contract', contract })
  onEvent({ type: 'assistant', line: `Parsed intent → Task Contract #${contract.id}.` })
  await delay(320 + rand() * 240)

  // --- ROUTE ---
  const decision = route(contract)
  onEvent({ type: 'route', decision })
  onEvent({ type: 'assistant', line: `Routed ${decision.routeLabel} — ${decision.reason}.` })
  await delay(340 + rand() * 260)

  // --- EXECUTE: an implementer agent progresses through states ---
  const taskFile = agentTaskFile(intent)
  const budgetIn = Math.round(380 + intent.length * 6 + rand() * 500)
  const budgetOut = Math.round(180 + rand() * 320)
  const isCloud = decision.target === 'cloud'

  const agent: Agent = {
    id: `agent-${contract.id}`,
    role: 'implementer',
    model: decision.model,
    state: 'planning',
    task: taskFile,
    burn: 0,
    evalScore: 0,
    progress: 8,
  }
  onEvent({ type: 'agent', agent: { ...agent } })
  await delay(300 + rand() * 220)

  agent.state = 'executing'
  agent.burn = Math.round(budgetIn * 0.55)
  agent.progress = 46
  onEvent({ type: 'agent', agent: { ...agent } })
  onEvent({ type: 'assistant', line: `Implementing ${taskFile}…` })

  // EXECUTE: if the primary provider is reachable, fold its real narration in.
  // Any error/timeout returns null and we stay fully deterministic.
  const modelText = await callPrimaryModel(settings, intent)
  if (modelText) {
    onEvent({ type: 'assistant', line: modelText })
  }
  await delay(420 + rand() * 320)

  agent.state = 'verifying'
  agent.burn = budgetIn
  agent.progress = 74
  onEvent({ type: 'agent', agent: { ...agent } })
  await delay(360 + rand() * 260)

  // --- TIER 1: deterministic, 0 tokens. Occasionally fails and short-circuits. ---
  const totalTests = 10 + (seed % 9) // 10..18
  const tier1Fails = seed % 7 === 0
  const passedTests = tier1Fails ? Math.max(1, totalTests - (1 + (seed % 3))) : totalTests
  const tier1: Tier1Result = {
    tests: `${passedTests}/${totalTests}`,
    lint: !tier1Fails,
    build: true,
    pass: !tier1Fails,
  }
  onEvent({ type: 'tier1', result: tier1 })
  await delay(340 + rand() * 220)

  const tokensIn = budgetIn
  const tokensOut = budgetOut
  const modelRoute = `${tokensIn.toLocaleString()} tok in / ${tokensOut} out`

  // cloud frontier pricing vs near-free local inference (Bifrost).
  const cost = isCloud
    ? (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15
    : (tokensIn + tokensOut) / 1_000_000 * 0.12
  const costRounded = Math.max(0.001, Math.round(cost * 1000) / 1000)
  const durationMs = Date.now() - started + Math.round(1200 + rand() * 3200)

  if (tier1Fails) {
    // Short-circuit: no Tier 2, agent blocks, verdict fails.
    agent.state = 'blocked'
    agent.progress = 74
    onEvent({ type: 'agent', agent: { ...agent } })
    onEvent({
      type: 'assistant',
      line: `Tier 1 failed (${tier1.tests} tests) — short-circuited before Tier 2. Nothing written back.`,
    })

    const failedVerdict: Verdict = {
      taskId: contract.id,
      task: intent,
      route: decision,
      tier1,
      tier2: { evalScore: 0, passed: false, judge: 'DeepEval judge', trajectory: 'not run' },
      tokensIn,
      tokensOut,
      cost: costRounded,
      durationMs,
      modelRoute,
      hooks: { blocked: 1, passed: false },
      writeback: { path: writebackPath(intent), validated: false, committed: false },
      passed: false,
    }
    await delay(300)
    onEvent({ type: 'verdict', verdict: failedVerdict })
    return failedVerdict
  }

  // --- TIER 2: LLM-judge eval ---
  const evalScore = Math.round((0.82 + rand() * 0.16) * 100) / 100 // 0.82..0.98
  const tier2: Tier2Result = {
    evalScore,
    passed: evalScore >= 0.7,
    judge: 'DeepEval judge',
    trajectory: 'trajectory ok',
  }
  onEvent({ type: 'tier2', result: tier2 })
  await delay(340 + rand() * 240)

  // --- WRITE-BACK ---
  const writeback = { path: writebackPath(intent), validated: true, committed: true }
  onEvent({ type: 'writeback', writeback })

  agent.state = 'done'
  agent.evalScore = evalScore
  agent.progress = 100
  onEvent({ type: 'agent', agent: { ...agent } })
  await delay(280 + rand() * 200)

  const verdict: Verdict = {
    taskId: contract.id,
    task: intent,
    route: decision,
    tier1,
    tier2,
    tokensIn,
    tokensOut,
    cost: costRounded,
    durationMs,
    modelRoute,
    hooks: { blocked: 0, passed: true },
    writeback,
    passed: true,
  }
  onEvent({
    type: 'assistant',
    line: `Verified (eval ${evalScore.toFixed(2)}) and wrote back to ${writeback.path}. $${costRounded.toFixed(3)}.`,
  })
  onEvent({ type: 'verdict', verdict })
  return verdict
}
