import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, findSections, sectionFromParam } from './settingsSections'

// SETTINGS, IN CATEGORIES (2026-11-12). The page was one scroll of every
// control the app has — providers, routing, the workload slider, extensions,
// plugins, computer control, appearance, approvals, Telegram, reset. The
// owner's reference shows settings as a short list of categories with one
// category on screen at a time, and a search that finds a control by its name.
describe('settings sections', () => {
  it('there are six, in a fixed order, each with a name a person would look for', () => {
    expect(SETTINGS_SECTIONS.map((s) => [s.id, s.label])).toEqual([
      ['ais', 'Your AIs'],
      ['routing', 'Routing & workload'],
      ['capabilities', 'Capabilities'],
      ['you', 'You & appearance'],
      ['connections', 'Connections'],
      ['setup', 'Setup'],
    ])
  })

  it('the address says which one is open; anything else opens the first', () => {
    expect(sectionFromParam('capabilities')).toBe('capabilities')
    expect(sectionFromParam(null)).toBe('ais')
    expect(sectionFromParam('')).toBe('ais')
    expect(sectionFromParam('nonsense')).toBe('ais')
  })
})

describe('findSections — a control is found by what it is called', () => {
  it('finds the section a control lives in', () => {
    expect(findSections('workload').map((s) => s.id)).toEqual(['routing'])
    expect(findSections('telegram').map((s) => s.id)).toEqual(['connections'])
    expect(findSections('theme').map((s) => s.id)).toEqual(['you'])
    expect(findSections('plugin').map((s) => s.id)).toEqual(['capabilities'])
    expect(findSections('gemini').map((s) => s.id)).toEqual(['ais'])
  })

  it('matches a section by its own name too, whatever the case', () => {
    expect(findSections('ROUTING').map((s) => s.id)).toEqual(['routing'])
  })

  it('a word in two places finds both, in the page’s own order', () => {
    expect(findSections('local').map((s) => s.id)).toEqual(['ais', 'routing', 'capabilities'])
  })

  it('nothing typed lists every section; nothing matching lists none', () => {
    expect(findSections('  ')).toHaveLength(SETTINGS_SECTIONS.length)
    expect(findSections('zzzz')).toEqual([])
  })
})
