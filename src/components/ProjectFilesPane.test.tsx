import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProjectFilesPane from './ProjectFilesPane'

// The Files tab of the room pane: the project's own folder, read beside the
// chat. A list that can be filtered, and a reader for the file picked.
const h = vi.hoisted(() => ({
  listProjectFiles: vi.fn(),
  readTextFile: vi.fn(),
  revealPath: vi.fn(async () => {}),
}))
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/someone'),
    listProjectFiles: h.listProjectFiles,
    readTextFile: h.readTextFile,
    revealPath: h.revealPath,
  }
})

const FILES = [
  { path: 'README.md', dir: false, mtime: 3, size: 120 },
  { path: 'src', dir: true, mtime: 2, size: 0 },
  { path: 'src/app.ts', dir: false, mtime: 2, size: 2048 },
  { path: 'src/util.ts', dir: false, mtime: 1, size: 64 },
]

function show() {
  return render(
    <MemoryRouter>
      <ProjectFilesPane path="~/site" refreshKey="0" />
    </MemoryRouter>,
  )
}

describe('ProjectFilesPane', () => {
  beforeEach(() => {
    h.listProjectFiles.mockReset()
    h.listProjectFiles.mockResolvedValue(FILES)
    h.readTextFile.mockReset()
    h.readTextFile.mockResolvedValue('# Site\n\nHello.')
    h.revealPath.mockClear()
  })

  it('lists the folder’s real files', async () => {
    show()
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src/app.ts' })).toBeInTheDocument()
    expect(h.listProjectFiles).toHaveBeenCalledWith('/Users/someone/site')
    expect(screen.getByText('3 files')).toBeInTheDocument()
  })

  it('before a file is picked it says what to do, and shows nothing as if read', async () => {
    show()
    await screen.findByRole('button', { name: 'README.md' })
    expect(screen.getByText('Pick a file to read it here.')).toBeInTheDocument()
    expect(h.readTextFile).not.toHaveBeenCalled()
  })

  it('picking a file reads it from disk, beside the list', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
    await waitFor(() => expect(h.readTextFile).toHaveBeenCalledWith('/Users/someone/site/README.md'))
    expect(await screen.findByText(/Hello\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'README.md' })).toHaveAttribute('aria-current', 'true')
  })

  it('the filter narrows the list by name', async () => {
    show()
    await screen.findByRole('button', { name: 'README.md' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter files' }), { target: { value: 'util' } })
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull()
    expect(screen.getByRole('button', { name: 'src/util.ts' })).toBeInTheDocument()
  })

  it('a file that cannot be read says so — it is not shown as empty', async () => {
    h.readTextFile.mockResolvedValue(null)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'src/app.ts' }))
    expect(await screen.findByText('This file could not be read as text.')).toBeInTheDocument()
  })

  it('the open file can be revealed in the Finder and opened in the editor', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'src/app.ts' }))
    await screen.findByRole('button', { name: 'Reveal in Finder' })
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(h.revealPath).toHaveBeenCalledWith('/Users/someone/site/src/app.ts')
    expect(screen.getByRole('link', { name: 'Open in the editor' })).toHaveAttribute(
      'href',
      '/editor?file=src%2Fapp.ts',
    )
  })

  it('an empty folder says it is empty', async () => {
    h.listProjectFiles.mockResolvedValue([])
    show()
    expect(await screen.findByText('This folder has no files yet.')).toBeInTheDocument()
  })
})
