import { describe, expect, it } from 'vitest'
import { paneAfterRun, roomPane } from './roomPane'

// THE PANE BESIDE THE CHAT (2026-11-12; no Stage since 2026-11-14). The chat
// is always the chat, and a run is watched in the strip above it. Beside the
// chat, ON REQUEST: the engine's own steps, the project's files, its details.
// The one thing that opens by itself is a quiet project's details in a wide
// window.
const base = { pick: null, hasCrew: false, project: false, narrow: false } as const

describe('roomPane — which tab the pane shows, and which it offers', () => {
  it('with nothing to show there is no pane', () => {
    expect(roomPane({ ...base })).toEqual({ tab: null, tabs: [] })
  })

  it('there is no Stage tab — a run is watched in the strip above the chat', () => {
    const p = roomPane({ ...base, hasCrew: true, project: true })
    expect(p.tabs).toEqual(['steps', 'files', 'details'])
  })

  it('a team at work does not open the pane — its steps are offered', () => {
    expect(roomPane({ ...base, hasCrew: true })).toEqual({ tab: null, tabs: ['steps'] })
  })

  it('a quiet project room opens on its details', () => {
    expect(roomPane({ ...base, project: true })).toEqual({ tab: 'details', tabs: ['files', 'details'] })
  })

  it('a tab picked by hand is the tab', () => {
    expect(roomPane({ ...base, hasCrew: true, project: true, pick: 'steps' }).tab).toBe('steps')
    expect(roomPane({ ...base, project: true, pick: 'files' }).tab).toBe('files')
  })

  it('closed by hand stays closed', () => {
    expect(roomPane({ ...base, project: true, pick: 'closed' }).tab).toBeNull()
  })

  it('a pick that is no longer offered falls back to the rule', () => {
    // Steps were open; the room now has no crew to list.
    expect(roomPane({ ...base, project: true, pick: 'steps' }).tab).toBe('details')
    expect(roomPane({ ...base, pick: 'steps' }).tab).toBeNull()
  })

  it('in a small window a quiet project keeps the room for the chat', () => {
    expect(roomPane({ ...base, project: true, narrow: true })).toEqual({ tab: null, tabs: ['files', 'details'] })
  })
})

describe('paneAfterRun — what the pane does when a run starts or ends', () => {
  it('a run starting leaves the pane as it is — the strip is where it is watched', () => {
    expect(paneAfterRun({ pick: 'closed', wasLive: false, live: true })).toBe('closed')
    expect(paneAfterRun({ pick: 'files', wasLive: false, live: true })).toBe('files')
    expect(paneAfterRun({ pick: null, wasLive: false, live: true })).toBeNull()
  })

  it('a run ending leaves the pane as it is', () => {
    expect(paneAfterRun({ pick: 'steps', wasLive: true, live: false })).toBe('steps')
  })

  it('…unless the project now needs the user: its details hold the button, so they come back', () => {
    expect(paneAfterRun({ pick: 'closed', wasLive: true, live: false, needsYou: true })).toBeNull()
    expect(paneAfterRun({ pick: 'steps', wasLive: true, live: false, needsYou: true })).toBeNull()
  })

  it('nothing changing changes nothing', () => {
    expect(paneAfterRun({ pick: 'files', wasLive: false, live: false })).toBe('files')
    expect(paneAfterRun({ pick: 'closed', wasLive: true, live: true })).toBe('closed')
  })
})
