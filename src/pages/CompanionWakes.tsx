import Stepper from '../components/Stepper'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOnboarding } from '../lib/onboarding'
import { primaryDisplayName, primaryModelLabel, useSettings } from '../lib/settings'
import { isNative, resolveVaultDir, runNativeTask } from '../lib/nativeEngine'
import { buildEngineProviders, isRealCompletion } from '../store/AppStore'
import { create as createAgent, list as listAgents } from '../lib/agents'
import './CompanionWakes.css'

type WakeState = 'idle' | 'waking' | 'awake' | 'fail'


export default function CompanionWakes() {
  const { completeStep, nextRoute, completedSteps, pause } = useOnboarding()
  const { settings, setCompanionName } = useSettings()
  const navigate = useNavigate()
  const alreadyDone = completedSteps.includes('companion')

  // Name the provider the user ACTUALLY made primary — never hardcode one.
  const primary = settings.providers.find((p) => p.primary && p.enabled)
  const name = primaryDisplayName(settings)
  const modelLabel = primaryModelLabel(settings)

  // "Convert my primary AI to one agent and give that agent one name."
  const [draftName, setDraftName] = useState(settings.companionName)
  const saveName = () => {
    const n = draftName.trim()
    if (!n) return
    setCompanionName(n)
    // Register the co-founder as a real entry in the agent library (once).
    const model = primary?.id.includes('claude')
      ? ('claude' as const)
      : primary?.id.includes('gemini')
        ? ('gemini' as const)
        : ('local' as const)
    if (!listAgents().some((a) => a.name.toLowerCase() === n.toLowerCase())) {
      createAgent({
        name: n,
        role: `co-founder · primary (${modelLabel})`,
        model,
        skills: ['planning', 'drafting', 'reviews'],
      })
    }
  }

  // REAL wake-up handshake: contact the primary through the engine once, time
  // the round-trip, and show its actual first words. The page is the proof
  // that the co-founder is genuinely reachable — not a decoration.
  const [wake, setWake] = useState<WakeState>('idle')
  const [greeting, setGreeting] = useState('')
  const [rtt, setRtt] = useState(0)
  useEffect(() => {
    if (!isNative()) return
    const { providers, primaryReal } = buildEngineProviders(settings)
    if (!primaryReal) return
    let cancelled = false
    setWake('waking')
    const t0 = Date.now()
    void (async () => {
      try {
        const vault = await resolveVaultDir(settings.vaultPath)
        const verdict = await Promise.race([
          runNativeTask(
            'You just came online as this user’s co-founder. Greet them in ONE short warm sentence — no lists, no questions.',
            vault,
            providers,
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
        ])
        if (cancelled) return
        if (verdict && isRealCompletion(verdict.response)) {
          setGreeting(verdict.response.trim().replace(/^["“]|["”]$/g, ''))
          setRtt(Date.now() - t0)
          setWake('awake')
        } else {
          setWake('fail')
        }
      } catch {
        if (!cancelled) setWake('fail')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="cw">
      <button type="button" className="wizback" onClick={() => navigate('/providers')}>
        ← Back
      </button>
      <div className="wizactions">
        {alreadyDone && (
          <button
            type="button"
            className="wizskip"
            onClick={() => navigate(nextRoute('companion'))}
          >
            Skip →
          </button>
        )}
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
      <Stepper active={1} />

      <div className="cw__center">
        <div className="cw__kicker mono">
          primary · {primary ? modelLabel.toLowerCase() : 'not set'}
          {wake === 'waking' && <span className="cw__wake cw__wake--busy"> · waking…</span>}
          {wake === 'awake' && (
            <span className="cw__wake cw__wake--ok"> · ✓ awake in {(rtt / 1000).toFixed(1)}s</span>
          )}
          {wake === 'fail' && (
            <span className="cw__wake cw__wake--err"> · unreachable — you can still continue</span>
          )}
        </div>

        <div className="cw__orb-wrap">
          <div className="cw__orb" />
          <div className="cw__halo" />
          <div className="cw__halo cw__halo--outer" />
        </div>

        <div className="cw__title">
          {name} is now your <span className="cw__title-strong">Companion</span>.
        </div>
        <div className="cw__sub">
          Think of me as your co-founder from here on — I plan with you, draft the work,
          and you approve every move.
          <br />
          Nothing runs on its own.
        </div>

        {/* the primary's REAL first words (from the live handshake) */}
        {wake === 'awake' && greeting && (
          <div className="cw__greeting">&ldquo;{greeting}&rdquo;</div>
        )}

        {/* name your co-founder — it becomes a named agent in the library */}
        <div className="cw__namerow">
          <input
            className="cw__nameinput"
            value={draftName}
            placeholder={`give your co-founder a name — e.g. "Prism"`}
            aria-label="Name your co-founder agent"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveName()
              }
            }}
          />
          <button type="button" className="cw__namesave" disabled={!draftName.trim()} onClick={saveName}>
            {settings.companionName && settings.companionName === draftName.trim() ? '✓ named' : 'Name it'}
          </button>
        </div>
        {settings.companionName && (
          <div className="cw__namenote mono">
            “{settings.companionName}” · runs on {modelLabel} · added to your agent library
          </div>
        )}

        <Link
          to={nextRoute('companion')}
          className="cw__continue"
          onClick={() => completeStep('companion')}
        >
          Continue →
        </Link>
      </div>

      {/* motion trail to dock */}
      <svg width="360" height="260" viewBox="0 0 360 260" className="cw__trail">
        <path
          d="M20 20 C 160 60, 260 130, 322 218"
          fill="none"
          stroke="rgba(130,120,220,.4)"
          strokeWidth="1.5"
          strokeDasharray="3 7"
        />
      </svg>
      <div className="cw__spark cw__spark--far" />
      <div className="cw__spark cw__spark--near" />

      <div className="cw__dock">
        <div className="cw__dock-note">settling in, bottom-right — always here</div>
        <div className="cw__dock-orb" />
      </div>
    </div>
  )
}
