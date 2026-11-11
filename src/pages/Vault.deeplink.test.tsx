import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Vault from './Vault'
import { create as simCreate } from '../lib/vault'
import { SettingsProvider } from '../lib/settings'

// A page that names a vault file (the Memory card's list of notes to fix) links
// to it; the Vault opens that note instead of whichever sorts first.
function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SettingsProvider>
        <Vault />
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Vault — a link can open one note', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('opens the note named in ?file=', () => {
    simCreate('aaa-first.md', '# First note\n\nbody')
    simCreate('zzz/last.md', '# The last one\n\nbody')
    renderAt('/library?tab=vault&file=' + encodeURIComponent('zzz/last.md'))
    expect(screen.getByRole('heading', { name: 'The last one' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'First note' })).not.toBeInTheDocument()
  })

  it('opens the first note when the named file is not in the vault', () => {
    simCreate('aaa-first.md', '# First note\n\nbody')
    renderAt('/library?tab=vault&file=gone.md')
    expect(screen.getByRole('heading', { name: 'First note' })).toBeInTheDocument()
  })
})
