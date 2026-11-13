// A run belongs to ONE room (spec 2026-11-14 "The chat is the room" §2). The
// owner's screenshot showed a heartbeat drawn in a project's room: every room
// drew whatever the engine was doing.
import { describe, expect, it } from 'vitest'
import { MANAGER_ROOM, runRoom, runsElsewhere, runsInRoom, type LiveRun } from './liveRuns'
import { UNIVERSAL } from '../store/AppStore'

const run = (patch: Partial<LiveRun>): LiveRun => ({
  id: patch.id ?? 'r1',
  kind: 'chat',
  intent: 'x',
  startedAt: 1,
  models: [],
  ...patch,
})

describe('runRoom', () => {
  it('the Manager’s room is the universal thread', () => {
    expect(MANAGER_ROOM).toBe(UNIVERSAL)
  })
  it('a run that names its room belongs there', () => {
    expect(runRoom(run({ room: 'proj-1' }))).toBe('proj-1')
  })
  it('a run that names none — a heartbeat, a standing job — is the Manager’s', () => {
    expect(runRoom(run({ kind: 'heartbeat' }))).toBe(MANAGER_ROOM)
    expect(runRoom(run({ kind: 'task', room: '' }))).toBe(MANAGER_ROOM)
  })
})

describe('runsInRoom and runsElsewhere', () => {
  const runs = [
    run({ id: 'beat', kind: 'heartbeat' }),
    run({ id: 'build', kind: 'project', room: 'proj-1' }),
    run({ id: 'parked', kind: 'project', room: 'proj-2', paused: true }),
  ]
  it('a room sees only its own runs', () => {
    expect(runsInRoom(runs, 'proj-1').map((r) => r.id)).toEqual(['build'])
    expect(runsInRoom(runs, MANAGER_ROOM).map((r) => r.id)).toEqual(['beat'])
  })
  it('elsewhere is what is EXECUTING in other rooms — a parked run holds no engine', () => {
    expect(runsElsewhere(runs, 'proj-1').map((r) => r.id)).toEqual(['beat'])
    expect(runsElsewhere(runs, MANAGER_ROOM).map((r) => r.id)).toEqual(['build'])
    expect(runsElsewhere(runs, 'proj-3').map((r) => r.id)).toEqual(['beat', 'build'])
  })
})
