// Red-tinted in-chat card for an honest send failure. Deliberately NOT an
// assistant bubble — nothing here was said by an AI.
import { Link } from 'react-router-dom'

export default function ErrorMessageCard({
  text,
  onRetry,
  busy,
}: {
  text: string
  onRetry: () => void
  busy?: boolean
}) {
  return (
    <div className="msg msg--error" role="alert">
      <div className="errcard">
        <div className="errcard__text">{text}</div>
        <div className="errcard__actions">
          <button className="errcard__btn" onClick={onRetry} disabled={busy}>
            {busy ? 'checking…' : 'Retry'}
          </button>
          <Link className="errcard__btn" to="/providers">
            Open Providers
          </Link>
        </div>
      </div>
    </div>
  )
}
