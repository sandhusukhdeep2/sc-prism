import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LocalMeter from './LocalMeter'
import type { LocalShare } from '../lib/engineStats'

const share = (over: Partial<LocalShare> = {}): LocalShare => ({
  localTokens: 29520, cloudTokens: 11480, totalTokens: 41000,
  localCost: 0, cloudCost: 0.09, totalCost: 0.09, pct: 72, measured: true, ...over,
})
const draw = (p: Parameters<typeof LocalMeter>[0]) =>
  render(<MemoryRouter><LocalMeter {...p} /></MemoryRouter>)

describe('LocalMeter — the local share in its honest states', () => {
  it('shows the measured share, its sub-line, and links to Stats', () => {
    draw({ share: share(), status: 'ok', hasLocalProvider: true })
    expect(screen.getByText('72% local')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /72% local.*open Stats/ })).toHaveAttribute('href', '/stats')
    expect(screen.getByText(/41K tokens · \$0\.09 cloud · so far/)).toBeInTheDocument()
  })

  it('nothing measured (every call a stand-in) is "no work yet", never 100% local', () => {
    draw({ share: share({ measured: false, pct: 0, totalTokens: 0 }), status: 'ok', hasLocalProvider: true })
    expect(screen.getByText('no work yet')).toBeInTheDocument()
    expect(screen.queryByText(/100% local/)).toBeNull()
  })

  it('all-local reads 100% local', () => {
    draw({ share: share({ pct: 100, cloudTokens: 0, cloudCost: 0 }), status: 'ok', hasLocalProvider: true })
    expect(screen.getByText('100% local')).toBeInTheDocument()
  })

  it('local provider off and no local work ever: 0% local — turn it on, linking to Providers', () => {
    draw({ share: share({ localTokens: 0, pct: 0 }), status: 'ok', hasLocalProvider: false })
    expect(screen.getByText(/0% local/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'turn it on' })).toHaveAttribute('href', '/providers')
  })

  it('local provider off but local work was measured: the measured share still shows', () => {
    // Review 2026-11-08: switching the provider off must not erase 66% of
    // measured work from the rail while Stats keeps saying 66%.
    draw({ share: share(), status: 'ok', hasLocalProvider: false })
    expect(screen.getByText('72% local')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'turn it on' })).toBeNull()
  })

  it('local provider off and nothing read yet: the nudge, not a blank', () => {
    draw({ share: null, status: 'none', hasLocalProvider: false })
    expect(screen.getByText(/0% local/)).toBeInTheDocument()
  })

  it('renders nothing while there is no dashboard at all', () => {
    for (const status of ['none', 'failed', 'loading'] as const) {
      const { container, unmount } = draw({ share: null, status, hasLocalProvider: true })
      expect(container.querySelector('.meter')).toBeNull()
      unmount()
    }
  })

  it('a loading or stale read with a previous share keeps showing it — no flash of "no work yet"', () => {
    draw({ share: share(), status: 'loading', hasLocalProvider: true })
    expect(screen.getByText('72% local')).toBeInTheDocument()
    expect(screen.queryByText('no work yet')).toBeNull()
  })

  it('never says "today" — the shared split has no day window', () => {
    draw({ share: share(), status: 'stale', hasLocalProvider: true })
    expect(screen.queryByText(/today/)).toBeNull()
  })
})
