// WHERE A MESSAGE TYPED IN A PROJECT'S ROOM GOES (2026-11-11).
//
// A project's room has a lane the Manager room does not: the folder. A job
// sent there becomes the project's next step and the governed build makes the
// change on disk. Everything else typed in the room is a conversation — with
// the manager, or with the team — and writes nothing.
//
// The lane is decided here, by rule (`asksForChange`), shown above the
// composer before the send, and overridden by one click. Pure.

import { asksForChange } from './jobKind'
import { folderJobBlock, nextSendMode, type Project } from './projects'

export interface FolderLane {
  /** The room HAS a folder lane at all (a project that is past its interview). */
  offered: boolean
  /** This message goes to the folder. */
  on: boolean
  /** Why the folder cannot take a job right now — '' when it can. */
  block: string
  /** The sentence shown before the send. '' when the lane is not on. */
  line: string
}

export function folderLane(input: {
  project: Project | null | undefined
  text: string
  /** 'auto' — the default lane, nothing chosen; 'folder' — picked by hand;
   *  'other' — the user picked the manager, the team or a specialist lane. */
  picked: 'auto' | 'folder' | 'other'
  hasAttachments: boolean
}): FolderLane {
  const { project, picked } = input
  // No project, or one still being interviewed into a plan: there is no folder
  // lane — the room's sends are the interview's.
  if (!project || nextSendMode(project) === 'project-interview') {
    return { offered: false, on: false, block: '', line: '' }
  }
  const block = folderJobBlock(project)
  const on =
    picked === 'folder' ||
    (picked === 'auto' && !block && !input.hasAttachments && asksForChange(input.text))
  if (!on) return { offered: true, on: false, block, line: '' }
  const line = block
    ? `the folder cannot take this yet — ${block}`
    : `your team makes this change in ${project.path} — ${
        picked === 'folder' ? 'you chose the folder' : 'because you asked for a change'
      }`
  return { offered: true, on: true, block, line }
}

/**
 * What a SENT message was, read back from its bubble: the lane it took and the
 * words without the lane's label. Used when a message is sent again (↺) or
 * branched from (⋔), so the words go — not "→ team: → team: …" — and a job
 * for the folder goes back to the folder rather than to a board that cannot
 * write. A message with no label took the default lane.
 */
export function sentLane(text: string): { lane: 'folder' | 'team'; text: string } {
  for (const [label, lane] of [
    ['→ folder: ', 'folder'],
    ['→ team: ', 'team'],
  ] as const) {
    if (text.startsWith(label)) return { lane, text: text.slice(label.length) }
  }
  return { lane: 'team', text }
}
