// Is this a job, or just a message?
//
// The team is the composer's default lane (2026-08-30), so EVERY message
// staffed a lead, a researcher and a critic — a "hello" or a "go" spent three
// AIs (the owner, 2026-11-11: "Primary AI should do that"). This is the rule
// that tells a small message from a job. It is a rule on purpose: who takes a
// message is the orchestrator's decision, and a model never orchestrates
// models. It is shown before the send with its reason, and picking the team
// by hand always wins, so a wrong guess costs one click and never a silent run.

/** '' when the message is a job; otherwise what kind of small message it is. */
export type SmallKind =
  | ''
  | 'a greeting'
  | 'a short message'
  | 'a short question'
  | 'a question'
  | 'a remark'

// Openers that make a message a greeting or an acknowledgement.
const GREETINGS = [
  'hello', 'hi', 'hey', 'hiya', 'yo', 'howdy', 'greetings',
  'good morning', 'good afternoon', 'good evening', 'good night', 'gm', 'gn',
  'thanks', 'thank you', 'thx', 'ty', 'cheers',
  'ok', 'okay', 'k', 'cool', 'nice', 'great', 'perfect', 'awesome', 'got it',
  'yes', 'yeah', 'yep', 'no', 'nope', 'nah', 'sure',
  'bye', 'goodbye', 'see you', 'sorry', 'namaste', 'sat sri akal',
]

// Words that name work. One of these anywhere makes the message a job.
const WORK = [
  'build', 'make', 'create', 'write', 'rewrite', 'draft', 'edit', 'fix', 'debug', 'refactor',
  'implement', 'add', 'remove', 'delete', 'update', 'change', 'rename', 'move',
  'research', 'find', 'search', 'analyse', 'analyze', 'review', 'audit', 'check', 'compare',
  'plan', 'design', 'summarize', 'summarise', 'translate', 'generate', 'explain',
  'deploy', 'ship', 'release', 'launch', 'publish', 'install', 'setup', 'configure', 'migrate',
  'run', 'test', 'compile', 'merge', 'commit', 'schedule', 'send', 'email', 'reply',
  'scrape', 'download', 'calculate', 'convert', 'extract', 'format', 'sort', 'tidy',
  'document', 'optimise', 'optimize', 'prepare', 'organise', 'organize', 'list', 'draw',
]

const ASKING = [
  'what', 'who', 'how', 'why', 'when', 'where', 'which',
  'can', 'could', 'do', 'does', 'is', 'are', 'will', 'would', 'should',
]

function namesWork(word: string): boolean {
  return WORK.some((stem) => {
    if (word === stem || word === `${stem}s` || word === `${stem}es` || word === `${stem}ed` || word === `${stem}d` || word === `${stem}ing`) return true
    if (stem.endsWith('e') && word === `${stem.slice(0, -1)}ing`) return true
    const last = stem[stem.length - 1]
    if (word === `${stem}${last}ing` || word === `${stem}${last}ed`) return true
    if (stem.endsWith('y') && (word === `${stem.slice(0, -1)}ies` || word === `${stem.slice(0, -1)}ied`)) return true
    return false
  })
}

// THREE LEVELS (2026-11-14). The owner, watching his tokens: "a normal hello,
// or a normal thinking question — only the primary should answer… if things
// get a little complex, the primary and local; more complex, all the AIs."
//
//   talk — a greeting, a question, a remark. One AI answers. No team.
//   job  — one piece of work. Two seats: one leads, the local model works.
//   big  — work in several parts, a long brief, or work that asks for more
//          than one pair of eyes (review, research, audit…). The full team.
//
// Still a rule, never a model's guess: asking an AI how many AIs a message
// needs would itself cost a call on every hello.

/** Verbs a single AI can simply ANSWER — they are not a job on their own. */
const TELL = ['explain', 'describe', 'define', 'tell', 'show', 'calculate', 'convert', 'translate']

/** Words that ask for more than one pair of eyes. */
const TEAM_WORDS = ['review', 'audit', 'critique', 'research', 'debate', 'compare']
const TEAM_PHRASES = ['second opinion', 'pros and cons', 'whole team', 'full team', 'all the ais', 'all ais', 'everyone']

/** Openers that make a sentence a REQUEST even when no work word is in it. */
const REQUESTS = ['i need', 'i want', 'we need', 'we want', "i'd like", 'i would like', 'please', "let's", 'lets']

/** Words that put one piece of work after another. */
const SEQUENCE = /\b(?:and then|then|after that|afterwards|finally)\b/g

