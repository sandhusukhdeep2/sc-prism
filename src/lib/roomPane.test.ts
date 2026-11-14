import { describe, expect, it } from 'vitest'
import { paneAfterRun, roomPane } from './roomPane'

// THE PANE BESIDE THE CHAT (2026-11-12; no Stage since 2026-11-14). The room
// is its Team board and its chat — the shape of the "Visible agents" mockup.
// Beside the chat, ON REQUEST: the engine's own steps, the project's files and
// details, and — in the Manager's room — the coworker desk. The one thing that
// opens by itself is the details of a project that is waiting on the user:
// they hold the button it needs.
const base = { pick: null, hasCrew: false, project: false, narrow: false } as const

describe('roomPane — which tab the pane shows, and which it offers', () => {
  it('the Manager’s room keeps its pane shut, and offers the desk', () => {
    expect(roomPane({ ...base })).toEqual({ tab: null, tabs: ['desk'] })
  })

  it('there is no Stage tab — a run is watched on the Team board', () => {
    const p = roomPane({ ...base, hasCrew: true, project: true })
    expect(p.tabs).toEqual(['steps', 'files', 'details'])
  })

  it('a team at work does not open the pane — its steps are offered', () => {
    expect(roomPane({ ...base, hasCrew: true })).toEqual({ tab: null, tabs: ['steps', 'desk'] })
  })

  it('a quiet project room is its board and its chat; files and details are offered', () => {
    expect(roomPane({ ...base, project: true })).toEqual({ tab: null, tabs: ['files', 'details'] })
  })

  it('a project waiting on the user opens on its details — they hold the button', () => {
    expect(roomPane({ ...base, project: true, needsYou: true })).toEqual({ tab: 'details', tabs: ['files', 'details'] })
  })

  it('the desk belongs to the Manager’s room, not to a project’s', () => {
    expect(roomPane({ ...base, project: true }).tabs).not.toContain('desk')
    expect(roomPane({ ...base, pick: 'desk' }).tab).toBe('desk')
  })

  it('a tab picked by hand is the tab', () => {
    expect(roomPane({ ...base, hasCrew: true, project: true, pick: 'steps' }).tab).toBe('steps')
    expect(roomPane({ ...base, project: true, pick: 'files' }).tab).toBe('files')
  })

  it('closed by hand stays closed', () => {
    expect(roomPane({ ...base, project: true, needsYou: true, pick: 'closed' }).tab).toBeNull()
  })

  it('a pick that is no longer offered falls back to the rule', () => {
    // Steps were open; the room now has no crew to list.
    expect(roomPane({ ...base, project: true, needsYou: true, pick: 'steps' }).tab).toBe('details')
    expect(roomPane({ ...base, project: true, pick: 'steps' }).tab).toBeNull()
    expect(roomPane({ ...base, pick: 'steps' }).tab).toBeNull()
  })

  it('in a small window even a waiting project keeps the room for the chat', () => {
    expect(roomPane({ ...base, project: true, needsYou: true, narrow: true })).toEqual({
      tab: null,
      tabs: ['files', 'details'],
    })
  })
})

describe('paneAfterRun — what the pane does when a run starts or ends', () => {
  it('a run starting leaves the pane as it is — the board is where it is watched', () => {
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
