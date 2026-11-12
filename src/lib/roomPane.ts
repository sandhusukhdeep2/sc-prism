// THE ROOM PANE (2026-11-12).
//
// The owner, comparing the Work room with the coworker app he uses daily:
// "put the chat on the left side and the animated agents working with each
// other on the right… it can open a browser or artifacts and other stuff in
// the right half, and the left represents the information."
//
// The chat is always the chat. What the work produces — the run drawn to be
// watched, the engine's own steps, the project's files and details — opens
// BESIDE it, one tab at a time. Which tab is a rule, here, so the page cannot
// improvise it: a team at work takes the pane with the stage; a quiet project
// shows its details; a choice made by hand holds until the next run starts.
// Pure.

export type PaneTab = 'stage' | 'steps' | 'files' | 'details'

/** null — nothing chosen, the rule decides; 'closed' — closed by hand. */
export type PanePick = PaneTab | 'closed' | null

export interface RoomPane {
  /** The tab on screen, or null when the pane is closed. */
  tab: PaneTab | null
  /** The tabs this room can show right now, in their fixed order. */
  tabs: PaneTab[]
}

export function roomPane(input: {
  pick: PanePick
  /** An engine run is executing right now. */
  live: boolean
  /** There is a crew to draw (a live one, or the last one). */
  hasCrew: boolean
  /** The run executing is TEAM work (a team run or a project build), not one
   *  AI answering a chat message. Only team work takes the pane by itself; a
   *  single answer offers the stage and leaves the room alone. Default true. */
  team?: boolean
  /** A run is parked on the user's answer. Nothing executes, but the board
   *  says what it is waiting for — and that must never be out of sight. */
  parked?: boolean
  /** A project's room — it has a folder and details. */
  project: boolean
  /** A small window: the pane opens OVER the chat, so a quiet room keeps it shut. */
  narrow: boolean
}): RoomPane {
  const tabs: PaneTab[] = [
    ...(input.hasCrew || input.parked ? (['stage'] as const) : []),
    ...(input.hasCrew ? (['steps'] as const) : []),
    ...(input.project ? (['files', 'details'] as const) : []),
  ]
  if (input.pick === 'closed') return { tab: null, tabs }
  if (input.pick && tabs.includes(input.pick)) return { tab: input.pick, tabs }
  // The rule: a team at work is something to watch, at any width — and so is
  // a run waiting on the user. A quiet
  // project room shows what the project is — unless the window is small, where
  // the pane would open over the chat and the chat keeps the room.
  if ((input.live && input.hasCrew && input.team !== false) || input.parked) {
    return { tab: 'stage', tabs }
  }
  if (input.project && !input.narrow) return { tab: 'details', tabs }
  return { tab: null, tabs }
}

/**
 * The pick to hold after a change in whether a run is live.
 *
 * A run STARTING hands the pane back to the rule — that is when there is
 * something to watch, whatever was open or closed before. A run ENDING pins
 * the stage if it was on screen, so the drawing does not vanish under someone
 * reading it — unless the project now needs the user, when its details come
 * back. Anything else leaves the pick as it was.
 */
export function paneAfterRun(input: {
  pick: PanePick
  wasLive: boolean
  live: boolean
  /** The tab on screen when the change happened. */
  showing: PaneTab | null
  /** The run ended with the project waiting on the user (a step to resume, a
   *  question to answer, a plan to start). Its details hold that button, so
   *  the rule takes the pane back rather than leave it behind another tab. */
  needsYou?: boolean
}): PanePick {
  if (!input.wasLive && input.live) return null
  if (input.wasLive && !input.live) {
    if (input.needsYou) return null
    if (input.showing === 'stage') return 'stage'
  }
  return input.pick
}
