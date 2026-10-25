// Gate 1 — scope approval, on screen.
//
// The spec calls this "the single most important gate — everything downstream
// is constrained by what is approved here". Two rules follow from that.
//
// It must be legible to someone who will not read JSON. A permission list
// rendered as JSON is a permission list nobody reads, and a gate nobody reads
// is a gate that approves everything.
//
// And it must not make anything sound smaller than it is. The dangerous
// version of this card shows "may reach api.example.com" — a restriction that
// does not exist, because sandbox-exec cannot filter by host. `scopeSummary`
// refuses to name the host for exactly that reason; this component just
// renders what it says.

import { scopeSummary, type DraftManifest } from '../lib/toolApproval'
import './ToolScopeCard.css'

export default function ToolScopeCard({
  draft,
  onApprove,
  onDismiss,
}: {
  draft: DraftManifest
  onApprove: (d: DraftManifest) => void
  onDismiss: () => void
}) {
  const s = scopeSummary(draft)

  const line = (key: typeof s.riskiest, text: string) => (
    <div className={'toolscope__line' + (s.riskiest === key ? ' toolscope__line--risk' : '')}>
      {text}
    </div>
  )

  return (
    <div className="toolscope">
      <div className="toolscope__head">
        <span className="toolscope__kicker mono">NEW TOOL — YOUR APPROVAL</span>
        <span className="toolscope__name mono">{draft.name}</span>
      </div>

      <p className="toolscope__what">{s.what}</p>

      <div className="toolscope__lines">
        {line('reads', s.reads)}
        {line('writes', s.writes)}
        {line('network', s.network)}
        <div className="toolscope__line toolscope__line--data">{s.data}</div>
      </div>

      {/* What approving here does and does NOT mean. Someone clicking a button
          labelled "approve" deserves to know they are approving a SCOPE, and
          that no code exists yet to approve. */}
      <p className="toolscope__note">
        Nothing has been built yet. Approving here decides only what the tool
        would be <em>allowed</em> to do. It still has to be written, pass a
        sandbox run against your own real examples, pass a code audit, and be
        activated by you before it can ever be called.
      </p>

      <div className="toolscope__actions">
        <button type="button" className="toolscope__btn toolscope__btn--go" onClick={() => onApprove(draft)}>
          Approve this scope
        </button>
        <button type="button" className="toolscope__btn" onClick={onDismiss}>
          Don&rsquo;t build it
        </button>
      </div>
    </div>
  )
}
