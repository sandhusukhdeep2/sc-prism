import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOnboarding } from '../lib/onboarding'
import { PRIORITY_LABEL, ROLE_HATS, SIGNOFFS, useInterview } from '../lib/interview'
import { primaryDisplayName, primaryModelLabel, useSettings } from '../lib/settings'
import { isNative, resolveVaultDir, writeVaultNote } from '../lib/nativeEngine'
import { buildGovernanceBundle } from '../lib/governance'
import Stepper from '../components/Stepper'
import './GovernanceReview.css'

// How long the "setup complete" beat lingers before it auto-opens the
// workspace. The explicit CTA always works regardless of this timer.
const AUTO_OPEN_MS = 4200

// One reviewable governance file derived from the real answers.
interface ReviewCard {
  file: string
  kind: string
  summary: React.ReactNode
  empty: boolean
  editTo: string
  conflict?: boolean
}

// Onboarding — review the drafted governance config derived from the real
// interview answers, resolve any conflict, then activate. Every card's Edit
// jumps back to the step that owns it; nothing here is decorative.
export default function GovernanceReview() {
  const { finish, pause} = useOnboarding()
  const { interview } = useInterview()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const [activated, setActivated] = useState(false)
  const [toastOpen, setToastOpen] = useState(true)
  // Live write progress as the governance bundle lands in the vault.
  const [writing, setWriting] = useState(false)
  const [written, setWritten] = useState<string[]>([])
  const [writeDir, setWriteDir] = useState('')

  // ----- derive the reviewable config from the captured answers -----
  const roleList = ROLE_HATS.filter((r) => interview.roles.includes(r))
  const gates = SIGNOFFS.filter((s) => interview.signoffs.includes(s.id))
  const guards = interview.neverTouch
  const priorities = interview.priorities
  const topPriority = PRIORITY_LABEL[priorities[0]]
  const companion = primaryDisplayName(settings)
  const model = primaryModelLabel(settings)

  // Hooks: two baseline enforcement hooks plus one guard per never-touch entry.
  const hookCount = 2 + guards.length

  // Conflict: a never-touch path (e.g. "/secrets") that a speed-first routing
  // rule would otherwise write to. Only flagged when such a path exists AND
  // speed is the top priority.
  const conflictPath =
    priorities[0] === 'speed'
      ? guards.find((g) => g.startsWith('/') || /secret/i.test(g))
      : undefined

  // Once activated, drift to the workspace on a cancellable timer. This is a
  // convenience only — the "Open workspace" button below is authoritative.
  useEffect(() => {
    if (!activated) return
    const t = window.setTimeout(() => navigate('/'), AUTO_OPEN_MS)
    return () => window.clearTimeout(t)
  }, [activated, navigate])

  async function handleActivate() {
    if (conflictPath) {
      navigate('/interview')
      return
    }
    // Write the REAL governance bundle to the vault, one file at a time so the
    // user sees each land. Non-native (browser) skips the writes gracefully.
    if (isNative()) {
      setWriting(true)
      setWritten([])
      const bundle = buildGovernanceBundle(interview, settings)
      const vault = await resolveVaultDir(settings.vaultPath)
      setWriteDir(vault + '/governance')
      for (const f of bundle) {
        const path = await writeVaultNote(vault, f.relpath, f.content)
        if (path) setWritten((w) => [...w, f.relpath.replace('governance/', '')])
      }
      setWriting(false)
    }
    finish()
    setActivated(true)
  }

  // Human-readable review cards, data-driven from the interview + providers.
  // (The YAML lives in the vault as the backend record — never shown here.)
  const chips = (items: string[]) => (
    <span className="gr__chips">
      {items.map((i) => (
        <span key={i} className="gr__chip">{i}</span>
      ))}
    </span>
  )

  const cards: ReviewCard[] = [
    {
      file: 'companion',
      kind: 'Your co-founder',
      summary: (
        <>
          <b>{companion}</b> — runs on {model}. Plans and drafts with you; nothing runs
          without your approval.
        </>
      ),
      empty: false,
      editTo: '/companion-wakes',
    },
    {
      file: 'roles',
      kind: 'The hats you wear',
      summary: roleList.length ? chips(roleList) : 'none selected yet',
      empty: roleList.length === 0,
      editTo: '/interview',
    },
    {
      file: 'gates',
      kind: 'Always asks you first',
      summary: gates.length ? (
        <>
          {companion} stops and waits for your OK before: {chips(gates.map((g) => g.gate))}
        </>
      ) : (
        'no sign-off gates — risky actions still get confirmed'
      ),
      empty: gates.length === 0,
      editTo: '/interview',
    },
    {
      file: 'never',
      kind: 'Never touched by any agent',
      summary: guards.length ? chips(guards) : 'nothing marked off-limits',
      empty: guards.length === 0,
      editTo: '/interview',
    },
    {
      file: 'sensitive',
      kind: 'Private — never leaves this Mac',
      summary: (
        <>
          {interview.sensitiveWords.length > 0 && chips(interview.sensitiveWords)}
          <span className="gr__note">
            Any task mentioning these runs on your local model only.
            Built-in protection is always on too: passwords, credentials, PII, prod.
          </span>
        </>
      ),
      empty: false,
      editTo: '/interview',
    },
    {
      file: 'verify',
      kind: 'Auto-check before trusting work',
      summary: interview.verifyCommand ? (
        <>
          {companion} runs <span className="mono gr__cmd">{interview.verifyCommand}</span> before
          trusting any work — if it fails, everything stops at zero AI cost.
        </>
      ) : (
        'no auto-check yet — you can add one anytime'
      ),
      empty: !interview.verifyCommand,
      editTo: '/interview',
    },
    {
      file: 'compliance',
      kind: 'Compliance',
      summary: interview.compliance.length
        ? (
            <>
              Folded into every plan and report: {chips(interview.compliance)}
            </>
          )
        : 'none apply',
      empty: interview.compliance.length === 0,
      editTo: '/interview',
    },
    {
      file: 'routing',
      kind: 'Which AI handles what',
      summary: (
        <>
          Decisions go {topPriority.toLowerCase()}-first (then{' '}
          {priorities.slice(1).map((p) => PRIORITY_LABEL[p].toLowerCase()).join(', ')}).
          Routine work stays on your local model; private topics never go to the cloud.
        </>
      ),
      empty: false,
      editTo: '/interview',
      conflict: !!conflictPath,
    },
  ]

  // Business-context strip (from the deeper interview).
  const ctx = [
    interview.companyName,
    interview.departments.length ? `${interview.departments.length} depts` : '',
    interview.teamSize,
    interview.budget,
  ].filter(Boolean)

  if (activated) {
    return (
      <div className="gr gr--done">
        <Stepper active={5} />

        <div className="gr__done">
          <div className="gr__bloom-wrap" aria-hidden="true">
            <span className="gr__bloom" />
            <span className="gr__bloom-halo" />
            <span className="gr__bloom-halo gr__bloom-halo--outer" />
            <span className="gr__bloom-check">✓</span>
          </div>

          <div className="gr__done-kicker mono">governance active</div>
          <div className="gr__done-title">You&rsquo;re all set</div>
          <div className="gr__done-sub">
            {companion} is your co-founder — opening your workspace.
          </div>

          {written.length > 0 && (
            <div className="gr__written mono">
              <div className="gr__written-head">✓ wrote {written.length} files → {writeDir}</div>
              <div className="gr__written-list">
                {written.map((f) => (
                  <span key={f} className="gr__written-file">{f}</span>
                ))}
              </div>
            </div>
          )}

          <div className="gr__done-summary mono">
            <span className="gr__done-stat"><b>{roleList.length}</b> roles</span>
            <span className="gr__done-dot">&middot;</span>
            <span className="gr__done-stat"><b>{hookCount}</b> hooks</span>
            <span className="gr__done-dot">&middot;</span>
            <span className="gr__done-stat"><b>{gates.length}</b> gates</span>
            <span className="gr__done-dot">&middot;</span>
            <span className="gr__done-stat"><b>{interview.sensitiveWords.length}</b> force-local</span>
            <span className="gr__done-dot">&middot;</span>
            <span className="gr__done-stat">{topPriority}-first</span>
          </div>

          <Link to="/" className="btn-gold gr__done-cta">
            Open workspace &rarr;
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="gr">
      <button type="button" className="wizback" onClick={() => navigate('/interview')}>
        ← Back
      </button>
      <div className="wizactions">
        <button
          type="button"
          className="wizclose"
          aria-label="Close setup"
          onClick={() => {
            pause()
            navigate('/')
          }}
        >
          ✕ Close
        </button>
      </div>
      <Stepper active={4} />

      <div className="gr__body">
        <div className="gr__title">Review what {companion} drafted</div>
        <div className="gr__sub">
          Nothing is active until you confirm. Each card&rsquo;s <b>Edit</b> jumps back to change it.
        </div>

        {/* business context — everything you told me about the company */}
        {(interview.business || interview.website || ctx.length > 0) && (
          <div className="gr__bizctx">
            {interview.business && (
              <div className="gr__bizline">
                <span className="gr__bizkey mono">business</span>
                <span className="gr__bizval">{interview.business}</span>
              </div>
            )}
            {interview.website && (
              <div className="gr__bizline">
                <span className="gr__bizkey mono">website</span>
                <span className="gr__bizval mono">{interview.website}</span>
              </div>
            )}
            {ctx.length > 0 && (
              <div className="gr__ctx mono">
                {ctx.map((c, i) => (
                  <span key={i} className="gr__ctxitem">{c}</span>
                ))}
              </div>
            )}
            <Link to="/interview" className="gr__bizedit">Edit business details</Link>
          </div>
        )}

        <div className="gr__grid">
          {cards.map((c) => (
            <div
              key={c.file}
              className={'gr__card' + (c.conflict ? ' gr__card--conflict' : '')}
            >
              <div className="gr__head">
                <span className="gr__kind gr__kind--title">{c.kind}</span>
                <span className="gr__spacer" />
                {c.conflict ? (
                  <span className="gr__badge gr__badge--warn">⚠ conflict</span>
                ) : c.empty ? (
                  <span className="gr__badge gr__badge--empty">not set</span>
                ) : (
                  <span className="gr__badge gr__badge--ok">✓ set</span>
                )}
              </div>
              <div className="gr__summary gr__summary--plain">{c.summary}</div>

              {c.conflict && conflictPath && (
                <div className="gr__conflict">
                  ⚠ a speed-first rule could write to <span className="mono">{conflictPath}</span> —
                  contradicts your never-touch list. Edit to resolve.
                </div>
              )}

              <div className="gr__actions">
                <Link to={c.editTo} className="gr__act gr__act--strong">
                  {c.empty ? 'Add →' : 'Edit'}
                </Link>
              </div>
            </div>
          ))}
        </div>

        {/* footer */}
        <div className="gr__footer">
          <span className="gr__footnote">
            {conflictPath
              ? '1 conflict blocks activation — nothing activates on its own.'
              : 'Nothing activates on its own — activating saves all of this into your vault as plain, readable files (readable in Obsidian too).'}
          </span>
          <span className="gr__spacer" />
          {writing && (
            <span className="gr__writing mono">writing {written.length}/10 files to your vault…</span>
          )}
          <button
            type="button"
            className="btn-gold gr__activate-btn"
            disabled={writing}
            onClick={() => void handleActivate()}
          >
            {writing
              ? 'Writing…'
              : conflictPath
                ? 'Fix conflict & activate →'
                : 'Activate & write to vault →'}
          </button>
        </div>
      </div>

      {/* companion proactive toast — real actions */}
      {conflictPath && toastOpen && (
        <div className="gr__toast">
          <div className="gr__toastcard">
            <div className="gr__toasttext">
              I flagged one conflict in <span className="mono">routing.yaml</span> — it clashes with
              your never-touch list. Want to fix it?
            </div>
            <div className="gr__toastbtns">
              <button type="button" className="gr__toastfix" onClick={() => navigate('/interview')}>
                Take me there
              </button>
              <button type="button" className="gr__toastdismiss" onClick={() => setToastOpen(false)}>
                Dismiss
              </button>
            </div>
          </div>
          <span className="orb orb--48" />
        </div>
      )}
    </div>
  )
}
