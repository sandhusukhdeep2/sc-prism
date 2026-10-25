import { describe, expect, it } from 'vitest'
import { latestNotice } from './AppStore'
import type { Notice } from './AppStore'

// latestNotice is the pure notice-selection helper extracted for Task B5 so
// the Projects page banner and the cinematic ProjectRunStage request overlay
// pick the SAME "latest ask" instead of duplicating the reversed-scan logic.
describe('latestNotice', () => {
  it('returns undefined when there is no match', () => {
    expect(latestNotice([], 'proj-1', 'request')).toBeUndefined()
  })

  it('ignores notices for other projects and other kinds', () => {
    const notices: Notice[] = [
      { id: 'n1', projectId: 'proj-2', text: 'other project', kind: 'request' },
      { id: 'n2', projectId: 'proj-1', text: 'done note', kind: 'done' },
    ]
    expect(latestNotice(notices, 'proj-1', 'request')).toBeUndefined()
  })

  it('picks the LAST matching notice, not the first — a later ask must win over a stale one', () => {
    const notices: Notice[] = [
      { id: 'n1', projectId: 'proj-1', text: 'first ask (stale)', kind: 'request' },
      { id: 'n2', projectId: 'proj-1', text: 'unrelated attention', kind: 'attention' },
      { id: 'n3', projectId: 'proj-1', text: 'second ask (current)', kind: 'request' },
    ]
    expect(latestNotice(notices, 'proj-1', 'request')).toEqual(notices[2])
  })
})
