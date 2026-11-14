import { beforeEach, describe, expect, it } from 'vitest'
import { getInterview, resetInterview } from './interview'

// Seen on a first run with an empty home folder: before one question had been
// answered, the draft beside the interview read "Solo consultancy — I build
// data pipelines and internal tools…". That was a mock answer left in as the
// default — and the default is what the Manager is told about your business
// (`Business: …` in its context) if you close the wizard early. A fresh
// install states nothing about a business nobody described.
describe('interview — what a fresh install starts with', () => {
  beforeEach(() => {
    localStorage.clear()
    resetInterview()
  })

  it('has no business description until you give one', () => {
    expect(getInterview().business).toBe('')
  })

  it('keeps the cautious starting policy: sign-off gates and never-touch are on', () => {
    const iv = getInterview()
    expect(iv.signoffs).toContain('push-main')
    expect(iv.neverTouch).toContain('/secrets')
  })
})
