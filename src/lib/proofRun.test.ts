import { describe, expect, it } from 'vitest'
import {
  PROOF_BUDGET,
  PROOF_TOOL_TURNS,
  PROOF_WEB_URL,
  gradeProof,
  proofCapabilities,
  proofIntent,
} from './proofRun'
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'

const RUN = 'run-proof-1'
const REFUSED = '[rejected:local:gemma-3] provider refused the request (HTTP 401): API key required'

function verdict(response: string): Verdict {
  return { taskId: 't', task: 'proof', passed: true, outcome: 'replied', response } as unknown as Verdict
}

function toolSpan(tool: string, attrs: Record<string, unknown> = {}, runId = RUN): EngineSpan {
  return {
    name: 'tool_exec', type: 'tool_exec', status: 'ok', start: 2, duration_ms: 50, run_id: runId,
    attrs: { agent: 'compliance-checker', round: 'proof', tool, ...attrs },
  }
}

describe('proofRun — the fixed prompt, the arguments, an honest grade', () => {
  it('the prompt is fixed and names the agent', () => {
    expect(proofIntent('Compliance checker', 'checks proposals against the never-touch list'))
      .toBe('Say hello in one sentence and name yourself: you are Compliance checker, checks proposals against the never-touch list.')
  })

  it('the prompt ASKS for each granted tool — the engine calls a tool only when the model asks', () => {
    const p = proofIntent('Checker', 'checks', ['vault', 'web', 'tools'])
    expect(p.startsWith('Say hello in one sentence and name yourself: you are Checker, checks.')).toBe(true)
    expect(p).toContain('vault tool to list the top-level folders')
    expect(p).toContain('fetch https://example.com/')
    expect(p).toContain('list the tools your MCP servers offer')
    expect(proofIntent('Checker', 'checks', ['vault'])).not.toContain('example.com')
    expect(proofIntent('Checker', 'checks', ['terminal'])).toBe('Say hello in one sentence and name yourself: you are Checker, checks.')
  })

  it('only vault, web and MCP tools are exercised by a proof — never terminal, computer or writes', () => {
    expect(proofCapabilities(['vault', 'web', 'terminal', 'computer', 'writes', 'tools'])).toBe('vault,web,tools')
    expect(proofCapabilities([])).toBe('')
  })

  it('budget and turns are the design’s numbers', () => {
    expect(PROOF_BUDGET).toBe(400)
    expect(PROOF_TOOL_TURNS).toBe(1)
    expect(PROOF_WEB_URL).toBe('https://example.com/')
  })

  it('a real answer plus every granted tool called → proven', () => {
    const r = gradeProof(verdict('Hello — I am the Compliance checker.'), [toolSpan('vault_list', { path: '/' }), toolSpan('web_fetch', { url: PROOF_WEB_URL })], RUN, ['vault', 'web'], 1000)
    expect(r.proven).toBe(true)
    expect(r.at).toBe(1000)
    expect(r.reason).toBe('')
    expect(r.lines.map((l) => [l.kind, l.ok])).toEqual([['model', true], ['tool', true], ['tool', true]])
  })

  it('a stand-in reply is unproven with the gateway’s cause, whatever the tools did', () => {
    const r = gradeProof(verdict(REFUSED), [toolSpan('vault_list')], RUN, ['vault'], 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[0]).toMatchObject({ kind: 'model', ok: false })
    expect(r.lines[0].detail).toContain('HTTP 401')
    expect(r.reason).toContain('HTTP 401')
  })

  it('a granted tool that was never called is unproven and says so', () => {
    const r = gradeProof(verdict('Hello.'), [], RUN, ['vault'], 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[1]).toMatchObject({ kind: 'tool', ok: false, detail: 'vault was not called' })
    expect(r.reason).toBe('vault was not called')
  })

  it('a blocked or failed tool call is not a proof', () => {
    const r = gradeProof(verdict('Hello.'), [toolSpan('vault_list', { blocked: true })], RUN, ['vault'], 1000)
    expect(r.proven).toBe(false)
    expect(r.lines[1].ok).toBe(false)
  })

  it('spans from another run never count', () => {
    const r = gradeProof(verdict('Hello.'), [toolSpan('vault_list', {}, 'some-other-run')], RUN, ['vault'], 1000)
    expect(r.proven).toBe(false)
  })

  it('no verdict at all is unproven: the engine did not finish', () => {
    const r = gradeProof(null, [], RUN, [], 1000)
    expect(r.proven).toBe(false)
    expect(r.reason).toBe('the engine did not finish')
  })
})
