import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ErrorMessageCard from './ErrorMessageCard'

describe('ErrorMessageCard', () => {
  it('shows the error text and fires onRetry', () => {
    const onRetry = vi.fn()
    render(
      <MemoryRouter>
        <ErrorMessageCard text="Local model is unreachable — nothing was sent." onRetry={onRetry} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('nothing was sent')
    act(() => screen.getByText('Retry').click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.getByText('Open Providers')).toBeInTheDocument()
  })
})
