import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RoomPane from './RoomPane'

// The pane beside the chat: tabs for what the work produces, and a way to
// close it. (No Stage tab since 2026-11-14 — a run is watched in the strip.)
function show(over: Partial<Parameters<typeof RoomPane>[0]> = {}) {
  const onTab = vi.fn()
  const onClose = vi.fn()
  render(
    <MemoryRouter>
      <RoomPane tab="steps" tabs={['steps', 'files', 'details']} onTab={onTab} onClose={onClose} {...over}>
        <p>the panel’s own content</p>
      </RoomPane>
    </MemoryRouter>,
  )
  return { onTab, onClose }
}

describe('RoomPane', () => {
  it('offers the tabs it was given, in order, and marks the one on screen', () => {
    show()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Steps', 'Files', 'Details'])
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'false')
  })

  it('shows the content of the tab on screen', () => {
    show()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('the panel’s own content')
  })

  it('choosing a tab tells the room which', () => {
    const { onTab } = show()
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(onTab).toHaveBeenCalledWith('files')
  })

  it('can be closed', () => {
    const { onClose } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Close the pane' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('has no way out to another page — it is only ever beside the chat', () => {
    show()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('only offers what the room has', () => {
    show({ tab: 'details', tabs: ['files', 'details'] })
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Files', 'Details'])
  })
})
