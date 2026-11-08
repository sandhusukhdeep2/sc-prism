import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

// Library is a container: four existing pages behind one tablist. The pages
// have their own tests; here they are stubs so this file proves ONLY the
// container — which tab shows, that the URL carries it, that nonsense falls
// back to Skills.
vi.mock('./Skills', () => ({ default: () => <h1>Skill library</h1> }))
vi.mock('./Memory', () => ({ default: () => <h1>Memory &amp; learning</h1> }))
vi.mock('./Vault', () => ({ default: () => <h1>Your vault</h1> }))
vi.mock('./Training', () => ({ default: () => <h1>Improve routing</h1> }))

const { default: Library } = await import('./Library')

function Where() {
  const loc = useLocation()
  return <output data-testid="where">{loc.pathname + loc.search}</output>
}

const draw = (path = '/library') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/library" element={<><Library /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )

describe('Library — Skills, Memory, Vault and Training as tabs of one page', () => {
  it('opens on Skills with four tabs in order', () => {
    draw()
    expect(screen.getByRole('heading', { name: 'Skill library' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Skills', 'Memory', 'Vault', 'Training'])
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute('aria-selected', 'true')
  })

  it('?tab=memory opens Memory', () => {
    draw('/library?tab=memory')
    expect(screen.getByRole('heading', { name: 'Memory & learning' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true')
  })

  it('a tab nobody has opens Skills, never a blank', () => {
    draw('/library?tab=nonsense')
    expect(screen.getByRole('heading', { name: 'Skill library' })).toBeInTheDocument()
  })

  it('clicking a tab puts it in the URL (replace, so Back leaves the Library)', () => {
    draw()
    fireEvent.click(screen.getByRole('tab', { name: 'Vault' }))
    expect(screen.getByRole('heading', { name: 'Your vault' })).toBeInTheDocument()
    expect(screen.getByTestId('where').textContent).toBe('/library?tab=vault')
  })

  it('the panel is labelled by its tab', () => {
    draw('/library?tab=training')
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAccessibleName('Training')
    expect(screen.getByRole('heading', { name: 'Improve routing' })).toBeInTheDocument()
  })
})
