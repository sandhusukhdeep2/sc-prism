import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Memory, { okfStatus } from './Memory'
import type { OkfReport } from '../lib/nativeEngine'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// Mirrors the provider stack from Workspace.meter.test.tsx / Projects.deeplink.test.tsx.
function renderMemory() {
  return render(
    <MemoryRouter initialEntries={['/memory']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Memory />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

// P4-1 honesty fix: the Memory page used to fabricate a "1300 +" training-record
// base and a "+0.03 eval lift ... representative" GRPO result that was never a
// real measured outcome. Both must be gone for good — every displayed number is
// now either real or an honest empty state, and the real learning gate lives on
// the dedicated Training page.
describe('Memory page — no fabricated learning figures', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('never renders the fabricated "1300" base training-record count', () => {
    renderMemory()
    expect(document.body.textContent).not.toMatch(/1300/)
  })

  it('never renders the fabricated "+0.03" eval-lift claim', () => {
    renderMemory()
    expect(document.body.textContent).not.toMatch(/\+0\.03/)
  })

  it('never renders a fake "PROMOTED" badge or a claimed "last run" fine-tune result', () => {
    renderMemory()
    expect(screen.queryByText('PROMOTED')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/last run: \+0\.03/)
    expect(document.body.textContent).not.toMatch(/2:14am/)
  })

})

// THE MEMORY PAGE IS ABOUT MEMORY (2026-11-14, the once-only pass). Under the
// three tiers and the budget gauge it used to carry a "learning flywheel": the
// local-versus-cloud share (also the rail's meter, Stats and Console), Tier-1
// saves (Stats' own hero card), a cost line (Stats), a "runs recorded" count,
// and two cards about the learning gate that only pointed at the Training tab
// beside it. The owner: "repetitive information is a lot… information is not
// totally connected". Each of those figures has one page that owns it.
describe('Memory page — it does not repeat what other pages own', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('keeps what is about memory: the three tiers and the injection budget', () => {
    renderMemory()
    for (const label of ['L1 · Profile', 'L2 · Working memory', 'L3 · Vault', 'Token budget · memory injection']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('has no share, saves, cost, run-count or learning-gate cards of its own', () => {
    renderMemory()
    const text = document.body.textContent ?? ''
    for (const gone of [
      /local vs cloud share/i,
      /Tier-1 saves/i,
      /Cost floor/i,
      /Route-policy learning/i,
      /Eval-lift gate/i,
      /runs? recorded all time/i,
      /see real learning on the training page/i,
    ]) {
      expect(text, String(gone)).not.toMatch(gone)
    }
  })

  it('is headed as what it is', () => {
    renderMemory()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Memory$/)
  })
})

// P8 honesty: a failed/unparseable OKF validation is a DISTINCT outcome, not a
// stuck 'checking…' forever. runNativeOkf swallows errors and returns null, so
// the badge must surface a real error state the user can act on.
describe('OKF validation — a failure looks like a failure', () => {
  const okReport: OkfReport = { ok: true, issues: [], warnings: [], doc_count: 3, workProducts: 0 }

  it('a null report AFTER the check completes reads as an error, never "checking" forever', () => {
    // loading has finished (false) and the engine returned no readable report.
    expect(okfStatus(false, true, null)).toBe('error')
  })

  it('still reads "checking" only while the check is genuinely in flight', () => {
    expect(okfStatus(true, false, null)).toBe('checking')
  })

  it('a clean/issue report is unaffected by the error path', () => {
    expect(okfStatus(false, false, okReport)).toBe('ok')
    const withIssue: OkfReport = { ...okReport, ok: false, issues: [{ path: 'a', code: 'c', message: 'b' }] }
    expect(okfStatus(false, false, withIssue)).toBe('issues')
  })
})

// P3 honesty: status colors must tell the truth. A budget breach is a WARNING
// and may never render in success green — and a gauge is drawn only from a
// real measurement. (The marginal-cost trend this block also covered lives on
// Stats since 2026-11-14.)
describe('Memory page — status colors tell the truth', () => {
  const baseStats = { tokensToday: 1240, costToday: 0.04, tier1Saves: 7, localSharePct: 61, evalAvg: 0.91 }
  const seed = (over: Record<string, unknown>) =>
    localStorage.setItem('scprism.session', JSON.stringify({ threads: {}, verdicts: [], stats: baseStats, ...over }))

  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  // Finding 2 (2026-08-09): the budget gauge used to compare CUMULATIVE session
  // tokens against a PER-INJECTION cap, so it read "over cap !" forever (736% on
  // the user's install). It now reads the engine's real `memory` span
  // (budget + injected_tokens); with no engine here there is no measurement, so
  // the card must say that rather than render a bar of any colour.
  it('renders no gauge at all when nothing has been measured (browser: no memory span)', () => {
    seed({ stats: { ...baseStats, tokensToday: 9000 } })
    const { container } = renderMemory()
    expect(container.querySelector('.mem-gauge')).toBeNull()
    expect(screen.queryByText('over cap !')).not.toBeInTheDocument()
    expect(document.body.textContent).toMatch(/nothing measured yet/)
  })

  it('never derives the injection gauge from cumulative session tokens', () => {
    seed({ stats: { ...baseStats, tokensToday: 9000 } })
    renderMemory()
    // 9000 session tokens against the old hardcoded 8k cap produced "9.0k / 8k".
    expect(document.body.textContent).not.toMatch(/9\.0k/)
    expect(document.body.textContent).not.toMatch(/\/ 8k budget/)
  })
})

// 2026-11-11: the L3 card said "git-synced markdown" on an install whose vault
// is not a git repository and has no repo configured. The page says it only
// when a repo is set, and names the repo.
describe('Memory page — the vault card does not claim a git sync that is not set up', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('says plain markdown on this Mac when no repo is configured', () => {
    renderMemory()
    expect(document.body.textContent).not.toMatch(/git-synced/)
    expect(screen.getByText(/markdown files on this Mac/)).toBeInTheDocument()
  })

  it('says git-synced, and to where, when a repo is configured', () => {
    localStorage.setItem('scprism.settings', JSON.stringify({ githubRepo: 'someone/notes' }))
    renderMemory()
    expect(screen.getByText(/git-synced to someone\/notes/)).toBeInTheDocument()
  })
})

// 2026-11-11: working memory has a writer now — each step of a project build
// records its outcome and the next step is shown it. The card says what the
// tier really holds; it used to describe a tier nothing wrote to.
describe('Memory page — the working-memory card says what it holds', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('describes step outcomes kept per project and reset when a build starts', () => {
    renderMemory()
    expect(screen.getByText(/each step of a project build records what it did/)).toBeInTheDocument()
    expect(screen.getByText(/starts clean with each build/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/discarded on done/)
  })
})
