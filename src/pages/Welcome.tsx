import { Link, useNavigate } from 'react-router-dom'
import { useOnboarding } from '../lib/onboarding'
import { useSettings } from '../lib/settings'
import { pickFolder } from '../lib/nativeEngine'
import './Welcome.css'

export default function Welcome() {
  const { completeStep, nextRoute } = useOnboarding()
  const { setVault, setCompanyMode } = useSettings()
  const navigate = useNavigate()

  // REAL restore: point the app at an existing vault folder and jump ahead.
  const restore = async () => {
    const picked = await pickFolder('Choose your existing vault folder')
    if (!picked) return
    setVault(picked, 'local')
    completeStep('welcome')
    navigate('/providers')
  }
  return (
    <div className="welcome">
      <div className="welcome__center">
        {/* prism mark: beam in, spectrum out */}
        <div className="welcome__prism">
          <svg width="420" height="240" viewBox="0 0 420 240" className="welcome__beams">
            <defs>
              <linearGradient id="welBeamIn" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#1d1d1f" stopOpacity="0" />
                <stop offset="1" stopColor="#1d1d1f" stopOpacity=".55" />
              </linearGradient>
              <linearGradient id="welSpec1" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#6366F1" stopOpacity=".85" />
                <stop offset="1" stopColor="#6366F1" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="welSpec2" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#22d3ee" stopOpacity=".85" />
                <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="welSpec3" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#a855f7" stopOpacity=".85" />
                <stop offset="1" stopColor="#a855f7" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line x1="10" y1="120" x2="168" y2="120" stroke="url(#welBeamIn)" strokeWidth="2.5" />
            <line x1="252" y1="112" x2="410" y2="74" stroke="url(#welSpec1)" strokeWidth="3" />
            <line x1="252" y1="120" x2="410" y2="120" stroke="url(#welSpec2)" strokeWidth="3" />
            <line x1="252" y1="128" x2="410" y2="166" stroke="url(#welSpec3)" strokeWidth="3" />
          </svg>
          <div className="welcome__orb" />
          <div className="welcome__halo" />
        </div>

        <div className="welcome__brand">
          SC <span className="welcome__brand-strong">Prism</span>
        </div>
        <div className="welcome__lead">A crew of AI coworkers on your own machine — every model in one place.</div>
        <div className="welcome__tag">Route each task to the right model, remember the results, verify the work.</div>

        {/* THE FIRST REAL FORK (company mode phase A): who is this for? Both
            paths run the same proven wizard; hosting controls live on the
            host's Settings, and member joining ships in the next update —
            the Hosting card says so in those words. */}
        <div className="welcome__fork">
          <Link
            to={nextRoute('welcome')}
            className="welcome__cta"
            onClick={() => {
              setCompanyMode('solo')
              completeStep('welcome')
            }}
          >
            Just me <span className="welcome__cta-arrow">→</span>
          </Link>
          <Link
            to={nextRoute('welcome')}
            className="welcome__cta welcome__cta--company"
            onClick={() => {
              setCompanyMode('host')
              completeStep('welcome')
            }}
          >
            My company — I&rsquo;ll host <span className="welcome__cta-arrow">→</span>
          </Link>
        </div>
        <button type="button" className="welcome__restore" onClick={() => void restore()}>
          Restore from an existing vault folder
        </button>
      </div>

      <div className="welcome__ver mono">v0.1 · solo alpha</div>
    </div>
  )
}
