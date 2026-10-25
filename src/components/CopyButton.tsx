// CopyButton — his ask (2026-08-31, screenshot of the coworker action row):
// one click copies a message's real text. Honest feedback: the label flips to
// "copied" only after the clipboard write actually resolved.
import { useState } from 'react'

export default function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="msg__copy mono"
      aria-label="Copy message"
      title="copy this message"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => {})
      }}
    >
      {done ? '✓ copied' : '⧉ copy'}
    </button>
  )
}
