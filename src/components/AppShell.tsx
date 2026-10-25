import { useEffect } from 'react'
import { useSettings } from '../lib/settings'
import { initialsOf } from '../lib/initials'
import { syncVaultAgents } from '../lib/agents'
import { syncVaultSkills } from '../lib/skills'
import { useState } from 'react'
import { NavLink, Navigate, Outlet, Link, useLocation } from 'react-router-dom'
import { settingsNav, sideNav } from '../lib/nav'
import { useOnboarding } from '../lib/onboarding'
import { COMPANION_MANAGER_ID, applySetupDefaultOn, useManagers } from '../lib/managers'
import { useConnectivity } from '../lib/connectivity'
import { isNative } from '../lib/nativeEngine'
import PrismMark from './PrismMark'
import Icon from './Icon'
import ConnectivityDot from './ConnectivityDot'
import FloatingPulse from './FloatingPulse'
import HeartbeatNotice from './HeartbeatNotice'
import './AppShell.css'

// Global app chrome shared by every post-setup page: top nav + connection
// status. The OLD floating Companion orb was removed (it read as disconnected
// — it had no real state); FloatingPulse is its honest replacement (2026-07-29
// heartbeat spec): it renders ONLY real beat records and pulses only while a
// wake run is live. Decisions/notices still live on the Desk's "Needs you"
// rail. Until first-run setup is complete, the whole app redirects to
// onboarding.
export default function AppShell() {
  const { settings: shellSettings } = useSettings()
  // Vault folders sync at APP START (2026-08-29): the agents and skills
  // migrations used to fire only on their pages' mounts, so a folder could
  // stay missing for as long as a page went unvisited (Sukhdeep found
  // ~/sc-vault/skills/ absent a day after skills shipped). The shell mounts
  // once per launch; pages keep their own idempotent syncs for freshness.
  useEffect(() => {
    void syncVaultAgents(shellSettings.vaultPath).catch(() => {})
    void syncVaultSkills(shellSettings.vaultPath).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { done } = useOnboarding()
  const managers = useManagers()
  const conn = useConnectivity()

  // Hook declared here (before the `done` early return below) to satisfy the
  // rules of hooks — this component must call the same hooks on every render
  // regardless of onboarding state.
  const location = useLocation()
  const [railGroups, setRailGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('scprism.railGroups') ?? '{}') as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })

  // ---- Always-on manager (2026-08-05 §Part 3) ----
  // Setup is complete, so the companion's heartbeat turns ON by itself — the
  // user asked not to have to flip a toggle to have a manager. This is the ONE
  // place that flip happens, and it is deliberately here rather than inside
  // `finish()`: it must reach BOTH a fresh finish and the installs that were
  // already `done` before this build, with the same visible notice and the
  // same one-click off (rendered below).
  //
  // `applySetupDefaultOn` is a no-op unless the user has never decided — a
  // heartbeat he switched OFF stays off through this and every later launch —
  // and a no-op after the first flip, so running it on every managers change is
  // safe. The managers dep is what makes it retry once the companion manager
  // actually exists (the driver seeds it on its first tick).
  useEffect(() => {
    if (!done || !isNative()) return
    applySetupDefaultOn(COMPANION_MANAGER_ID, Date.now())
  }, [done, managers])

  if (!done) return <Navigate to="/welcome" replace />

  // A manager job set to "ask me first" parks (pendingSince) until the user
  // decides — surface THAT, the app's only real approval park, as a visible,
  // clickable alert in the chrome until it's resolved. (The old pill read the
  // loop simulator's gate, deleted in the 2026-08-09 honesty pass.)
  const parkedCount = managers.jobs.filter((j) => (j.pendingSince ?? 0) > 0).length

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark"><PrismMark /></span>
          <span className="brand__name">SC Prism</span>
        </div>

        <div className="topbar__spacer" />

        <ConnectivityDot conn={conn} />
        {parkedCount > 0 && (
          <Link
            to="/approval"
            className="approval-pill"
            aria-label={`${parkedCount} approval${parkedCount === 1 ? '' : 's'} waiting — open the approval gate`}
          >
            <i className="dot approval-pill__dot" />
            {parkedCount} approval{parkedCount === 1 ? '' : 's'} waiting
          </Link>
        )}
        {/* The user's own initials, from the name they give in Settings. This was
            a literal "SS" — the author's — so every install showed his initials;
            with no name set it shows a neutral glyph rather than inventing one. */}
        <div
          className="avatar"
          role="img"
          aria-label={shellSettings.yourName.trim() ? `Your account — ${shellSettings.yourName.trim()}` : 'Your account'}
        >
          {initialsOf(shellSettings.yourName) || '◐'}
        </div>
      </header>

      {/* The consent notice for the default-on above — shown on whatever page
          he lands on, until he answers it. */}
      <HeartbeatNotice />

      {/* Work is the one APP SCREEN in the shell: it lays itself out to the
          window and each of its regions scrolls internally, so the shell must
          not wrap it in a second scroll container. Every other page is a
          document and keeps the scrolling `.content`. */}
      {/* THE ONE NAVIGATION. Every destination is visible from every page —
          the seven that used to live behind "More ▾" had no navigation of their
          own at all, and Work's chats/projects list was the only sidebar in the
          app, which made it look like a different application. That list is
          still Work's, and it now sits BESIDE this rail rather than instead of
          it. */}
      <div className="shell__body">
        <nav className="rail" aria-label="Main">
          {sideNav.map((section) => {
            // Sidebar rethink (2026-08-31): quieter groups fold behind their
            // headings — Work stays open; a folded group holding the ACTIVE
            // page opens itself so the current location is never hidden.
            const foldable = section.heading !== 'Work'
            const holdsActive = section.items.some((i) =>
              i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to),
            )
            const open = !foldable || holdsActive || railGroups[section.heading] === true
            return (
            <div className="rail__group" key={section.heading}>
              {foldable ? (
                <button
                  type="button"
                  className="rail__heading rail__heading--btn mono"
                  aria-expanded={open}
                  onClick={() =>
                    setRailGroups((g) => {
                      const next = { ...g, [section.heading]: !open }
                      try {
                        localStorage.setItem('scprism.railGroups', JSON.stringify(next))
                      } catch {
                        // storage full/unavailable — the fold just won't persist
                      }
                      return next
                    })
                  }
                >
                  {section.heading} {open ? '▾' : '▸'}
                </button>
              ) : (
                <div className="rail__heading mono">{section.heading}</div>
              )}
              {open && section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => 'rail__link' + (isActive ? ' is-active' : '')}
                >
                  {/* The icon takes currentColor, so the active pill flips it to
                      the on-accent hue with no second asset. */}
                  <Icon name={item.icon} />
                  <span className="rail__linktext">{item.label}</span>
                </NavLink>
              ))}
            </div>
            )
          })}
          {/* Settings is where you change the app, not one of the places you
              work in it — so it sits apart, at the foot of the rail. */}
          <div className="rail__foot">
            <NavLink
              to={settingsNav.to}
              className={({ isActive }) => 'rail__link' + (isActive ? ' is-active' : '')}
            >
              <Icon name={settingsNav.icon} />
              <span className="rail__linktext">{settingsNav.label}</span>
            </NavLink>
          </div>
        </nav>

        <main className={'content' + (location.pathname === '/' ? ' content--fit' : '')}>
          <Outlet />
        </main>
      </div>

      <FloatingPulse />
    </div>
  )
}
