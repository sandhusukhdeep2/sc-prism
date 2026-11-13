// SETTINGS, IN CATEGORIES (2026-11-12).
//
// Settings was one scroll of every control the app has. The owner's reference
// — the coworker app he uses daily — shows settings as a short list of
// categories with one on screen at a time, and a search that finds a control
// by what it is called. This is that list. The page reads which section is
// open from its own address (`?section=`), so a link can point at one.

export type SettingsSectionId = 'ais' | 'routing' | 'capabilities' | 'you' | 'connections' | 'setup'

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  /** One line under the title: what is in here. */
  blurb: string
  /** The controls in this section, by the words a person would type to find
   *  them. Search matches these and the label. */
  keywords: string[]
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'ais',
    label: 'Your AIs',
    blurb: 'The AIs this app can use: a local model, subscriptions, API keys.',
    keywords: [
      'provider', 'providers', 'local model', 'claude', 'gemini', 'openai', 'chatgpt', 'codex',
      'api key', 'subscription', 'custom endpoint', 'model', 'effort', 'thinking', 'primary',
    ],
  },
  {
    id: 'routing',
    label: 'Routing & workload',
    blurb: 'Which AI does what: who plans, who does the work, who checks.',
    keywords: [
      'routing', 'pinned', 'auto', 'workload', 'slider', 'dependency', 'local', 'cloud', 'seats',
      'token budget', 'budget', 'alert', 'second opinion',
    ],
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    blurb: 'What agents may do: the included libraries, plugins, the web, your computer.',
    keywords: [
      'extensions', 'lightrag', 'graph', 'deepeval', 'gateway', 'daemon', 'plugin', 'plugins', 'mcp',
      'servers', 'web research', 'search', 'computer control', 'screen', 'terminal', 'local vision',
      'approvals', 'approve', 'grants',
    ],
  },
  {
    id: 'you',
    label: 'You & appearance',
    blurb: 'The theme, and what the app calls you.',
    keywords: ['appearance', 'theme', 'dark', 'light', 'colour', 'color', 'your name', 'name'],
  },
  {
    id: 'connections',
    label: 'Connections',
    blurb: 'Hosting for a team, and Telegram.',
    keywords: ['hosting', 'company', 'join code', 'team', 'telegram', 'phone', 'notifications', 'github'],
  },
  {
    id: 'setup',
    label: 'Setup',
    blurb: 'Start the setup again, or reset it.',
    keywords: ['reset', 'setup', 'wizard', 'onboarding', 'start over'],
  },
]

/** The section an address names; anything else is the first one. */
export function sectionFromParam(value: string | null | undefined): SettingsSectionId {
  const hit = SETTINGS_SECTIONS.find((s) => s.id === value)
  return hit ? hit.id : SETTINGS_SECTIONS[0].id
}

/** The sections whose name or controls contain what was typed, in page order.
 *  Nothing typed lists them all. */
export function findSections(query: string): SettingsSection[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...SETTINGS_SECTIONS]
  return SETTINGS_SECTIONS.filter(
    (s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q)),
  )
}
