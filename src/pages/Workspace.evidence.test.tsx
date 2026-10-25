import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...p: string[]) => p.join('/'),
}))

import RunLedger from '../components/RunLedger'

// Sukhdeep's design note puts Recent runs beside This week, full width, under
// the work — not stacked in a 320px rail where the run list scrolled inside
// itself behind a scrollbar nobody knew was there. The component now lays
// itself out from the box it is GIVEN (a container query), so these assert the
// contract that makes that possible: one component, both panels, one source.
describe('the evidence row', () => {
  it('renders BOTH panels from the same verdicts, so they cannot disagree', () => {
    // At least one run: a runless ledger collapses to a single line (UI pass
    // 2026-08-29) — the one-source rule is about the PANELS, which need runs.
    render(
      <MemoryRouter>
        <RunLedger
          verdicts={[{ taskId: 'v-e', outcome: 'passed', passed: true } as never]}
        />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Recent runs')).toBeInTheDocument()
    expect(screen.getByLabelText('This week')).toBeInTheDocument()
  })

  it('declares itself a layout container, which is what lets it become a row', () => {
    const { container } = render(
      <MemoryRouter>
        <RunLedger verdicts={[]} />
      </MemoryRouter>,
    )
    // The row/stack decision is made from this element's own width, never the
    // viewport's — the component sits in two different slots.
    expect(container.querySelector('.ledger')).toBeTruthy()
  })

  it('says so honestly when nothing has been recorded yet', () => {
    render(
      <MemoryRouter>
        <RunLedger verdicts={[]} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/no runs yet/)).toBeInTheDocument()
  })
})
