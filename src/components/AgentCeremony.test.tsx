import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EngineProviders } from '../lib/nativeEngine'

// Making an agent is a ceremony that ends with proof (design 2026-11-08 §B).
// The engine is mocked at the one seam the ceremony uses — runNativeTask /
// newRunId / readSpansTail — so this proves the ceremony, not the engine.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  newRunId: vi.fn(() => 'run-proof-1'),
  runNativeTask: vi.fn(),
  readSpansTail: vi.fn(async () => [] as unknown[]),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})

const { default: AgentCeremony } = await import('./AgentCeremony')

const providers = { baseUrl: 'http://127.0.0.1:8000', primary: 'local' } as unknown as EngineProviders
const REAL = { taskId: 't', task: 'proof', passed: true, outcome: 'replied', response: 'Hello — I am Checker.' }
const REFUSED = { ...REAL, response: '[rejected:local:gemma-3] provider refused the request (HTTP 401): API key required' }

function draw(over: Partial<Parameters<typeof AgentCeremony>[0]> = {}) {
  const onCreated = vi.fn()
  const onCancel = vi.fn()
  render(
    <AgentCeremony
      vaultPath="/vault"
      providers={providers}
      seatGate={() => ''}
      projectId="p1"
      onCreated={onCreated}
      onCancel={onCancel}
      {...over}
    />,
  )
  return { onCreated, onCancel }
}

/** Walk the four parts with the given choices. */
function assemble(opts: { model?: 'local' | 'claude' | 'gemini'; tools?: string[] } = {}) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Checker' } })
  fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'checks proposals' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm name & role' }))
  if (opts.model) fireEvent.click(screen.getByLabelText(opts.model === 'local' ? 'local model' : opts.model))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm which AI' }))
  for (const t of opts.tools ?? []) fireEvent.click(screen.getByLabelText(`may use ${t}`))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm what it may use' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm what it knows' }))
}

beforeEach(() => {
  localStorage.clear()
  native.runNativeTask.mockReset()
  native.readSpansTail.mockReset().mockResolvedValue([])
})
afterEach(() => localStorage.clear())

describe('the ceremony', () => {
  it('assembles the card part by part, in order', () => {
    draw()
    expect(screen.queryByRole('button', { name: 'Confirm which AI' })).toBeNull()
    assemble({ model: 'local', tools: ['vault'] })
    const card = screen.getByTestId('ceremony-card')
    expect(card).toHaveTextContent('Checker')
    expect(card).toHaveTextContent('checks proposals')
    expect(card).toHaveTextContent('local')
    expect(card).toHaveTextContent('vault')
  })

  it('on a local model, Prove it runs ONE budgeted proof attributed to the new agent', async () => {
    native.runNativeTask.mockResolvedValue(REAL)
    draw()
    assemble({ model: 'local', tools: ['vault'] })
    fireEvent.click(screen.getByRole('button', { name: 'Prove it' }))
    await waitFor(() => expect(native.runNativeTask).toHaveBeenCalledTimes(1))
    const [intent, vault, provs, runId, route, image, budget, turns, mode] = native.runNativeTask.mock.calls[0]
    expect(intent).toBe('Say hello in one sentence and name yourself: you are Checker, checks proposals.')
    expect(vault).toBe('/vault')
    expect(provs).toMatchObject({ agentName: 'checker', stage: 'proof', agentCapabilities: 'vault' })
    expect(runId).toBe('run-proof-1')
    expect(route).toBe('local')
    expect(image).toBeUndefined()
    expect(budget).toBe(400)
    expect(turns).toBe(1)
    expect(mode).toBe('converse')
  })

  it('a cloud model says what proving costs and never runs on Create', async () => {
    draw()
    assemble({ model: 'claude', tools: [] })
    expect(screen.getByRole('button', { name: 'Prove on claude · costs cents' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    expect(native.runNativeTask).not.toHaveBeenCalled()
  })

  it('Create is disabled while a proof is running', async () => {
    let finish: (v: unknown) => void = () => {}
    native.runNativeTask.mockReturnValue(new Promise((r) => (finish = r)))
    draw()
    assemble({ model: 'local' })
    fireEvent.click(screen.getByRole('button', { name: 'Prove it' }))
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeDisabled()
    finish(REAL)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled())
  })

  it('a real answer shows proven, and Create stores the proof and the tools', async () => {
    native.runNativeTask.mockResolvedValue(REAL)
    const { onCreated } = draw()
    assemble({ model: 'local', tools: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Prove it' }))
    await screen.findByText(/proven ✓/)
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const agent = onCreated.mock.calls[0][0]
    expect(agent.name).toBe('Checker')
    expect(agent.proof).toMatchObject({ proven: true, reason: '' })
    expect(agent.assignedTo).toBe('p1')
  })

  it('a refused answer shows unproven with the engine’s cause — and still creates', async () => {
    native.runNativeTask.mockResolvedValue(REFUSED)
    const { onCreated } = draw()
    assemble({ model: 'local' })
    fireEvent.click(screen.getByRole('button', { name: 'Prove it' }))
    await screen.findByText(/unproven — local refused the request/)
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0][0].proof).toMatchObject({ proven: false })
    expect(onCreated.mock.calls[0][0].proof.reason).toContain('HTTP 401')
  })

  it('creating without proving is allowed and reads not yet proven', async () => {
    const { onCreated } = draw()
    assemble({ model: 'local' })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0][0].proof).toBeUndefined()
  })
})
