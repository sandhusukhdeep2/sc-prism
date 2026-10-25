import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// ONE NAVIGATION, on every page (2026-08-27). The nav used to be three primary
// links plus a "More ▾" dropdown holding seven more, which meant those seven
// pages had no navigation of their own — and Work's chats/projects list was the
// only sidebar in the app, so the two halves looked like different products.
// These tests pin the replacement: a persistent rail where every destination is
// visible from wherever you are standing. Mirrors the provider
// stack from App.smoke.test.tsx / Workspace.sidebar.test.tsx, mounted around
// AppShell directly (not the full App) with a couple of stub routes so the
// NavLinks + Outlet resolve. Onboarding is seeded "done" via localStorage (the
// key + shape onboarding.ts persists under) so AppShell doesn't redirect to
// /welcome. Runs non-native — no __TAURI_INTERNALS__ stub needed since
// OnboardingProvider only touches the native disk copy when isNative() is true.
function renderShell(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<div>work page</div>} />
                  <Route path="vault" element={<div>vault page</div>} />
                  <Route path="settings" element={<div>settings page</div>} />
                  <Route path="agents" element={<div>agents page</div>} />
                  <Route path="skills" element={<div>skills page</div>} />
                  <Route path="loop" element={<div>loop page</div>} />
                  <Route path="automations" element={<div>automations page</div>} />
                  <Route path="training" element={<div>training page</div>} />
                  <Route path="stats" element={<div>stats page</div>} />
                  <Route path="memory" element={<div>memory page</div>} />
                  <Route path="console" element={<div>console page</div>} />
                </Route>
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const DESTINATIONS = [
  'Work',
  'Vault',
  'Agents',
  'Skills',
  'Automations',
  'Training',
  'Stats',
  'Memory',
  'Console',
  'Settings',
]

// Onboarding is seeded done for EVERY describe in this file — a shell that
// redirects to /welcome renders no navigation at all, which would make every
// assertion below fail for the wrong reason.
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'scprism.onboarding',
    JSON.stringify({ completedSteps: ['welcome', 'providers', 'companion', 'vault', 'interview', 'review'], done: true }),
  )
})

afterEach(() => {
  localStorage.clear()
})

describe('AppShell navigation — one rail, every destination, every page', () => {

  it('every destination is a real link once its group is open — no dropdown menus', () => {
    renderShell()
    // Sidebar rethink (2026-08-31): quieter groups fold behind their own
    // headings — a visible, labeled toggle, not a dropdown. Open both.
    fireEvent.click(screen.getByRole('button', { name: /crew/i }))
    fireEvent.click(screen.getByRole('button', { name: /record/i }))
    for (const label of DESTINATIONS) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  // THE ACTUAL COMPLAINT: you could stand on Agents or Memory and have no
  // navigation on the page at all, because yours was inside a dropdown you had
  // to know about. Standing on each of them is the only way to prove it.
  it.each(['/agents', '/skills', '/automations', '/training', '/stats', '/memory', '/console'])(
    'gives %s the same rail as everywhere else',
    (path) => {
      renderShell(path)
      const rail = document.querySelector('nav.rail')
      expect(rail, `no rail on ${path}`).toBeTruthy()
      // The group holding THIS page is auto-open (the active pill is never
      // hidden); the other groups sit folded behind their headings.
      const label = DESTINATIONS.find((d) => path.includes(d.toLowerCase()))
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Work' })).toBeInTheDocument()
    },
  )

  it('marks the page you are on, and only that one', () => {
    renderShell('/skills')
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveClass('is-active')
    const active = document.querySelectorAll('.rail__link.is-active')
    expect(active).toHaveLength(1)
  })

  it('Work is matched exactly, so it is not active on every route', () => {
    // `/` is a prefix of every path; without an exact match Work would light up
    // on all of them and the rail would never say where you are.
    renderShell('/vault')
    expect(screen.getByRole('link', { name: 'Work' })).not.toHaveClass('is-active')
    expect(screen.getByRole('link', { name: 'Vault' })).toHaveClass('is-active')
  })

  it('navigating swaps the page and moves the marker with it', () => {
    renderShell()
    expect(screen.getByText('work page')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /crew/i })) // unfold first
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }))

    expect(screen.getByText('agents page')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveClass('is-active')
    // …and the rail is still there afterwards, which is the whole point.
    expect(document.querySelector('nav.rail')).toBeTruthy()
  })

  it('groups the rail under headings rather than listing ten flat links', () => {
    renderShell()
    const headings = [...document.querySelectorAll('.rail__heading')].map((h) =>
      (h.textContent ?? '').replace(/[▸▾]\s*$/, '').trim(),
    )
    expect(headings).toEqual(['Work', 'Crew', 'Record'])
  })

  // P2 honesty: the hardcoded always-green "Gateway" / "vault" status pills were
  // fabricated (no probe behind them). They are removed — ConnectivityDot (an
  // anchor, not a span.status) is the single honest provider-health indicator.
  it('does not render the fabricated always-green Gateway/vault status pills', () => {
    renderShell()
    expect(screen.queryByText('Gateway')).not.toBeInTheDocument()
    // The two pills were the only <span class="status"> in the chrome; the real
    // ConnectivityDot renders as an <a class="status">, so none should remain.
    expect(document.querySelectorAll('span.status').length).toBe(0)
  })
})

