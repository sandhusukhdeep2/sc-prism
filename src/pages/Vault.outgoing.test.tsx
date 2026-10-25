import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Vault from './Vault'
import { create as simCreate } from '../lib/vault'
import { SettingsProvider } from '../lib/settings'

// P6: "Links from this note" used to render outgoing links as dead, non-clickable
// text. Each resolvable link is now a button that navigates to the target note
// (like backlinks already do). This is the revert-failing guard — runs in the
// browser sim store (non-native).
function renderVault() {
  return render(
    <MemoryRouter initialEntries={['/vault']}>
      <SettingsProvider>
        <Vault />
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Vault — outgoing links navigate to the target note', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders a resolvable outgoing link as a button that opens the target', () => {
    // A note that sorts first (so it auto-selects) and links to the seeded
    // `notes/uploader.md` via a [[wiki]] link.
    simCreate('aaa-link.md', 'See [[uploader]] for details.')
    renderVault()

    // The outgoing link is a real button (not dead text).
    const link = screen.getByRole('button', { name: 'uploader' })
    fireEvent.click(link)

    // Navigating opened the target note — its heading now renders.
    expect(screen.getByRole('heading', { name: /^uploader$/i })).toBeInTheDocument()
  })

  it('counts EVERY outgoing link in the "N out — scanned live" label, not just the first 6', () => {
    // P4: the label used to read from a .slice(0, 6) cap, so a note linking to
    // more than 6 targets claimed a live scan while silently dropping the rest.
    // Now the label counts the full set and the render list shows a "+N more".
    simCreate('aaa-many.md', 'Links: [[a]] [[b]] [[c]] [[d]] [[e]] [[f]] [[g]] [[h]]')
    renderVault()
    // Select this note explicitly (the file tree button carries its basename)
    // so the assertion doesn't depend on which note happens to auto-select.
    fireEvent.click(screen.getByRole('button', { name: 'aaa-many.md' }))

    // The graph note counts all 8, not the capped 6.
    expect(screen.getByText(/8 out/)).toBeInTheDocument()
    // Only the first 6 render, with a truthful "+2 more" for the remainder.
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.getByText('º a')).toBeInTheDocument() // 6th-and-earlier are rendered
    expect(screen.queryByText('º g')).not.toBeInTheDocument() // 7th is folded into "+2 more"
  })
})
