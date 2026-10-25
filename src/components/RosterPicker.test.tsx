// The picker exists to close a real gap: Sukhdeep created seven agents over six
// weeks and not one ever took a seat, because no surface put a library agent
// into the roster string. These assert what the CONTROL RENDERS and what it
// hands back — not what a store holds.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import RosterPicker from './RosterPicker'
import type { StoredAgent } from '../lib/agents'

const agent = (over: Partial<StoredAgent>): StoredAgent =>
  ({
    id: over.name ?? 'a',
    name: 'archivist',
    role: 'filing',
    model: 'local',
    enabled: true,
    assignedTo: '',
    ...over,
  }) as StoredAgent

// His real library, in miniature: two on the local model, one on Claude, one on
// Gemini (which is switched off on this Mac), one disabled.
const LIBRARY = [
  agent({ id: '1', name: 'archivist', model: 'local' }),
  agent({ id: '2', name: 'auditor', model: 'local' }),
  agent({ id: '3', name: 'compliance-checker', model: 'claude' }),
  agent({ id: '4', name: 'Researcher', model: 'gemini' }),
  agent({ id: '5', name: 'janitor', model: 'local', enabled: false }),
]

// Gemini cannot answer on this machine; everything else can.
const gate = (token: string) => (token.includes('gemini') ? 'Gemini is switched off in Settings' : '')

const draw = (value = '', onChange = vi.fn()) => {
  render(<RosterPicker agents={LIBRARY} gate={gate} value={value} onChange={onChange} />)
  return onChange
}

describe('the picker offers the library he really built', () => {
  it('lists every agent by name, with the model it runs on', () => {
    draw()
    expect(screen.getByText('archivist')).toBeInTheDocument()
    expect(screen.getByText('compliance-checker')).toBeInTheDocument()
    expect(screen.getAllByText('local').length).toBeGreaterThan(0)
  })

  it('an agent that CANNOT play is shown disabled with its reason — never silently missing', () => {
    draw()
    // Present…
    expect(screen.getByText('Researcher')).toBeInTheDocument()
    // …disabled…
    const box = screen.getByText('Researcher').closest('label')!.querySelector('input')!
    expect(box.disabled).toBe(true)
    // …and the reason is on screen BEFORE any launch.
    expect(screen.getByText(/Gemini is switched off in Settings/)).toBeInTheDocument()
  })

  it('a switched-off agent says that is why it sits out', () => {
    draw()
    // Scoped to the janitor's own row: "switched off" also appears in the
    // Gemini reason, and an unscoped match would pass on the wrong agent.
    const row = screen.getByText('janitor').closest('.rpick__seat')!
    expect(row.textContent).toMatch(/sits out — switched off/)
    expect(row.querySelector('input')!.disabled).toBe(true)
  })

  it('says how many can actually play, not how many exist', () => {
    draw()
    // 5 in the library, 3 that can take a seat (gemini out, disabled out).
    expect(screen.getByText('nobody picked — 3 available')).toBeInTheDocument()
  })
})

describe('picking composes the roster string the engine really receives', () => {
  it('a checked seat becomes <slug>:<token>', () => {
    const onChange = draw('')
    fireEvent.click(screen.getByText('archivist').closest('label')!.querySelector('input')!)
    expect(onChange).toHaveBeenCalledWith('archivist:local')
  })

  it('two seats compose in the library’s own order', () => {
    const onChange = draw('auditor:local')
    fireEvent.click(screen.getByText('archivist').closest('label')!.querySelector('input')!)
    expect(onChange).toHaveBeenCalledWith('archivist:local,auditor:local')
  })

  it('unchecking removes exactly that seat', () => {
    const onChange = draw('archivist:local,auditor:local')
    fireEvent.click(screen.getByText('auditor').closest('label')!.querySelector('input')!)
    expect(onChange).toHaveBeenCalledWith('archivist:local')
  })

  it('an existing roster string shows as ticked seats', () => {
    draw('compliance-checker:claude')
    const box = screen.getByText('compliance-checker').closest('label')!.querySelector('input')!
    expect(box.checked).toBe(true)
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
  })
})

describe('a typed name that matches nobody is called out', () => {
  it('names it, and says the engine will role-play it anyway', () => {
    draw('archivst:local')
    expect(screen.getByText(/no agent named “archivst”/)).toBeInTheDocument()
    expect(screen.getByText(/role-play the name anyway/)).toBeInTheDocument()
  })

  it('a correctly spelled agent raises no warning', () => {
    draw('archivist:local')
    expect(screen.queryByText(/no agent named/)).not.toBeInTheDocument()
  })
})

describe('an empty library says so plainly', () => {
  it('does not render an empty control that looks broken', () => {
    render(<RosterPicker agents={[]} gate={gate} value="" onChange={vi.fn()} />)
    expect(screen.getByText(/your library is empty — create an agent/)).toBeInTheDocument()
  })
})