// Icons arrived late (2026-08-27) because the rail shipped as bare words, which
// is what "not professional" looks like up close. They are decoration ONLY in
// the sense that the label is still the accessible name — but the set has to be
// a set, and every destination has to be in it.
describe('the rail is iconographic, and the icons are a system', () => {
  it('every destination carries an icon', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: /crew/i }))
    fireEvent.click(screen.getByRole('button', { name: /record/i }))
    for (const label of DESTINATIONS) {
      const link = screen.getByRole('link', { name: label })
      expect(link.querySelector('svg.icon'), `${label} has no icon`).toBeTruthy()
    }
  })

  it('icons are presentational — the LABEL is still the accessible name', () => {
    renderShell()
    // A decorative icon that announced itself would make every link read
    // "Agents Agents" to a screen reader.
    const link = screen.getByRole('link', { name: 'Work' })
    const svg = link.querySelector('svg.icon')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelector('title')).toBeNull()
  })

  it('every glyph is drawn on the same grid at the same weight', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: /crew/i }))
    fireEvent.click(screen.getByRole('button', { name: /record/i }))
    // One set, not ten one-offs: the thing that was actually missing.
    const svgs = [...document.querySelectorAll('nav.rail svg.icon')]
    expect(svgs.length).toBe(DESTINATIONS.length)
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(svg.getAttribute('stroke-width')).toBe('1.6')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
      // currentColor + no fill is what lets the active pill flip the icon to
      // the on-accent hue without a second asset.
      expect(svg.getAttribute('fill')).toBe('none')
    }
  })

  it('no two destinations share a glyph', () => {
    renderShell()
    const shapes = [...document.querySelectorAll('nav.rail svg.icon')].map((s) => s.innerHTML)
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})

// Sidebar rethink (2026-08-31, his note: 'showing way more information than
// needed'). Crew and Record fold behind their headings by default — Work
// stays open; a folded group holding the ACTIVE page opens itself so the
// current location is never hidden; the choice persists per group.
describe('the rail folds its quieter groups', () => {

  it('Crew and Record start folded; Work stays open', () => {
    renderShell('/')
    expect(screen.getByRole('link', { name: /vault/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /skills/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /console/i })).not.toBeInTheDocument()
  })

  it('clicking a heading opens the group and remembers it', () => {
    renderShell('/')
    fireEvent.click(screen.getByRole('button', { name: /crew/i }))
    expect(screen.getByRole('link', { name: /skills/i })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('scprism.railGroups') ?? '{}').Crew).toBe(true)
  })

  it('a folded group holding the active page opens itself', () => {
    renderShell('/console')
    expect(screen.getByRole('link', { name: /console/i })).toBeInTheDocument()
  })
})
