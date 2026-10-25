import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ToolScopeCard from './ToolScopeCard'
import type { DraftManifest } from '../lib/toolApproval'

// Gate 1 on screen. The spec: "the single most important gate — everything
// downstream is constrained by what is approved here."
//
// So this card's job is to make a permission grant legible to someone who will
// not read JSON, and to refuse to make anything sound smaller than it is.

const draft = (over: Partial<DraftManifest> = {}): DraftManifest => ({
  name: 'northwind_foods_pdf_invoices',
  description: 'Read line items from Northwind Foods PDF invoices.',
  permissions: {
    filesystem_read: ['inbox/invoices/**'],
    filesystem_write: [],
    network: [],
    vault_read: [],
    vault_write: [],
  },
  data_class: 'confidential',
  execution_target: 'local_only',
  ...over,
})

describe('ToolScopeCard', () => {
  it('says what the tool is for before what it may touch', () => {
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Northwind Foods PDF invoices/)).toBeInTheDocument()
  })

  it('shows the exact paths it may read', () => {
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/inbox\/invoices/)).toBeInTheDocument()
  })

  it('states the safe case as a sentence, not an empty row', () => {
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/cannot write anything/i)).toBeInTheDocument()
    expect(screen.getByText(/no internet access/i)).toBeInTheDocument()
  })

  it('NEVER shows a hostname as though it were enforced', () => {
    const d = draft({
      permissions: { ...draft().permissions, network: ['api.example.com'] },
    })
    render(<ToolScopeCard draft={d} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByText(/api\.example\.com/)).not.toBeInTheDocument()
    expect(screen.getByText(/ANY site/i)).toBeInTheDocument()
  })

  it('marks the riskiest grant so the eye lands there', () => {
    const d = draft({ permissions: { ...draft().permissions, network: ['x'] } })
    const { container } = render(
      <ToolScopeCard draft={d} onApprove={vi.fn()} onDismiss={vi.fn()} />,
    )
    expect(container.querySelector('.toolscope__line--risk')).toBeTruthy()
  })

  it('says the tool cannot run yet', () => {
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/nothing has been built|cannot run yet|not been written/i)).toBeInTheDocument()
  })

  it('approving scope is not activating the tool', () => {
    // Gate 1 approves WHAT IT MAY DO. Gates 2-4 still have to pass.
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /approve/i })
    expect(btn.textContent?.toLowerCase()).toContain('scope')
  })

  it('hands back the draft it was shown', () => {
    const onApprove = vi.fn()
    render(<ToolScopeCard draft={draft()} onApprove={onApprove} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ name: 'northwind_foods_pdf_invoices' }))
  })

  it('can be dismissed without approving anything', () => {
    const onDismiss = vi.fn()
    render(<ToolScopeCard draft={draft()} onApprove={vi.fn()} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /build it|dismiss/i }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