const LONG_BRIEF_WORDS = 45
const QUESTION_WORDS = 30
const REMARK_WORDS = 12

function stemOf(word: string, stems: readonly string[]): string {
  return (
    stems.find((stem) => {
      if (word === stem || word === `${stem}s` || word === `${stem}es` || word === `${stem}ed` || word === `${stem}d` || word === `${stem}ing`) return true
      if (stem.endsWith('e') && word === `${stem.slice(0, -1)}ing`) return true
      return false
    }) ?? ''
  )
}

export type MessageLevel = 'talk' | 'job' | 'big'

export interface LevelChoice {
  level: MessageLevel
  /** For talk: what kind of message it is. '' for work (and for nothing typed). */
  kind: SmallKind
  /** For work: the reason, in a few words the composer can show. */
  why: string
}

/**
 * Which level a message is. First rule that fires wins:
 *   1. no words at all ("?", "👍")                     -> talk
 *   2. opens with a greeting, no work, eight words     -> talk
 *   3. one word                                        -> talk
 *   4. asks for more than one pair of eyes             -> big
 *   5. a list, a long brief, or work after work        -> big
 *   6. a question that names nothing to MAKE           -> talk
 *   7. names work, or opens as a request               -> job
 *   8. a short remark                                  -> talk
 *   9. otherwise                                       -> job
 */
export function messageLevel(text: string): LevelChoice {
  const raw = text.trim()
  if (!raw) return { level: 'talk', kind: '', why: '' }
  const norm = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 1. Something was typed, and none of it is a word.
  if (!norm) return { level: 'talk', kind: 'a short message', why: '' }
  const words = norm.split(' ')
  const workWords = words.filter(namesWork)
  const tellOnly = workWords.length > 0 && workWords.every((w) => stemOf(w, TELL))
  const makes = workWords.some((w) => !stemOf(w, TELL))
  const greetingLed = GREETINGS.some((g) => norm === g || norm.startsWith(`${g} `))
  if (greetingLed && workWords.length === 0 && words.length <= 8) {
    return { level: 'talk', kind: 'a greeting', why: '' }
  }
  if (words.length === 1) return { level: 'talk', kind: 'a short message', why: '' }

  // 4. More than one pair of eyes.
  const teamWord = words.map((w) => stemOf(w, TEAM_WORDS)).find(Boolean)
  if (teamWord) {
    return { level: 'big', kind: '', why: `“${teamWord}” asks for more than one pair of eyes` }
  }
  const teamPhrase = TEAM_PHRASES.find((p) => norm.includes(p))
  if (teamPhrase) return { level: 'big', kind: '', why: `you asked for “${teamPhrase}”` }

  // 5. Several parts.
  const listItems = raw.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length
  const sequenced = (norm.match(SEQUENCE) ?? []).length > 0 && workWords.filter((w) => !stemOf(w, TELL)).length >= 2
  if (listItems >= 2 || sequenced) return { level: 'big', kind: '', why: 'work in several parts' }
  if (words.length > LONG_BRIEF_WORDS) return { level: 'big', kind: '', why: 'a long brief' }

  // 6. A question that names nothing to make is answered, not staffed.
  const asking = raw.endsWith('?') || ASKING.includes(words[0])
  if (asking && !makes && words.length <= QUESTION_WORDS) {
    return { level: 'talk', kind: words.length <= 6 ? 'a short question' : 'a question', why: '' }
  }
  // …and so is "explain how X works": one AI can simply answer it.
  if (tellOnly && words.length <= QUESTION_WORDS) return { level: 'talk', kind: 'a question', why: '' }

  // 7. Work.
  if (makes) return { level: 'job', kind: '', why: 'one piece of work' }
  const request = REQUESTS.some((r) => norm === r || norm.startsWith(`${r} `))
  if (request) return { level: 'job', kind: '', why: 'one piece of work' }

  // 8. A short remark.
  if (words.length <= 3) return { level: 'talk', kind: 'a short message', why: '' }
  if (words.length <= REMARK_WORDS) return { level: 'talk', kind: 'a remark', why: '' }
  return { level: 'job', kind: '', why: 'one piece of work' }
}

/**
 * What kind of small message this is, or '' when it is work (or nothing was
 * typed). A small message is answered by one AI; no team is staffed.
 */
export function smallMessage(text: string): SmallKind {
  const choice = messageLevel(text)
  return choice.level === 'talk' ? choice.kind : ''
}
