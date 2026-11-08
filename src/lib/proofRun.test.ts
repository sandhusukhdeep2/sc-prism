import { describe, expect, it } from 'vitest'
import {
  PROOF_MAX_TOKENS,
  PROOF_WEB_URL,
  gradeProof,
  proofCapabilities,
  proofIntent,
  proofToolTurns,
} from './proofRun'
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'

const TASK = 'task-proof-1'
const REFUSED = '[rejected:local:gemma-3] provider refused the request (HTTP 401): API key required'

function verdict(response: string, models_used: string[] = ['local · gemma-3']): Verdict {
  return { taskId: TASK, task: 'proof', passed: true, outcome: 'replied', response, native: { models_used } } as unknown as Verdict
}

// The engine stamps spans with ITS OWN run id; the client never knows it. A
// run's spans are found through its root span's task_id (spansForTask).
const ROOT: EngineSpan = { name: 'run:proof', type: 'run', status: 'ok', start: 1, span_id: 'root-1', run_id: 'engine-uuid-1', attrs: { task_id: TASK } }
function toolSpan(tool: string, attrs: Record<string, unknown> = {}, runId = 'engine-uuid-1'): EngineSpan {
  return {
    name: 'tool_exec', type: 'tool_exec', status: 'ok', start: 2, duration_ms: 50, run_id: runId, span_id: `t-${tool}-${runId}`, parent_id: 'root-1',
    attrs: { agent: 'compliance-checker', round: 'proof', tool, ...attrs },
  }
}
const withRoot = (...spans: EngineSpan[]) => [ROOT, ...spans]

describe('proofRun — the fixed prompt, the arguments, an honest grade', () => {
  it('the prompt is fixed and names the agent', () => {
    expect(proofIntent('Compliance checker', 'checks proposals against the never-touch list'))
      .toBe('Say hello in one sentence and name yourself: you are Compliance checker, checks proposals against the never-touch list.')
  })

  it('the prompt asks for the tool calls FIRST and the greeting last — the engine runs a tool only when a reply is nothing but the call', () => {
    const p = proofIntent('Checker', 'checks', ['vault', 'web'])
    expect(p.indexOf('vault tool')).toBeLessThan(p.indexOf('say hello'))
    expect(p.indexOf('https://example.com/')).toBeLessThan(p.indexOf('say hello'))
    expect(p).toContain('you are Checker, checks')
    expect(proofIntent('Checker', 'checks', ['vault'])).not.toContain('example.com')
    expect(proofIntent('Checker', 'checks', ['terminal'])).toBe('Say hello in one sentence and name yourself: you are Checker, checks.')
  })

  it('only vault and web are exercised by a proof — MCP tools are not reachable on a solo run; terminal, computer and writes never', () => {
    expect(proofCapabilities(['vault', 'web', 'terminal', 'computer', 'writes', 'tools'])).toBe('vault,web')
    expect(proofCapabilities([])).toBe('')
  })

  it('the output cap is 400 and the tool turns match the grants', () => {
    expect(PROOF_MAX_TOKENS).toBe(400)
    expect(proofToolTurns([])).toBe(1)
    expect(proofToolTurns(['vault', 'web', 'terminal'])).toBe(2)
    expect(PROOF_WEB_URL).toBe('https://example.com/')
  })

  it('a real answer plus every granted tool called → proven', () => {
    const r = gradeProof(verdict('Hello — I am the Compliance checker.'), withRoot(toolSpan('vault_list', { path: '/' }), toolSpan('web_fetch', { url: PROOF_WEB_URL })), ['vault', 'web'], 'local', 1000)
    expect(r.proven).toBe(true)
    expect(r.at).toBe(1000)
    expect(r.reason).toBe('')
    expect(r.lines.map((l) => [l.kind, l.ok])).toEqual([['model', true], ['tool', true], ['tool', true]])
  })

  it('a stand-in reply is unproven with the gateway’s cause, whatever the tools did', () => {
    const r = gradeProof(verdict(REFUSED), withRoot(toolSpan('vault_list')), ['vault'], 'local', 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[0]).toMatchObject({ kind: 'model', ok: false })
    expect(r.lines[0].detail).toContain('HTTP 401')
    expect(r.reason).toContain('HTTP 401')
  })

  it('a granted tool that was never called is unproven and says so', () => {
    const r = gradeProof(verdict('Hello.'), withRoot(), ['vault'], 'local', 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[1]).toMatchObject({ kind: 'tool', ok: false, detail: 'vault was not called' })
    expect(r.reason).toBe('vault was not called')
  })

  it('a blocked or failed tool call is not a proof', () => {
    const r = gradeProof(verdict('Hello.'), withRoot(toolSpan('vault_list', { blocked: true, reason: 'path outside the vault' })), ['vault'], 'local', 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[1].ok).toBe(false)
    expect(r.lines[1].detail).toBe('vault: path outside the vault') // the span's own reason, not a bare 'blocked'
  })

  it('spans from another run never count — the run is found by its task_id, never by a client id', () => {
    const other: EngineSpan = { ...toolSpan('vault_list', {}, 'engine-uuid-2'), parent_id: 'root-2' }
    const r = gradeProof(verdict('Hello.'), [ROOT, other], ['vault'], 'local', 1000)
    expect(r.proven).toBe(false)
  })

  it('a failed web call carries the span’s error', () => {
    const r = gradeProof(verdict('Hello.'), withRoot(toolSpan('web_fetch', { is_error: true, error: 'HTTP 503 from example.com' })), ['web'], 'local', 1000)
    expect(r.lines[1].detail).toBe('web: HTTP 503 from example.com')
  })

  it('an answer from the wrong brand is not proof of this agent’s model', () => {
    const r = gradeProof(verdict('Hello, I am Planner.', ['local · gemma-3']), withRoot(), [], 'claude', 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[0].detail).toBe('answered on local · gemma-3 — not on claude')
  })

  it('a claude agent proven through the claude CLI counts as its brand', () => {
    const r = gradeProof(verdict('Hello.', ['claude-cli · opus']), withRoot(), [], 'claude', 1000)
    expect(r.proven).toBe(true)
  })

  it('no verdict at all is unproven: the engine did not finish', () => {
    const r = gradeProof(null, [], [], 'local', 1000)
    expect(r.proven).toBe(false)
    expect(r.reason).toBe('the engine did not finish')
  })
})
