// Global test setup: jest-dom matchers augmented onto Vitest's expect, plus a
// network guard so nothing in a test ever hits a real provider endpoint.
import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Any fetch (provider pings, model calls) is stubbed to reject; the engine and
// providers all fall back gracefully when the network is unreachable.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.reject(new Error('network disabled in tests'))),
)

afterEach(() => {
  cleanup()
})
