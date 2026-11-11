import { describe, expect, it } from 'vitest'
import { normalizeSettings } from './settings'

// 2026-11-11: computer use that can see. Two switches decide who may be shown
// the screen, and both are OFF unless the stored value is exactly `true`:
//   localVision   — "my local model can see images" (the engine otherwise
//                   assumes a local model cannot);
//   screenToCloud — the owner's explicit switch to let a CLOUD model be shown
//                   a screenshot. Without it a screenshot keeps the run local.
describe('the screen switches default off and take only a literal true', () => {
  it('both are off on a fresh install', () => {
    const s = normalizeSettings({})
    expect(s.localVision).toBe(false)
    expect(s.screenToCloud).toBe(false)
  })

  it('garbage never turns either on', () => {
    for (const junk of ['true', 1, 'yes', {}, null] as unknown[]) {
      const s = normalizeSettings({ localVision: junk, screenToCloud: junk } as never)
      expect(s.localVision, String(junk)).toBe(false)
      expect(s.screenToCloud, String(junk)).toBe(false)
    }
  })

  it('a literal true is kept', () => {
    const s = normalizeSettings({ localVision: true, screenToCloud: true })
    expect(s.localVision).toBe(true)
    expect(s.screenToCloud).toBe(true)
  })
})
