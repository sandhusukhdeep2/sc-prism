import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VerdictCard, { type Verdict } from './VerdictCard'

const sample: Verdict = {
  task: 'add a rate-limit guard to the uploader',
  route: 'internal → local',
  routeVia: 'via Bifrost',
  model: 'qwen2.5-coder',
  tier1: '14/14 · lint ok · build ok',
  tier2: 'eval 0.91 · DeepEval judge',
  hooks: '0 blocked',
  cost: '$0.004',
  writeback: 'notes/uploader.md',
  passed: true,
}

function renderCard(v: Verdict) {
  // VerdictCard is a react-router <Link>, so it needs a Router in context.
  return render(
    <MemoryRouter>
      <VerdictCard v={v} />
    </MemoryRouter>,
  )
}

describe('VerdictCard', () => {
  it('renders the Route / Model / Tier 1 / Tier 2 / Cost rows', () => {
    renderCard(sample)
    expect(screen.getByText('Route')).toBeInTheDocument()
    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('Tier 1')).toBeInTheDocument()
    expect(screen.getByText('Tier 2')).toBeInTheDocument()
    expect(screen.getByText('Cost')).toBeInTheDocument()

    // A couple of the values, to prove the rows carry the payload.
    expect(screen.getByText('qwen2.5-coder')).toBeInTheDocument()
    expect(screen.getByText(/14\/14/)).toBeInTheDocument()
  })

  it('shows the PASSED badge for a passing verdict', () => {
    renderCard(sample)
    expect(screen.getByText(/PASSED/)).toBeInTheDocument()
  })

  it('hides the PASSED badge when passed is false', () => {
    renderCard({ ...sample, passed: false })
    expect(screen.queryByText(/PASSED/)).not.toBeInTheDocument()
  })
})
