import { describe, expect, it } from 'vitest'
import { neverTouchGlobs } from './neverTouch'

describe('neverTouchGlobs', () => {
  it('maps a leading-slash entry to both the stripped form and its glob', () => {
    expect(neverTouchGlobs(['/secrets'])).toEqual(['secrets', 'secrets/**'])
  })

  it('maps a prose entry (no leading slash) to itself and its glob', () => {
    expect(neverTouchGlobs(['prod DB'])).toEqual(['prod DB', 'prod DB/**'])
  })

  it('preserves order across multiple entries', () => {
    expect(neverTouchGlobs(['/secrets', 'prod DB', '/config'])).toEqual([
      'secrets',
      'secrets/**',
      'prod DB',
      'prod DB/**',
      'config',
      'config/**',
    ])
  })

  it('deduplicates entries, treating /x and x as the same', () => {
    expect(neverTouchGlobs(['/secrets', 'secrets'])).toEqual(['secrets', 'secrets/**'])
    expect(neverTouchGlobs(['secrets', '/secrets'])).toEqual(['secrets', 'secrets/**'])
  })

  it('drops empty strings and whitespace-only entries', () => {
    expect(neverTouchGlobs(['', '  ', 'prod DB', '\t'])).toEqual(['prod DB', 'prod DB/**'])
  })

  it('returns an empty array for empty input', () => {
    expect(neverTouchGlobs([])).toEqual([])
  })

  it('trims whitespace from entries', () => {
    expect(neverTouchGlobs(['  /secrets  ', '  prod DB  '])).toEqual([
      'secrets',
      'secrets/**',
      'prod DB',
      'prod DB/**',
    ])
  })

  it('handles complex deduplication with mixed slashes and whitespace', () => {
    expect(neverTouchGlobs(['/secrets', 'secrets', '  /secrets  ', 'prod DB', '  prod DB  '])).toEqual([
      'secrets',
      'secrets/**',
      'prod DB',
      'prod DB/**',
    ])
  })
})
