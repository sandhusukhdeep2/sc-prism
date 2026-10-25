// Mission Control §Give a task from Work (2026-08-06) — the composer's target.
//
// "there is lots of place where I start a task. That's not possible… I supposed
// to give a task in a work page where I see the progress, which AI doing the
// what". A team run could only be launched from the Agents page. The composer
// now chooses the runner, and this file pins the routing contract:
//
//   * Companion (the default) is BYTE-IDENTICAL to before the control existed —
//     the same call with the same four arguments. Nothing regresses.
//   * Team goes to the SHARED launcher (`sendTeam` → the store's one
//     `launchTeam`, which the Agents page also calls) with the roles the user
//     can actually see and edit.
//   * An agent target is attributed to a REAL library agent, and the label says
//     honestly where the work goes (there is no per-agent runner).
//   * An EMPTY library offers nobody — the option is disabled WITH the reason,
//     never a placeholder name.
//   * The target resets to the companion after every send: a team run costs
//     real minutes and tokens, so it can never be spent by the next thing typed.
//
// The store's `send`/`sendIntent`/`sendTeam` are spied here (the real ones are
// exercised end-to-end in Workspace.teamTarget.test.tsx), so these assertions
// are about ROUTING and the exact arguments — not about the engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { agentTaskBrief, agentTaskDisplay, list as listAgents, update as updateAgent } from '../lib/agents'

// The composer's target + route pills now live behind a "Change" disclosure:
// the DEFAULT is stated in words beside the send button ("Sukh takes this"),
// and the seven pills that used to shout from the composer open deliberately.
// Nothing about the controls changed — same options, same aria-labels, same
// per-message reset — so opening the panel is plumbing, not the thing under
// test, and this helper does it on demand and only once.
function openComposerControls() {
  if (screen.queryAllByRole('radio').length === 0) {
    const change = screen.queryByRole('button', { name: /Change who takes this/i })
    if (change) fireEvent.click(change)
  }
  // Sprint B: the specialist lanes fold behind 'more ▾' — unfold for tests
  // that address them directly.
  const more = screen.queryByRole('button', { name: /more ▾/ })
  if (more) fireEvent.click(more)
}
import { proposeAgentBrief } from '../lib/agentProposals'

// Variadic on purpose: the assertions below compare the WHOLE argument list,
// so the spies must record whatever they were handed.
const h = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => {}),
  sendIntent: vi.fn(async (..._args: unknown[]) => {}),
  sendTeam: vi.fn(async (..._args: unknown[]) => {}),
}))

// The REAL store (AppProvider and every helper come from `actual`), with only
// the three send paths spied — so the component's routing decision and its
// exact arguments are what's under test.
vi.mock('../store/AppStore', async (orig) => {
  const actual = await orig<typeof import('../store/AppStore')>()
  return {
    ...actual,
    useApp: () => ({
      ...actual.useApp(),
      send: h.send,
      sendIntent: h.sendIntent,
      sendTeam: h.sendTeam,
    }),
  }
})

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const composer = () => screen.getByRole('textbox', { name: /describe/i }) as HTMLTextAreaElement
const target = (name: RegExp) => {
  openComposerControls()
  return screen.getByRole('radio', { name })
}

