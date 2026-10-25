// UserBubble + CopyButton — his screenshot fixes (2026-08-31): raw step text
// rendered as an unreadable wall (now folds, record untouched), and messages
// gain one-click copy with honest feedback (label flips only after the
// clipboard write resolves).
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import UserBubble from './UserBubble'

describe('UserBubble', () => {
  it('short messages render whole, no fold control', () => {
    render(<UserBubble text="quick question" />)
    expect(screen.getByText('quick question')).toBeInTheDocument()
    expect(screen.queryByText(/show all/)).not.toBeInTheDocument()
  })

  it('long messages fold to a head with an honest count, and unfold', () => {
    const long = 'Project goal: '.padEnd(1200, 'x')
    render(<UserBubble text={long} />)
    expect(screen.getByText(/show all · 1,200 chars/)).toBeInTheDocument()
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/show all/))
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('copy writes the FULL text even while folded', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const long = 'the full body '.padEnd(900, 'y')
    render(<UserBubble text={long} />)
    fireEvent.click(screen.getByRole('button', { name: /copy message/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(long))
    expect(await screen.findByText('✓ copied')).toBeInTheDocument()
  })
})

it('retry resends the full text through the host handler', () => {
  const onRetry = vi.fn()
  render(<UserBubble text="build the site" onRetry={onRetry} />)
  fireEvent.click(screen.getByRole('button', { name: /retry message/i }))
  expect(onRetry).toHaveBeenCalledWith('build the site')
})

it('no handler → no retry control (never a dead button)', () => {
  render(<UserBubble text="hello" />)
  expect(screen.queryByRole('button', { name: /retry message/i })).not.toBeInTheDocument()
})

it('branch hands the text to the host and never sends by itself', () => {
  const onBranch = vi.fn()
  render(<UserBubble text="try a different angle" onBranch={onBranch} />)
  fireEvent.click(screen.getByRole('button', { name: /branch from message/i }))
  expect(onBranch).toHaveBeenCalledWith('try a different angle')
})
