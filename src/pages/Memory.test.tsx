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

  it('links out to the real learning gate on the Training page', () => {
    renderMemory()
    const link = screen.getByRole('link', { name: /see real learning on the training page/i })
    expect(link).toHaveAttribute('href', '/training')
  })
})

// P8 honesty: a failed/unparseable OKF validation is a DISTINCT outcome, not a
// stuck 'checking…' forever. runNativeOkf swallows errors and returns null, so
// the badge must surface a real error state the user can act on.
describe('OKF validation — a failure looks like a failure', () => {
  const okReport: OkfReport = { ok: true, issues: [], warnings: [], doc_count: 3 }

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

// P3 honesty: status colors must tell the truth. A budget breach and a rising
// marginal cost are WARNINGS — they may never render in success green. Both are
// driven by the real store, so we seed the durable session (the shape AppStore's
// loadSession restores) and assert the warn modifier class is applied.
describe('Memory page — status colors tell the truth', () => {
  const baseStats = { tokensToday: 1240, costToday: 0.04, tier1Saves: 7, localSharePct: 61, evalAvg: 0.91 }
  const makeVerdict = (cost: number) => ({
    taskId: 't', task: 'x',
    route: { target: 'local', model: 'm', via: '', reason: '', routeLabel: '' },
    tier1: { tests: '0/0', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.9, passed: true, judge: 'j', trajectory: 'ok' },
    tokensIn: 1, tokensOut: 1, cost, durationMs: 1, modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true }, passed: true,
  })
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

  it('paints a rising marginal-cost trend as a warning (trending up uses the warn class)', () => {
    // Newest-first (ADD_VERDICT prepends); reversed = [0.02, 0.20] → cost rising.
    seed({ verdicts: [makeVerdict(0.2), makeVerdict(0.02)] })
    renderMemory()
    const trend = screen.getByText(/marginal cost per task/)
    expect(trend.textContent).toMatch(/trending up/)
    expect(trend).toHaveClass('mem-cost__trend--up')
  })
})
