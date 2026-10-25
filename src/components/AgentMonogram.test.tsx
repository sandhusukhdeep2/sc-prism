// The face has to MEAN something: the model it runs on, and whether it can run
// at all. It replaced a spectral orb picked by hashing the agent's name, which
// made a dead seat look exactly as alive as a working one.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import AgentMonogram, { monogram } from './AgentMonogram'
import { modelColor } from '../lib/modelColor'

/** jsdom normalises a hex background to rgb(), so compare like for like. */
const asRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

describe('monogram initials', () => {
  it('one word gives one letter', () => {
    expect(monogram('archivist')).toBe('A')
  })
  it('a two-word name gives first and last initial', () => {
    expect(monogram('compliance checker')).toBe('CC')
  })
  it('a slashed or hyphenated name splits the same way', () => {
    expect(monogram('Reviewer / Verifier')).toBe('RV')
    expect(monogram('test-writer')).toBe('TW')
  })
  it('an empty name never renders a blank disc', () => {
    expect(monogram('   ')).toBe('?')
  })
})

describe('the disc carries the model, and idleness', () => {
  it('wears the colour of the model it runs on', () => {
    const { container } = render(<AgentMonogram name="archivist" model="local" />)
    const el = container.querySelector('.amono') as HTMLElement
    expect(el.style.background).toBe(asRgb(modelColor('local')))
    expect(el.className).not.toContain('amono--idle')
  })

  it('two agents on DIFFERENT models never wear the same colour', () => {
    const { container: a } = render(<AgentMonogram name="one" model="local" />)
    const { container: b } = render(<AgentMonogram name="two" model="claude" />)
    const colour = (c: Element) => (c.querySelector('.amono') as HTMLElement).style.background
    expect(colour(a)).not.toBe(colour(b))
  })

  it('an agent that cannot run reads IDLE, not alive in its model colour', () => {
    const { container } = render(
      <AgentMonogram name="Researcher" model="gemini" sitsOut="Gemini is switched off in Settings" />,
    )
    const el = container.querySelector('.amono') as HTMLElement
    expect(el.className).toContain('amono--idle')
    expect(el.style.background).not.toBe(asRgb(modelColor('gemini')))
    // …and hovering says exactly why.
    expect(el.title).toMatch(/Gemini is switched off in Settings/)
  })

  it('a working agent’s tooltip names the model that would answer', () => {
    render(<AgentMonogram name="auditor" model="local" />)
    expect(screen.getByTitle('auditor · local')).toBeInTheDocument()
  })
})
