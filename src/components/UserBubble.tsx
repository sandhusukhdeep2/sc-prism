// UserBubble — long user-side messages fold (his screenshot, 2026-08-31: a
// build step's raw engine text rendered as an unreadable dark wall). The
// record is untouched; only rendering folds. Short messages render exactly
// as before; a long one shows its head with an honest "show all · N chars"
// toggle, and always wraps inside the bubble.
import { useState } from 'react'
import CopyButton from './CopyButton'

const FOLD_OVER = 700
const HEAD_CHARS = 320

export default function UserBubble({
  text,
  onRetry,
  onBranch,
}: {
  text: string
  /** Resend this message through the current default lane (his screenshot's
   *  ↺ — offered only when the host can actually resend). */
  onRetry?: (text: string) => void
  /** Branch (⋔): start a FRESH session with this message pre-filled — a new
   *  path from the same starting point, nothing sent until the user sends. */
  onBranch?: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const long = text.length > FOLD_OVER
  return (
    <div className="msg msg--user">
      <span className="msg__usertext">{long && !open ? `${text.slice(0, HEAD_CHARS)}…` : text}</span>
      {long && (
        <button
          type="button"
          className="msg__fold mono"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'fold ▴' : `show all · ${text.length.toLocaleString()} chars ▾`}
        </button>
      )}
      <span className="msg__actions">
        <CopyButton text={text} />
        {onRetry && (
          <button
            type="button"
            className="msg__copy mono"
            aria-label="Retry message"
            title="send this message again"
            onClick={() => onRetry(text)}
          >
            ↺ retry
          </button>
        )}
        {onBranch && (
          <button
            type="button"
            className="msg__copy mono"
            aria-label="Branch from message"
            title="start a fresh session with this message pre-filled — nothing sends until you send"
            onClick={() => onBranch(text)}
          >
            ⋔ branch
          </button>
        )}
      </span>
    </div>
  )
}
