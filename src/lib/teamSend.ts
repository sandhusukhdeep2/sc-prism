// WHAT A TEAM SEND REALLY IS (2026-11-14).
//
// Three levels decide how many AIs a message gets (lib/messageWeight.ts):
// talk — one answers; a job — two seats; a big job — every seat. This file is
// the last step for the two team levels: WHICH seats are sent, and the one
// line that says so before the send.
//
// The line is built from the roster that is sent. It used to come from a
// separate reading of "who would lead", which could name an AI the workload
// slider had since moved off that seat — words that disagreed with the run.
// Pure.
import { messageLevel, type MessageLevel } from './messageWeight'
import { brandOf } from './providerBudget'
import { splitRoster } from './roster'
import { jobRoster } from './workload'

/** An AI by the words the composer already uses for it. */
function aiLabel(token: string): string {
  const brand = brandOf(token)
  if (brand === 'local') return 'your local model'
  if (brand === 'claude') return 'Claude'
  if (brand === 'gemini') return 'Gemini'
  if (brand === 'openai') return 'OpenAI'
  return token
}

export interface TeamSend {
  /** The seats that will run, `role:token` comma-joined. */
  roster: string
  level: MessageLevel
  /** Who runs and why, for the line above the composer. '' with no seats. */
  line: string
}

export function teamSend(input: {
  /** The default team as the workload slider seated it. */
  fullRoster: string
  /** The primary's provider token (decides the second seat of a job for two). */
  primaryToken: string
  text: string
  /** The team was picked by hand for this message. */
  picked: boolean
  /** A file or an image rides along. */
  attached: boolean
}): TeamSend {
  const weighed = messageLevel(input.text)
  const everyone = input.picked || input.attached || weighed.level !== 'job'
  // A team send is a job for two or a job for everyone — never 'talk' (a
  // talk message only gets here when the team was picked by hand).
  const level: MessageLevel = everyone ? 'big' : 'job'
  const roster = everyone ? input.fullRoster : jobRoster(input.fullRoster, input.primaryToken)
  const seats = splitRoster(roster)
  if (seats.length === 0) return { roster: '', level, line: '' }
  const cut = splitRoster(input.fullRoster).length > seats.length
  const why = input.picked
    ? 'you picked the team'
    : input.attached
      ? 'a file rides along'
      : weighed.level === 'job'
        ? cut
          ? 'one piece of work, so two seats — pick the team to put every AI on it'
          : 'one piece of work'
        : weighed.why || 'you asked for more than one pair of hands'
  const who = seats.map((s) => `${s.role} on ${aiLabel(s.token)}`).join(' + ')
  return { roster, level, line: `${who} · ${why}` }
}
