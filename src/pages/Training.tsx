import Card from '../components/Card'
import PageHead from '../components/PageHead'
import LearningPanel from '../components/LearningPanel'
import './Training.css'

// First-class Training page (P4-1) — gives the honest learning step (formerly
// buried at the bottom of Stats) its own home. HONEST explanation up front:
// this is route-POLICY learning, never LLM weight fine-tuning. The learning
// step is a dry-run PREVIEW; adopting a gate-passed router is a separate,
// explicit human action (LF-2), and it only governs routing in Auto-route mode
// (R1) — the same contract LearningPanel enforces via `runNativeLearn` /
// `runNativeLearnApply` / `formatAdoptResult`.
//
// It uses the app's shared PageHead + Card (2026-08-27). It had neither: no
// card, no elevation, no radius — content straight onto the page, which is why
// it read as a different product from Work and Stats.
export default function Training() {
  return (
    <div className="training">
      {/* Each thing once (2026-11-14): what is learned is said in the one
          sentence under the title, and the panel heads itself — the head's
          hint and a titled card around the panel both said it again. */}
      <PageHead
        title="Improve"
        em="routing"
        sub={
          <>
            The router learns which model should handle each task — local vs cloud — from your{' '}
            <b>real run outcomes</b>. This tunes <b>route policy</b>, never the models&rsquo;
            weights. A trained router is adopted only if it beats your current one and you choose
            to.
          </>
        }
      />
      <Card>
        <LearningPanel />
      </Card>
    </div>
  )
}
