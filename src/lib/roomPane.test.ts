import { describe, expect, it } from 'vitest'
import { paneAfterRun, roomPane } from './roomPane'

// THE ROOM PANE (2026-11-12). The owner, looking at the coworker app he uses:
// "put the chat on the left side and the animated agents working with each
// other on the right… it can open a browser or artifacts and other stuff in
// the right half." The chat stays the chat; what the work produces opens
// beside it. Which tab the pane shows is a rule, tested here.
const base = { pick: null, live: false, hasCrew: false, parked: false, project: false, narrow: false } as const

describe('roomPane — which tab the pane shows, and which it offers', () => {
  it('with nothing to show there is no pane', () => {
    expect(roomPane(base)).toEqual({ tab: null, tabs: [] })
  })

  it('a team at work opens the stage by itself', () => {
    const p = roomPane({ ...base, live: true, hasCrew: true })
    expect(p.tab).toBe('stage')
    expect(p.tabs).toEqual(['stage', 'steps'])
  })

  it('one AI answering a chat message does not open the pane — the stage is offered, not imposed', () => {
    const p = roomPane({ ...base, live: true, hasCrew: true, team: false })
    expect(p.tab).toBeNull()
    expect(p.tabs).toEqual(['stage', 'steps'])
  })

  it('a run with no crew yet has nothing to draw, so nothing opens', () => {
    expect(roomPane({ ...base, live: true }).tab).toBeNull()
  })

  it('a quiet project room opens on its details', () => {
    const p = roomPane({ ...base, project: true })
    expect(p.tab).toBe('details')
    expect(p.tabs).toEqual(['files', 'details'])
  })

  it('a project at work offers everything, and the stage takes the pane', () => {
    const p = roomPane({ ...base, project: true, live: true, hasCrew: true })
    expect(p.tab).toBe('stage')
    expect(p.tabs).toEqual(['stage', 'steps', 'files', 'details'])
  })

  it('after a crew run the stage stays offered, but does not open itself', () => {
    const p = roomPane({ ...base, hasCrew: true })
    expect(p.tab).toBeNull()
    expect(p.tabs).toEqual(['stage', 'steps'])
  })

  it('a run parked on the user opens the stage — that is where it says what it waits for', () => {
    // Nothing is executing and no seat can be attributed, but the board holds
    // the "Your call" card, and a parked run must never be out of sight.
    const p = roomPane({ ...base, parked: true })
    expect(p.tab).toBe('stage')
    expect(p.tabs).toEqual(['stage'])
    // …in a project's room too, ahead of its details.
    expect(roomPane({ ...base, parked: true, project: true }).tab).toBe('stage')
  })

  it('a tab picked by hand is the tab', () => {
    expect(roomPane({ ...base, project: true, live: true, hasCrew: true, pick: 'details' }).tab).toBe('details')
    expect(roomPane({ ...base, hasCrew: true, pick: 'steps' }).tab).toBe('steps')
  })

  it('closed by hand stays closed', () => {
    expect(roomPane({ ...base, project: true, live: true, hasCrew: true, pick: 'closed' }).tab).toBeNull()
  })

  it('a pick that is no longer offered falls back to the rule', () => {
    // The stage was picked in a room that now has no crew to draw.
    expect(roomPane({ ...base, project: true, pick: 'stage' }).tab).toBe('details')
    expect(roomPane({ ...base, pick: 'details' }).tab).toBeNull()
  })

  it('in a small window a quiet project keeps the room for the chat', () => {
    expect(roomPane({ ...base, project: true, narrow: true }).tab).toBeNull()
    // …but a tab asked for by hand still opens (over the chat).
    expect(roomPane({ ...base, project: true, narrow: true, pick: 'details' }).tab).toBe('details')
  })

  it('a team at work is drawn at any width — the run is what there is to see', () => {
    expect(roomPane({ ...base, live: true, hasCrew: true, narrow: true }).tab).toBe('stage')
  })
})

describe('paneAfterRun — what the pane does when a run starts or ends', () => {
  it('a run starting hands the pane back to the rule (the stage takes it)', () => {
    expect(paneAfterRun({ pick: 'details', wasLive: false, live: true, showing: 'details' })).toBeNull()
    expect(paneAfterRun({ pick: 'closed', wasLive: false, live: true, showing: null })).toBeNull()
  })

  it('a run ending leaves the stage where it is — it does not vanish under the reader', () => {
    expect(paneAfterRun({ pick: null, wasLive: true, live: false, showing: 'stage' })).toBe('stage')
  })

  it('…unless the project now needs the user: its details hold the button, so they come back', () => {
    expect(
      paneAfterRun({ pick: null, wasLive: true, live: false, showing: 'stage', needsYou: true }),
    ).toBeNull()
    expect(
      paneAfterRun({ pick: 'steps', wasLive: true, live: false, showing: 'steps', needsYou: true }),
    ).toBeNull()
  })

  it('nothing changing changes nothing', () => {
    expect(paneAfterRun({ pick: 'steps', wasLive: true, live: true, showing: 'steps' })).toBe('steps')
    expect(paneAfterRun({ pick: null, wasLive: false, live: false, showing: 'details' })).toBeNull()
  })
})
