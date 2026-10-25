import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PageHead from './PageHead'
import Card from './Card'

// The same 32px/300/-0.025em title rule was copy-pasted into SIX stylesheets,
// Automations had its own 21px variant, and the app carried twenty-nine
// different __head / __title class names. Nothing was broken and everything was
// slightly different — which is what "the pages don't feel connected" means
// when you try to point at it.
describe('PageHead — one header for every page', () => {
  it('renders the title as the page’s one h1', () => {
    render(<PageHead title="Improve" em="routing" />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Improve routing')
  })

  it('emphasises with WEIGHT, never a colour — the accent here is black', () => {
    render(<PageHead title="Improve" em="routing" />)
    const em = document.querySelector('.phead__em')!
    expect(em.textContent?.trim()).toBe('routing')
    // A coloured emphasis would fight the one accent the system has.
    expect((em as HTMLElement).style.color).toBe('')
  })

  it('a title with no emphasis is still a whole title', () => {
    render(<PageHead title="Console" />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Console')
    expect(document.querySelector('.phead__em')).toBeNull()
  })

  it('carries a hint, a sub line and actions only when given them', () => {
    const { container } = render(<PageHead title="Bare" />)
    expect(container.querySelector('.phead__hint')).toBeNull()
    expect(container.querySelector('.phead__sub')).toBeNull()
    expect(container.querySelector('.phead__actions')).toBeNull()

    render(
      <PageHead title="Full" hint="a hint" sub="a caveat" actions={<button>Do</button>} />,
    )
    expect(screen.getByText('a hint')).toBeInTheDocument()
    expect(screen.getByText('a caveat')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Do' })).toBeInTheDocument()
  })
})

describe('Card — one white panel, and one recessed well', () => {
  it('takes a heading only when the content does not name itself', () => {
    const { container } = render(<Card>bare</Card>)
    expect(container.querySelector('.card__head')).toBeNull()

    render(<Card title="Learning step">body</Card>)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Learning step')
  })

  it('the inset well is a DIFFERENT ground, not a card with a grey background', () => {
    const { container } = render(<Card inset>in a well</Card>)
    const el = container.querySelector('.card')!
    expect(el.className).toContain('card--inset')
  })

  it('flush drops its own padding for a child that owns its edges', () => {
    const { container } = render(<Card flush>a table</Card>)
    expect(container.querySelector('.card')!.className).toContain('card--flush')
  })
})
