// A chat notice is the APP speaking: a sentence. When that sentence ends by
// naming a file it saved ("… · board saved: /abs/path/board-x.jsonl"), the
// sentence and the file are separate things — the sentence reads in body type,
// the file is a reveal action named by its own name (clear-room spec
// 2026-11-09 §B; project-room rule 5: every file the room mentions is
// reachable from the room).

export interface NoticeParts {
  /** The sentence, without the saved-file clause. */
  body: string
  /** The absolute path the notice named, when it named one. */
  path?: string
  /** That path's file name — what the reveal action is called. */
  file?: string
}

const SAVED = / · board saved: (\S+)/

export function noticeParts(text: string): NoticeParts {
  const m = SAVED.exec(text)
  if (!m) return { body: text }
  const path = m[1]
  const file = path.split('/').filter(Boolean).pop() ?? path
  return { body: text.replace(m[0], ''), path, file }
}
