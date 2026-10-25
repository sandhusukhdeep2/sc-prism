// SC Prism — "which AI is doing what" (2026-08-15 spec §Delegation is visible).
//
// Sukhdeep's stated ask. Every delegated step shows FOUR things: which agent,
// which AI, what it was asked to do, and how it came out.
//
// It renders nothing it cannot prove. The rows come from `delegationSteps`,
// which reads REAL engine spans only — the same discipline as narrate.ts. So:
//   • no spans with an `agent` attr → the component renders NOTHING (not an
//     empty "0 agents working" frame, which reads like activity);
//   • an open turn reads "still working", never a guessed pass;
//   • a provider the gateway never reached reads "could not reach …", never a
//     completed turn (the f2766c6 / H2 lesson);
//   • a capability the ENGINE refused is shown as refused — enforcement is
//     visible, because a gate nobody sees looks exactly like no gate at all.
import { delegationLine, delegationSteps, delegationSummary } from '../lib/delegation'
import type { EngineSpan } from '../lib/nativeEngine'
import './DelegationTrail.css'

export default function DelegationTrail({
  spans,
  live = false,
}: {
  spans: readonly EngineSpan[]
  /** Live on the Work page vs. the after-the-fact view on a verdict. Changes
   *  only the heading's wording — never what a row is allowed to claim. */
  live?: boolean
}) {
  const steps = delegationSteps(spans)
  if (steps.length === 0) return null
  return (
    <section className="deleg" aria-label="Delegated work">
      <div className="deleg__head">
        <span className="deleg__kicker">{live ? 'who is doing what' : 'who did what'}</span>
        <span className="deleg__summary mono">{delegationSummary(steps)}</span>
      </div>
      <ol className="deleg__list">
        {steps.map((step, i) => (
          <li
            key={`${step.agent}-${step.at}-${i}`}
            className={`deleg__step deleg__step--${step.state}`}
            // The same four facts as ONE sentence, for assistive tech and for
            // hover. Not a second rendering of the row — the row IS the text.
            aria-label={delegationLine(step)}
            title={delegationLine(step)}
          >
            <span className="deleg__agent">{step.agent}</span>
            <span className="deleg__ai mono">{step.ai}</span>
            <span className="deleg__asked">asked to {step.asked}</span>
            <span className="deleg__outcome mono">
              {step.outcome || 'still working'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
