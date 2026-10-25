import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import OrbView from './OrbView'
import { modelColor } from '../lib/modelColor'
import type { EngineSpan } from '../lib/nativeEngine'

const spans: EngineSpan[] = [
  {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    attrs: { agent: 'developer', provider: 'claude-cli', model: 'claude-code-subscription' },
  },
  {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    attrs: { agent: 'planner', provider: 'gemini', model: 'gemini-2.0-flash' },
  },
  {
    name: 'model_call',
    type: 'model_call',
    status: 'error',
    attrs: { agent: 'reviewer', provider: 'openai', model: 'gpt-4o' },
  },
]

describe('OrbView', () => {
  it('renders nothing when there are no model_call spans — honest empty, no fabricated orbs', () => {
    const { container } = render(<OrbView spans={[]} running={false} />)
    expect(container.querySelectorAll('*').length).toBe(0)
  })

  // The rail crew was a wrapping grid of blank 22px dots with the agent's name
  // truncated under each ("researc…") and a fat ring for its outcome, so a
  // failed agent read as a red ring around a green blob. It is a LIST now: one
  // row per coworker, with a monogram in its model's colour, its full name, the
  // AI that really answered it, and a pip for how it ended.
  it('gives every real agent a row with its name and the AI that answered it', () => {
    render(<OrbView spans={spans} running={false} />)
    expect(screen.getByText('developer')).toBeInTheDocument()
    expect(screen.getByText('planner')).toBeInTheDocument()
    expect(screen.getByText('reviewer')).toBeInTheDocument()
    expect(screen.getByText('claude-code-subscription')).toBeInTheDocument()
    expect(document.querySelectorAll('.orbview__seat').length).toBe(3)
  })

  it('colors each monogram by its model via the shared modelColor language', () => {
    render(<OrbView spans={spans} running={false} />)
    const dev = screen.getByText('developer').closest('.orbview__seat')?.querySelector('.orbview__mono') as HTMLElement
    const plan = screen.getByText('planner').closest('.orbview__seat')?.querySelector('.orbview__mono') as HTMLElement
    expect(dev.style.background).toBeTruthy()
    expect(dev.style.background).not.toBe(plan.style.background)
    const probe = document.createElement('div')
    probe.style.background = modelColor('claude-cli · claude-code-subscription')
    expect(dev.style.background).toBe(probe.style.background)
  })

  it('marks how each agent ENDED with a pip, not a ring around its own colour', () => {
    render(<OrbView spans={spans} running={false} />)
    expect(document.querySelectorAll('.orbview__pip--failed').length).toBe(1)
    expect(document.querySelectorAll('.orbview__pip--ok').length).toBe(2)
  })

  it('an IN-FLIGHT agent is never painted as passed or failed', () => {
    const inflight: EngineSpan[] = [
      { name: 'model_call', type: 'model_call', status: 'running', attrs: { agent: 'developer', provider: 'claude-cli', model: 'x' } },
    ]
    render(<OrbView spans={inflight} running={true} />)
    expect(document.querySelectorAll('.orbview__pip--ok').length).toBe(0)
    expect(document.querySelectorAll('.orbview__pip--failed').length).toBe(0)
    expect(document.querySelectorAll('.orbview__pip--running').length).toBe(1)
  })

  it('nothing breathes when the run is not live', () => {
    // Same open span, run not live: the monogram must not glow.
    const inflight: EngineSpan[] = [
      { name: 'model_call', type: 'model_call', status: 'running', attrs: { agent: 'developer', provider: 'claude-cli', model: 'x' } },
    ]
    render(<OrbView spans={inflight} running={false} />)
    expect(document.querySelectorAll('.orbview__mono.is-live').length).toBe(0)
  })

  it('breathes only for an agent whose own span is open under a live run', () => {
    const inflight: EngineSpan[] = [
      { name: 'model_call', type: 'model_call', status: 'running', attrs: { agent: 'developer', provider: 'claude-cli', model: 'x' } },
      { name: 'model_call', type: 'model_call', status: 'ok', attrs: { agent: 'planner', provider: 'gemini', model: 'y' } },
    ]
    render(<OrbView spans={inflight} running={true} />)
    // The finished agent does not glow just because the run is live.
    expect(document.querySelectorAll('.orbview__mono.is-live').length).toBe(1)
  })

  it('opens that ONE coworker’s file when its row is clicked', () => {
    render(<OrbView spans={spans} running={false} />)
    fireEvent.click(screen.getByRole('button', { name: /What developer is doing/i }))
    const panel = screen.getByRole('dialog', { name: /What developer is doing/i })
    expect(panel.textContent).toMatch(/claude-cli · claude-code-subscription/)
    expect(panel.textContent).not.toMatch(/gemini/)
  })

  it('opens the full-screen command view on expand, and closes it on the close button', () => {
    render(<OrbView spans={spans} running={false} />)
    expect(document.querySelector('.orbview__overlay')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(document.querySelector('.orbview__overlay')).not.toBeNull()
    expect(screen.getByText('Live command view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(document.querySelector('.orbview__overlay')).toBeNull()
  })

  it('closes the overlay on Escape', () => {
    render(<OrbView spans={spans} running={false} />)
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(document.querySelector('.orbview__overlay')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.orbview__overlay')).toBeNull()
  })
})
