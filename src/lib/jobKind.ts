// CHANGE OR TALK (2026-11-11).
//
// A project room has two honest lanes for a job. Either the team CHANGES the
// folder — a governed build step that reads the files, writes them and runs
// the checks — or the team TALKS about it, and writes nothing. They are not
// interchangeable: a build step that is asked a question fails for writing no
// file, and a conversation that is asked for a change can only describe one.
//
// Which lane a message OPENS on is decided here, by a rule about its first
// words. It is never a model's guess (ADR-007: a model does not route), it is
// shown above the composer before the send, and one click flips it.

/** Words that may stand in front of the ask without being the ask. */
const LEAD_INS = [
  'please',
  'pls',
  'hey',
  'hi',
  'ok',
  'okay',
  'now',
  'then',
  'next',
  'and',
  'also',
  'so',
  'just',
  'can you',
  'could you',
  'would you',
  'will you',
  'can we',
  'could we',
  "let's",
  'lets',
  'let us',
  'i want you to',
  'i need you to',
  "i'd like you to",
  'i would like you to',
  'go ahead and',
  'we need to',
  'you need to',
  'you should',
  'try to',
]

/** Verbs that ask for the folder to be different afterwards. */
const CHANGE_VERBS = new Set([
  'add', 'adjust', 'append', 'apply', 'bootstrap', 'build', 'bump', 'change',
  'clean', 'complete', 'configure', 'convert', 'correct', 'create', 'delete',
  'disable', 'document', 'draft', 'drop', 'edit', 'enable', 'expand', 'extend',
  'extract', 'finish', 'fix', 'format', 'generate', 'implement', 'improve',
  'init', 'initialise', 'initialize', 'insert', 'install', 'integrate', 'make',
  'merge', 'migrate', 'move', 'optimise', 'optimize', 'patch', 'polish', 'port',
  'prepend', 'put', 'redesign', 'redo', 'refactor', 'remove', 'rename',
  'reorganise', 'reorganize', 'replace', 'restructure', 'restyle', 'revert',
  'rewrite', 'scaffold', 'set', 'setup', 'shorten', 'simplify', 'split',
  'style', 'swap', 'tidy', 'translate', 'turn', 'tweak', 'update', 'upgrade',
  'wire', 'write',
])

/**
 * True when the message opens by asking for something to be CHANGED — "fix the
 * typo", "please add a test", "can you rename it?". A question, or a request
 * to look ("review…", "explain…", "what does…"), is false.
 *
 * Only the opening counts. "The greeting should be warmer" is a remark, not an
 * instruction, and a remark is talked about rather than acted on.
 */
export function asksForChange(text: string): boolean {
  let rest = text.trim().toLowerCase()
  if (!rest) return false
  // Peel the lead-ins off the front, longest first, as often as they repeat
  // ("ok, now please fix…").
  const ordered = [...LEAD_INS].sort((a, b) => b.length - a.length)
  for (let peeled = true; peeled; ) {
    peeled = false
    rest = rest.replace(/^[\s,.:;!-]+/, '')
    for (const lead of ordered) {
      if (rest === lead || rest.startsWith(lead + ' ') || rest.startsWith(lead + ',')) {
        rest = rest.slice(lead.length)
        peeled = true
        break
      }
    }
  }
  const first = rest.match(/^[a-z']+/)?.[0] ?? ''
  return CHANGE_VERBS.has(first)
}
