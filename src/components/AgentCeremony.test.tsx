import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings'

// Making an agent is a ceremony that ends with proof (design 2026-11-08 §B).
// The engine is mocked at the one seam the ceremony uses — runNativeTask /
// newRunId / readSpansTail — so this proves the ceremony, not the engine.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  newRunId: vi.fn(() => 'run-proof-1'),
  runNativeTask: vi.fn(),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  cancelEngineRun: vi.fn(async () => {}),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})

const { default: AgentCeremony } = await import('./AgentCeremony')

const settings: Settings = { ...DEFAULT_SETTINGS, vaultPath: '/vault', providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, enabled: p.id === 'local' || p.id === 'claude-cli' })) }
const REAL = { taskId: 't', task: 'proof', passed: true, outcome: 'replied', response: 'Hello — I am Checker.', native: { models_used: ['local · gemma-3'] } }
const REFUSED = { ...REAL, response: '[rejected:local:gemma-3] provider refused the request (HTTP 401): API key required' }

function draw(over: Partial<Parameters<typeof AgentCeremony>[0]> = {}) {
  const onCreated = vi.fn()
  const onCancel = vi.fn()
  render(
    <AgentCeremony
      vaultPath="/vault"
      settings={settings}
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
  native.cancelEngineRun.mockClear()
})
afterEach(() => localStorage.clear())

describe('the ceremony', () => {
  it('says that the proof asks the agent to use each tool, so an ignored ask reads honestly', () => {
    draw()
    assemble({ model: 'local', tools: ['vault'] })
    expect(screen.getByText(/asks it to use each tool/)).toBeInTheDocument()
  })

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
    expect(intent).toContain('vault tool') // the proof asks for the tool calls first…
    expect(intent).toContain('say hello and name yourself: you are Checker, checks proposals.') // …and the greeting last
    expect(vault).toBe('/vault')
    expect(provs).toMatchObject({ agentName: 'checker', stage: 'proof', agentCapabilities: 'vault', maxTokens: 400, primary: 'local', tier1: '' })
    expect(String(provs.userCapabilities)).toContain('vault')
    expect(runId).toBe('run-proof-1')
    expect(route).toBe('local')
    expect(image).toBeUndefined()
    expect(budget).toBe(0) // an output cap, never a total budget that starves the tool loop
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

  it('Cancel while a proof runs tells the engine to stop that run', async () => {
    native.runNativeTask.mockReturnValue(new Promise(() => {}))
    const { onCancel } = draw()
    assemble({ model: 'local' })
    fireEvent.click(screen.getByRole('button', { name: 'Prove it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(native.cancelEngineRun).toHaveBeenCalledWith('run-proof-1'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('says MCP tools are not exercised by a proof', () => {
    draw()
    assemble({ model: 'local' })
    expect(screen.getAllByText(/MCP tools are not exercised/).length).toBeGreaterThan(0)
  })

  it('creating without proving is allowed and reads not yet proven', async () => {
    const { onCreated } = draw()
    assemble({ model: 'local' })
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0][0].proof).toBeUndefined()
  })
})
