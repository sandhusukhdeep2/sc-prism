import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Stepper, { SETUP_STEPS } from './Stepper'

// THE MISSING STEP (2026-08-28, Sukhdeep's wizard walk): the flow has a real
// Companion page between Providers and Vault, but the bar drew five dots
// without it — and the Companion page's own (private, duplicated) stepper
// hardcoded "Vault" as active while you stood on Companion. A map that
// misplaces you is worse than no map.
describe('the setup stepper names every page the flow actually visits', () => {
  it('Companion is a real step, between Providers and Vault', () => {
    expect(SETUP_STEPS).toEqual(['Providers', 'Companion', 'Vault', 'Grants', 'Interview', 'Review'])
  })

  it('standing on Companion shows Companion active — never a neighbour', () => {
    render(<Stepper active={1} />)
    const companion = screen.getByText('Companion')
    expect(companion.className).toContain('step__item--active')
    expect(screen.getByText('Providers').className).toContain('step__item--done')
    expect(screen.getByText('Vault').className).toContain('step__item--todo')
  })
})
