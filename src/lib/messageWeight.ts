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
export type SmallKind = '' | 'a greeting' | 'a short message' | 'a short question'

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

/**
 * What kind of small message this is, or '' when it is a job (or empty).
 * First rule that fires wins:
 *   1. opens with a greeting, names no work, eight words or fewer -> a greeting
 *   2. one word (a verb with nothing to act on is not a job yet)   -> a short message
 *   3. names work                                                  -> a job
 *   4. a question of six words or fewer                            -> a short question
 *   5. three words or fewer                                        -> a short message
 *   6. otherwise                                                   -> a job
 */
export function smallMessage(text: string): SmallKind {
  const raw = text.trim()
  const norm = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!norm) return ''
  const words = norm.split(' ')
  const work = words.some(namesWork)
  const greetingLed = GREETINGS.some((g) => norm === g || norm.startsWith(`${g} `))
  if (greetingLed && !work && words.length <= 8) return 'a greeting'
  if (words.length === 1) return 'a short message'
  if (work) return ''
  if ((raw.endsWith('?') || ASKING.includes(words[0])) && words.length <= 6) return 'a short question'
  if (words.length <= 3) return 'a short message'
  return ''
}
