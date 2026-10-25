import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  getInterview,
  resetInterview,
  setInterview,
  SIGNOFFS,
  useInterview,
} from './interview'

const STORAGE_KEY = 'scprism.interview'

afterEach(() => {
  resetInterview()
  localStorage.clear()
})

// Probe that surfaces the store values and exposes actions to mutate them.
function Probe() {
  const { interview, toggleRole, movePriority, toggleSignoff, addTag, removeTag } = useInterview()
  return (
    <div>
      <span data-testid="roles">{interview.roles.join(',')}</span>
      <span data-testid="priorities">{interview.priorities.join(',')}</span>
      <span data-testid="signoffs">{interview.signoffs.join(',')}</span>
      <span data-testid="tags">{interview.neverTouch.join(',')}</span>
      <button onClick={() => toggleRole('admin')}>toggle-admin</button>
      <button onClick={() => movePriority('cost', -1)}>promote-cost</button>
      <button onClick={() => toggleSignoff('change-perms')}>toggle-perms</button>
      <button onClick={() => addTag('  /etc/passwd  ')}>add-tag</button>
      <button onClick={() => removeTag('/secrets')}>remove-secrets</button>
    </div>
  )
}

describe('interview store', () => {
  it('seeds sensible defaults', () => {
    const s = getInterview()
    expect(s.roles).toContain('developer')
    expect(s.priorities).toHaveLength(3)
    expect(s.signoffs.length).toBeGreaterThan(0)
    expect(s.neverTouch).toContain('/secrets')
  })

  it('persists a patch to localStorage', () => {
    setInterview({ business: 'hello world' })
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).business).toBe('hello world')
  })

  it('resetInterview restores defaults and clears storage', () => {
    setInterview({ roles: [] })
    resetInterview()
    expect(getInterview().roles).toContain('developer')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('adaptive Q&A persists like every other answer (stays local)', () => {
    setInterview({
      adaptive: [{ q: 'What slows you down?', a: 'invoicing', model: 'local · qwen', local: true }],
    })
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string)
    expect(raw.adaptive).toEqual([
      { q: 'What slows you down?', a: 'invoicing', model: 'local · qwen', local: true },
    ])
    resetInterview()
    expect(getInterview().adaptive).toEqual([])
  })
})

describe('useInterview hook actions', () => {
  it('toggles a role, reorders priorities, gates and tags', () => {
    render(<Probe />)

    act(() => screen.getByText('toggle-admin').click())
    expect(screen.getByTestId('roles')).toHaveTextContent('admin')

    act(() => screen.getByText('promote-cost').click())
    // cost started 3rd (speed,cost,compliance) → promoting swaps it up one
    expect(screen.getByTestId('priorities').textContent?.startsWith('cost')).toBe(true)

    const before = screen.getByTestId('signoffs').textContent ?? ''
    act(() => screen.getByText('toggle-perms').click())
    expect(screen.getByTestId('signoffs')).toHaveTextContent('change-perms')
    expect(before).not.toContain('change-perms')

    act(() => screen.getByText('add-tag').click())
    // trimmed before storing
    expect(screen.getByTestId('tags')).toHaveTextContent('/etc/passwd')

    act(() => screen.getByText('remove-secrets').click())
    expect(screen.getByTestId('tags').textContent).not.toContain('/secrets')
  })

  it('every SIGNOFF has a distinct gate label', () => {
    const gates = new Set(SIGNOFFS.map((s) => s.gate))
    expect(gates.size).toBe(SIGNOFFS.length)
  })
})
