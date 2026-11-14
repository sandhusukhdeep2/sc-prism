import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'

// The composer's target + route pills now live behind a "Change" disclosure:
// the DEFAULT is stated in words beside the send button ("Sukh takes this"),
// and the seven pills that used to shout from the composer open deliberately.
// Nothing about the controls changed — same options, same aria-labels, same
// per-message reset — so opening the panel is plumbing, not the thing under
// test, and this helper does it on demand and only once.
function openComposerControls() {
  if (screen.queryAllByRole('radio').length > 0) return
  const change = screen.queryByRole('button', { name: /Change who takes this/i })
  if (change) fireEvent.click(change)
}
import { AppProvider } from '../store/AppStore'

// P8: the composer is a multi-line auto-growing <textarea> — Enter sends,
// Shift+Enter inserts a newline. This is the revert-failing guard for that
// keyboard contract (mirrors Workspace.meter.test.tsx's provider stack, runs
// non-native so the file-attach / vault effects stay out of scope).
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

describe('Workspace composer — multi-line textarea (Enter sends, Shift+Enter newline)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('is a textarea and treats Enter and Shift+Enter differently', () => {
    renderWorkspace()

    const field = screen.getByLabelText('Describe the task for the team') as HTMLTextAreaElement
    expect(field.tagName).toBe('TEXTAREA')

    fireEvent.change(field, { target: { value: 'line one' } })

    // Shift+Enter must NOT send: the handler leaves the default (newline)
    // behavior in place and the draft is untouched.
    const shiftEnter = fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(shiftEnter).toBe(true) // default not prevented
    expect(field.value).toBe('line one')

    // Enter sends: the handler intercepts it (prevents the default newline) and
    // clears the composer, proving the send path ran.
    const enter = fireEvent.keyDown(field, { key: 'Enter' })
    expect(enter).toBe(false) // default prevented
    expect(field.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// A2 (2026-08-11 acceptance walk) — the textarea must have REAL width.
//
// The task-giving feature (78621de) added a 4-option target selector to the
// composer's single flex row, which already held the attach + image buttons,
// the textarea, a hint, the 3-option route control and send. The textarea
// collapsed to a ~40px column: the placeholder rendered as "Descr / ibe what /
// you want t…" and the app's primary action became unusable.
//
// 2026-11-14 ("Visible agents"): the composer is ONE ROW again, as the room's
// mockup draws it — attach · the words · who takes them · Send. What made the
// single row collapse is still kept out of it: the target and route PILLS open
// in a panel above the row, never beside the field; the row wraps; and the
// field has a floor it will not shrink below.
//
// jsdom does no layout, so a width assertion here would be theatre. The honest
// unit-testable invariant is STRUCTURAL — the pills are never the textarea's
// siblings — plus the CSS declarations that give the field its floor. Said
// plainly because it is a proxy: the real proof is the screenshot.
// ---------------------------------------------------------------------------
describe('Workspace composer layout — the pills never share the textarea’s row', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('the row holds the words and Send; the target + route pills open outside it', () => {
    renderWorkspace()
    const field = screen.getByLabelText('Describe the task for the team')
    const send = screen.getByRole('button', { name: 'Send' })

    // One row, as the mockup draws it: the field and Send side by side.
    const row = field.parentElement as HTMLElement
    expect(row.className).toContain('chat__composerrow')
    expect(send.parentElement).toBe(row)

    // The regression, stated structurally: the pills used to be SIBLINGS of
    // the textarea, dividing its width with it. Disclosed, they sit in their
    // own panel in the composer — not in the row.
    openComposerControls()
    const who = screen.getByRole('radiogroup', { name: 'Who does this task' })
    const route = screen.getByRole('radiogroup', { name: 'Route for this message' })
    expect(row.contains(who)).toBe(false)
    expect(row.contains(route)).toBe(false)
    const composer = row.parentElement as HTMLElement
    expect(composer.className).toContain('chat__composer')
    expect(composer.contains(who)).toBe(true)
    expect(composer.contains(route)).toBe(true)
  })

  it('keeps every control and its aria-label (layout-only change)', () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: /change who takes this/i }))
    fireEvent.click(screen.getByRole('button', { name: /more ▾/ }))
    // Collapsed, the composer still states the default in words and offers the
    // way to change it — the choice is never hidden, only quiet.
    expect(screen.getByRole('button', { name: /Change who takes this/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()

    openComposerControls()
    expect(screen.getByRole('radiogroup', { name: 'Who does this task' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Route for this message' })).toBeTruthy()
    // the 4 target options and the 3 route options, all still present
    for (const label of ['team', 'agent', 'new agent', 'auto', 'local', 'cloud']) {
      openComposerControls()
      expect(screen.getByRole('radio', { name: label })).toBeTruthy()
    }
    // Send says what it does in a word; the "Enter to send" hint beside it is
    // gone (2026-11-14) — one fewer thing on the row.
    expect(screen.getByRole('button', { name: 'Send' })).toHaveTextContent('Send')
    expect(screen.queryByText('Enter to send')).toBeNull()
  })

  it('the row wraps and the field keeps a floor — narrow windows and long labels', () => {
    const css = readFileSync('src/pages/Workspace.css', 'utf8')
    const block = (sel: string) => {
      const m = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 's'))
      expect(m, `${sel} block missing`).not.toBeNull()
      return m![1]
    }
    // the panel of pills stacks above the row
    expect(block('.chat__composer')).toMatch(/flex-direction:\s*column/)
    // the surface token this repo's dark-theme rule depends on is untouched
    expect(block('.chat__composer')).toMatch(/background:\s*var\(--input-fill\)/)
    // a tight window pushes who/Send onto their own line…
    expect(block('.chat__composerrow')).toMatch(/flex-wrap:\s*wrap/)
    // …because the field will not shrink below a readable width, and takes
    // whatever the row has left.
    expect(block('.chat__input')).toMatch(/min-width:\s*200px/)
    expect(block('.chat__input')).toMatch(/flex:\s*1 1/)
  })
})