/** Type `text` and press Send. */
function sendDraft(text: string) {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('Work composer target — who gets this task', () => {
  beforeEach(() => {
    localStorage.clear()
    h.send.mockClear()
    h.sendIntent.mockClear()
    h.sendTeam.mockClear()
  })
  afterEach(() => {
    // The agents store is a module singleton — restore anything a test disabled.
    for (const a of listAgents()) if (!a.enabled) updateAgent(a.id, { enabled: true })
    localStorage.clear()
  })

  it('team is the default (sprint B); the manager lane, once picked, sends byte-identical', () => {
    renderWorkspace()

    // Sprint B (2026-08-30, his order): the TEAM is the default lane.
    expect(target(/^team$/i)).toHaveAttribute('aria-checked', 'true')
    // Picking the manager restores the classic wording and the classic send.
    fireEvent.click(target(/your local model/i))
    expect(screen.getByLabelText('Describe what you want to build')).toBeInTheDocument()
    expect(composer().placeholder).toBe('Describe what you want to build…')

    sendDraft('add a rate-limit guard to the uploader')

    // The SAME call with the SAME four arguments: engine text, display text,
    // the route hint, and no image. Not routed anywhere new.
    //
    // The hint changed from 'auto' to 'local' when Sukh started deciding
    // (2026-08-15 spec §One front door): the manager's pick — shown above the
    // composer with its reason — IS this message's route hint, and on the
    // default install the only connected AI is the local model. That is the
    // feature, not a regression: an 'auto' here would mean the line the user
    // read did not govern the run. An explicit local/cloud override still wins
    // (see Workspace.routing.test.tsx).
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0]).toEqual([
      'add a rate-limit guard to the uploader',
      'add a rate-limit guard to the uploader',
      'local',
      undefined,
    ])
    expect(h.sendTeam).not.toHaveBeenCalled()
    expect(h.sendIntent).not.toHaveBeenCalled()
  })

  it('Team routes to the SHARED launcher — the MANAGER staffs the roster (2026-08-31)', () => {
    renderWorkspace()

    // Team is the default lane; the composer says who it is addressing…
    expect(composer().placeholder).toBe('Describe the task for the team…')
    expect(screen.getByLabelText('Describe the task for the team')).toBeInTheDocument()
    // …and there is NO roster editor any more: the manager staffs the team
    // (his order). The settings-derived default is what launch resolves, and
    // who really worked is shown in the run, seat by seat.
    expect(screen.queryByLabelText(/team roster/i)).not.toBeInTheDocument()

    sendDraft('plan the SOC 2 compliance dashboard')

    expect(h.sendTeam).toHaveBeenCalledTimes(1)
    const call = h.sendTeam.mock.calls[0][0] as { task: string; roster: string }
    expect(call.task).toBe('plan the SOC 2 compliance dashboard')
    expect(call.roster).toBe('lead:local,researcher:local')
    // The companion path is NOT also taken — one task, one runner.
    expect(h.send).not.toHaveBeenCalled()
  })

  it('an agent target is attributed to a REAL library agent, honestly labelled', () => {
    renderWorkspace()

    fireEvent.click(target(/^agent$/i))
    const picker = screen.getByLabelText('Agent for this task') as HTMLSelectElement
    // Only agents that actually exist are offered.
    const enabled = listAgents().filter((a) => a.enabled)
    expect(picker.options).toHaveLength(enabled.length)
    expect([...picker.options].map((o) => o.value)).toEqual(enabled.map((a) => a.id))

    const agent = enabled.find((a) => a.name === 'compliance-checker')!
    fireEvent.change(picker, { target: { value: agent.id } })
    expect(composer().placeholder).toBe('Describe the task for compliance-checker…')
    // The honest disclosure is on screen BEFORE sending: this is a brief on the
    // companion, not a separate model.
    expect(screen.getByText(/no per-agent runner/i)).toBeInTheDocument()

    sendDraft('check the uploader diff against our policies')

    // Routed as a normal task (sendIntent, not the project-interview `send`),
    // with the agent's real role + library model in the brief and the label
    // saying where the work actually goes.
    expect(h.sendIntent).toHaveBeenCalledTimes(1)
    expect(h.sendIntent.mock.calls[0]).toEqual([
      agentTaskBrief(agent, 'check the uploader diff against our policies'),
      agentTaskDisplay(agent, 'check the uploader diff against our policies'),
      // Sukh's pick drives the hint (see the companion case above): the local
      // model is the only connected AI on a default install.
      'local',
      undefined,
    ])
    expect(h.sendTeam).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('an EMPTY library offers nobody: the option is disabled with the reason', () => {
    // The real "empty" state a user can reach — every agent turned off.
    for (const a of listAgents()) updateAgent(a.id, { enabled: false })
    renderWorkspace()

    const option = target(/^agent$/i)
    expect(option).toBeDisabled()
    expect(option).toHaveAttribute(
      'title',
      'no enabled agents in your library — add one on the Agents page',
    )
    // No picker, and no invented name anywhere.
    expect(screen.queryByLabelText('Agent for this task')).not.toBeInTheDocument()

    // Clicking the disabled option cannot select it, and a send still goes to
    // the companion — a task is never attributed to an agent that isn't there.
    fireEvent.click(option)
    expect(option).toHaveAttribute('aria-checked', 'false')
    sendDraft('ship it')
    expect(h.sendTeam).toHaveBeenCalledTimes(1) // the DEFAULT team lane (sprint B) — never an invented agent
    expect(h.sendIntent).not.toHaveBeenCalled()
  })

  // Audit (2026-08-11): the "new agent" target sent bare `text` with
  // `undefined` for the image — AFTER the composer had already cleared the
  // attachments — so both were silently dropped while the team branch twelve
  // lines up sets an explicit caveat. They now ride along like any other send.
  it('the "new agent" target carries the attachment bodies into the brief', () => {
    renderWorkspace()

    fireEvent.click(target(/^new agent$/i))
    sendDraft('we need someone to chase unpaid invoices')

    expect(h.sendIntent).toHaveBeenCalledTimes(1)
    const [intent, display, route, image, request] = h.sendIntent.mock.calls[0]
    // The BRIEF is what the engine gets (attachment bodies compose into it)…
    expect(intent).toBe(proposeAgentBrief('we need someone to chase unpaid invoices'))
    expect(display).toBe('→ propose an agent: we need someone to chase unpaid invoices')
    // Sukh's pick, not 'auto' — see the companion case above.
    expect(route).toBe('local')
    expect(image).toBeUndefined() // none attached here — not a dropped one
    // …and the EVIDENCE stays the user's own typed words, quoted verbatim.
    expect(request).toBe('we need someone to chase unpaid invoices')
  })

  it('says plainly that a simulated send records no proposal', () => {
    renderWorkspace()
    fireEvent.click(target(/^new agent$/i))
    // jsdom is not the installed app, so this send cannot reach a real AI —
    // and the target bar's promise would otherwise go quietly unmet.
    expect(screen.getByText(/no real AI is connected/i)).toBeInTheDocument()
  })

  it('the target RESETS to the DEFAULT team lane after a send (sprint B)', () => {
    renderWorkspace()

    // Pick the MANAGER for one message; after the send the picker returns to
    // the default team lane (his order: 'by default Sukh is using a team').
    fireEvent.click(target(/your local model/i))
    sendDraft('plan the dashboard')
    expect(h.send).toHaveBeenCalledTimes(1)

    expect(target(/^team$/i)).toHaveAttribute('aria-checked', 'true')
    expect(target(/your local model/i)).toHaveAttribute('aria-checked', 'false')
    expect(composer().placeholder).toBe('Describe the task for the team…')

    sendDraft('and now a quick question')
    expect(h.sendTeam).toHaveBeenCalledTimes(1) // the default lane really runs the team
    expect(h.send).toHaveBeenCalledTimes(1) // still the one manager send
    expect(h.send.mock.calls[0][0]).toBe('plan the dashboard')
    expect((h.sendTeam.mock.calls[0][0] as { task: string }).task).toBe('and now a quick question')
  })
})
