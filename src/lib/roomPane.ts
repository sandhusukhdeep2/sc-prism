// THE PANE BESIDE THE CHAT (2026-11-12; no Stage since 2026-11-14).
//
// The owner, comparing the Work room with the coworker app he uses daily:
// "put the chat on the left side… it can open a browser or artifacts and other
// stuff in the right half." And, two days later, of the Stage tab that lived
// here: "very complicated… either remove the stage mode or utilize the chat."
//
// So the chat is always the chat, and a run is watched in the strip above it
// (components/RunStrip). Beside the chat, ON REQUEST, one tab at a time: the
// engine's own steps, the project's files, its details. The one thing that
// opens by itself is a quiet project's details in a wide window. Which tab is
// a rule, here, so the page cannot improvise it. Pure.

export type PaneTab = 'steps' | 'files' | 'details'

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
  /** There is a crew whose steps can be listed (a live one, or the last one). */
  hasCrew: boolean
  /** A project's room — it has a folder and details. */
  project: boolean
  /** A small window: the pane opens OVER the chat, so a quiet room keeps it shut. */
  narrow: boolean
}): RoomPane {
  const tabs: PaneTab[] = [
    ...(input.hasCrew ? (['steps'] as const) : []),
    ...(input.project ? (['files', 'details'] as const) : []),
  ]
  if (input.pick === 'closed') return { tab: null, tabs }
  if (input.pick && tabs.includes(input.pick)) return { tab: input.pick, tabs }
  // The rule: a quiet project room shows what the project is — unless the
  // window is small, where the pane would open over the chat.
  if (input.project && !input.narrow) return { tab: 'details', tabs }
  return { tab: null, tabs }
}

/**
 * The pick to hold after a change in whether a run is live.
 *
 * A run starting or ending leaves the pane as the user left it — the strip is
 * where a run is watched. The one exception: a run that ends with the project
 * waiting on the user hands the pane back to the rule, because the project's
 * details hold the button they need.
 */
export function paneAfterRun(input: {
  pick: PanePick
  wasLive: boolean
  live: boolean
  /** The run ended with the project waiting on the user (a step to resume, a
   *  question to answer, a plan to start). */
  needsYou?: boolean
}): PanePick {
  if (input.wasLive && !input.live && input.needsYou) return null
  return input.pick
}
