import { describe, expect, it } from 'vitest'
import { folderLane, sentLane } from './roomLane'
import type { Project } from './projects'

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'hello crew',
    slug: 'hello-crew',
    path: '~/vault/projects/hello-crew',
    goal: 'greet the crew',
    verifyCommand: '',
    createdAt: 0,
    status: 'done',
    brief: '',
    plan: ['Write hello.md'],
    stepIndex: 1,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    mode: 'new',
    ...over,
  }
}

const auto = { picked: 'auto' as const, hasAttachments: false }

// Where a message typed in a project's room goes — said before the send.
describe('folderLane — does this message go to the project folder?', () => {
  it('a change, typed in a finished project, goes to the folder — and says why', () => {
    const lane = folderLane({ project: project(), text: 'Rewrite hello.md as a warmer greeting', ...auto })
    expect(lane.on).toBe(true)
    expect(lane.block).toBe('')
    expect(lane.line).toBe(
      'your team makes this change in ~/vault/projects/hello-crew — because you asked for a change',
    )
  })

  it('a question stays a conversation', () => {
    expect(folderLane({ project: project(), text: 'What does hello.md say?', ...auto }).on).toBe(false)
  })

  it('outside a project there is no folder', () => {
    const lane = folderLane({ project: null, text: 'fix the typo', ...auto })
    expect(lane.on).toBe(false)
    expect(lane.offered).toBe(false)
  })

  it('a project still being planned is not offered the folder', () => {
    const lane = folderLane({
      project: project({ plan: [], status: 'interviewing', stepIndex: 0 }),
      text: 'fix the typo',
      ...auto,
    })
    expect(lane.on).toBe(false)
    expect(lane.offered).toBe(false)
  })

  it('attached files are a conversation — the folder takes words only', () => {
    expect(folderLane({ project: project(), text: 'fix the typo', picked: 'auto', hasAttachments: true }).on).toBe(false)
  })

  it('a hand pick of the folder wins, even for a remark', () => {
    const lane = folderLane({ project: project(), text: 'the greeting should be warmer', picked: 'folder', hasAttachments: false })
    expect(lane.on).toBe(true)
    expect(lane.line).toBe('your team makes this change in ~/vault/projects/hello-crew — you chose the folder')
  })

  it('a hand pick of anything else wins, even for a change', () => {
    expect(folderLane({ project: project(), text: 'fix the typo', picked: 'other', hasAttachments: false }).on).toBe(false)
  })

  it('a folder that is busy is not picked automatically', () => {
    const lane = folderLane({ project: project({ status: 'running' }), text: 'fix the typo', ...auto })
    expect(lane.on).toBe(false)
    expect(lane.offered).toBe(true)
    expect(lane.block).toMatch(/build is running/)
  })

  it('…and picked by hand it says why it cannot take the job', () => {
    const lane = folderLane({ project: project({ status: 'running' }), text: 'fix the typo', picked: 'folder', hasAttachments: false })
    expect(lane.on).toBe(true)
    expect(lane.line).toMatch(/^the folder cannot take this yet — a build is running/)
  })

  it('an opened folder with no plan takes a change straight away', () => {
    const lane = folderLane({
      project: project({ mode: 'existing', goal: '', plan: [], status: 'new', stepIndex: 0, path: '/Users/someone/site' }),
      text: 'Fix the footer link',
      ...auto,
    })
    expect(lane.on).toBe(true)
    expect(lane.line).toContain('/Users/someone/site')
  })
})

// A sent message is shown with the lane it took ("→ folder: …"). Sending it
// AGAIN must send the words, down the same lane — not the label, and not a
// folder job quietly turned into a conversation.
describe('sentLane — what a sent message was, read back from its bubble', () => {
  it('a folder job goes back to the folder, without its label', () => {
    expect(sentLane('→ folder: Rewrite hello.md')).toEqual({ lane: 'folder', text: 'Rewrite hello.md' })
  })

  it('a team message goes back to the team, without its label', () => {
    expect(sentLane('→ team: plan the launch')).toEqual({ lane: 'team', text: 'plan the launch' })
  })

  it('a plain message has no label to remove', () => {
    expect(sentLane('hello')).toEqual({ lane: 'team', text: 'hello' })
  })

  it('a label is only a label at the very start', () => {
    expect(sentLane('see → folder: x')).toEqual({ lane: 'team', text: 'see → folder: x' })
  })
})
