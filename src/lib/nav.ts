// Navigation model for the SC Prism client.
// `topNav` = the primary in-app nav. `pages` = the full 21-page map used by the
// bottom page navigator (mirrors design/DESIGN-PROMPTS-full.md).

import type { IconName } from '../components/Icon'

export type NavItem = { to: string; label: string; icon: IconName }
export type NavSection = { heading: string; items: NavItem[] }
export type PageItem = { num: string; to: string; title: string }

/**
 * THE ONE NAVIGATION, for every page (2026-08-27).
 *
 * It used to be three primary links plus a "More ▾" dropdown, and that shape
 * was the whole complaint: seven destinations lived behind a button, so those
 * pages had no navigation of their own at all — you arrived, and the only
 * chrome was a dropdown you had to remember existed. Work meanwhile had a left
 * sidebar (its chats and projects) that no other page shared, so the app looked
 * like two different applications depending on where you stood.
 *
 * One persistent sidebar fixes both. Every destination is visible on every
 * page, nothing hides behind a menu, and Work's chats/projects list becomes
 * what it always was — a panel belonging to Work, sitting beside the app's
 * navigation rather than standing in for it.
 *
 * The sections are the honest grouping of what the app does: the two places you
 * work, the crew you work with, and the record of what happened.
 */
export const sideNav: NavSection[] = [
  {
    heading: 'Work',
    items: [
      { to: '/', label: 'Work', icon: 'work' },
      { to: '/vault', label: 'Vault', icon: 'vault' },
    ],
  },
  {
    heading: 'Crew',
    items: [
      { to: '/agents', label: 'Agents', icon: 'agents' },
      { to: '/skills', label: 'Skills', icon: 'skills' },
      { to: '/automations', label: 'Automations', icon: 'automations' },
      { to: '/training', label: 'Training', icon: 'training' },
    ],
  },
  {
    heading: 'Record',
    items: [
      { to: '/stats', label: 'Stats', icon: 'stats' },
      { to: '/memory', label: 'Memory', icon: 'memory' },
      { to: '/console', label: 'Console', icon: 'console' },
    ],
  },
]

/** Settings sits on its own at the foot of the rail: it is where you go to
 *  change the app, not one of the places you work in it. */
export const settingsNav: NavItem = { to: '/settings', label: 'Settings', icon: 'settings' }

/** Every destination in the rail, in render order — the flat view, for tests
 *  and for anything that needs to ask "is this route in the navigation?". */
export const allNav: NavItem[] = [...sideNav.flatMap((s) => s.items), settingsNav]

export const pages: PageItem[] = [
  { num: '01', to: '/welcome', title: 'Welcome' },
  { num: '02', to: '/providers', title: 'Providers' },
  { num: '03', to: '/companion-wakes', title: 'Companion wakes' },
  { num: '04', to: '/vault-setup', title: 'Vault location' },
  { num: '05', to: '/github', title: 'GitHub auth' },
  { num: '06', to: '/interview', title: 'Business interview' },
  { num: '07', to: '/governance-review', title: 'Review & activate' },
  { num: '08', to: '/', title: 'Workspace · Chat' },
  { num: '09', to: '/editor', title: 'Workspace · Editor' },
  { num: '10', to: '/verdict', title: 'Agent + Verdict detail' },
  { num: '11', to: '/approval', title: 'Approval gate' },
  { num: '12', to: '/vault', title: 'Vault browser' },
  { num: '13', to: '/stats', title: 'Stats' },
  { num: '14', to: '/console', title: 'Console' },
  { num: '15', to: '/settings', title: 'Settings' },
  { num: '17', to: '/automations', title: 'Automations' },
  { num: '19', to: '/agents', title: 'Agent library' },
  { num: '20', to: '/skills', title: 'Skills library' },
  { num: '21', to: '/memory', title: 'Memory & learning' },
]
