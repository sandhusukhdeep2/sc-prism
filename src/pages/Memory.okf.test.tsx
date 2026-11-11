import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OkfIssues } from './Memory'
import type { OkfReport } from '../lib/okfReport'

// 2026-11-11: the Knowledge vault card listed the first four of 81 files, each
// with "the validator returned no detail". The report held every reason; the
// card now says them once per cause, with a count and where the files sit.
const report: OkfReport = {
  ok: false,
  doc_count: 9,
  issues: [
    { path: 'projects/a/plan.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' },
    { path: 'projects/b/result.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' },
    { path: 'agents/planner.md', code: 'missing-type', message: "required frontmatter 'type' missing/empty" },
  ],
  warnings: [{ path: 'notes/a.md', code: 'broken-link', message: "unresolved cross-link 'x'" }],
}

function show(r: OkfReport = report) {
  return render(
    <MemoryRouter>
      <OkfIssues report={r} />
    </MemoryRouter>,
  )
}

describe('Knowledge vault card — says why, by cause', () => {
  it('names each cause once, with its count and where it sits', () => {
    show()
    expect(screen.getByRole('button', { name: /2 notes have no frontmatter block/ })).toHaveTextContent('projects 2')
    expect(screen.getByRole('button', { name: /1 note has frontmatter without a type/ })).toHaveTextContent('agents 1')
    expect(screen.getByRole('button', { name: /1 link does not resolve/ })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/returned no detail/)
  })

  it('keeps the files folded until a cause is opened, then each one opens in the Vault', () => {
    show()
    expect(screen.queryByText('projects/a/plan.md')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /2 notes have no frontmatter block/ }))
    expect(screen.getByRole('link', { name: 'projects/a/plan.md' })).toHaveAttribute(
      'href',
      '/library?tab=vault&file=projects%2Fa%2Fplan.md',
    )
    expect(screen.getByRole('link', { name: 'projects/b/result.md' })).toBeInTheDocument()
  })

  it('does not repeat a reason the title already gives, and keeps one that adds to it', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /2 notes have no frontmatter block/ }))
    expect(screen.queryByText(/no YAML frontmatter block/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /1 link does not resolve/ }))
    expect(screen.getByText("unresolved cross-link 'x'")).toBeInTheDocument()
  })

  it('marks an error apart from a warning by form, not by colour alone', () => {
    const { container } = show()
    expect(container.querySelectorAll('.okf__group--err')).toHaveLength(2)
    expect(container.querySelectorAll('.okf__group--warn')).toHaveLength(1)
  })

  it('renders nothing for a clean vault', () => {
    const { container } = show({ ok: true, issues: [], warnings: [], doc_count: 3 })
    expect(container).toBeEmptyDOMElement()
  })

  it('does not link a path that is not a note in the vault', () => {
    show({ ok: false, doc_count: 0, warnings: [], issues: [{ path: '/somewhere/vault', code: 'not-a-directory', message: 'bundle path is not a directory' }] })
    fireEvent.click(screen.getByRole('button', { name: /The vault folder was not found/ }))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('/somewhere/vault')).toBeInTheDocument()
  })
})
