// Icon — the app's ONE icon set.
//
// Before this there was no set: PrismMark plus a dozen one-off inline SVGs
// scattered through pages, each with its own stroke weight and corner
// treatment, and a navigation rail with no icons at all. That is what "not
// professional" looks like up close — not a missing feature, a missing system.
//
// THE RULES, so the set stays one set:
//  · 24×24 box, 1.6 stroke, round caps and joins. Every glyph is drawn on the
//    same grid at the same weight, so they sit together without one shouting.
//  · `currentColor` only. An icon takes the colour of the thing it sits in,
//    which is what lets the rail invert on dark themes and lets an active pill
//    flip its icon to the on-accent colour with no second asset.
//  · Geometry, not decoration. Each glyph says what its destination does; none
//    of them is a picture of a thing the app does not have.
//  · Presentational by default (`aria-hidden`), because the label beside it is
//    the accessible name. Pass `title` only where the icon stands alone.
//
// Adding one: draw it in the same 24×24 box, keep strokes on half-pixel
// centres where they meet an edge, and add it to `PATHS` — nothing else.
export type IconName =
  | 'work'
  | 'vault'
  | 'agents'
  | 'skills'
  | 'automations'
  | 'training'
  | 'stats'
  | 'memory'
  | 'console'
  | 'settings'
  | 'search'
  | 'bell'
  | 'close'
  | 'chevron'
  | 'plus'
  | 'share'
  | 'calendar'
  | 'lock'
  | 'check'
  | 'spark'
  | 'attach'
  | 'image'

/** The paths, one entry per glyph. Drawn on a 24×24 grid, stroked, never filled
 *  (a filled glyph would break the currentColor inversion the rail depends on). */
const PATHS: Record<IconName, JSX.Element> = {
  // Work — a conversation. The Work page IS the chat, so the glyph says so
  // rather than showing a generic dashboard grid it does not have.
  work: (
    <>
      <path d="M20.5 12.2a7.5 7.5 0 0 1-10.9 6.7L4.5 20l1.2-4.9A7.5 7.5 0 1 1 20.5 12.2Z" />
    </>
  ),
  // Vault — notes kept safe: a folded archive box with a latch.
  vault: (
    <>
      <rect x="3.5" y="6.5" width="17" height="13" rx="2.5" />
      <path d="M3.5 10.5h17" />
      <path d="M10.5 14.5h3" />
    </>
  ),
  // Agents — a crew: two coworkers, one behind the other.
  agents: (
    <>
      <circle cx="9.5" cy="9" r="3.2" />
      <path d="M3.8 19.2a5.9 5.9 0 0 1 11.4 0" />
      <path d="M16 6.3a3.2 3.2 0 0 1 0 5.7" />
      <path d="M17.6 14.6a5.9 5.9 0 0 1 2.6 4.6" />
    </>
  ),
  // Skills — a library: a book that can be opened and taught from.
  skills: (
    <>
      <path d="M4.5 5.2A2 2 0 0 1 6.5 4H12v15H6.5a2 2 0 0 0-2 1.4Z" />
      <path d="M19.5 5.2A2 2 0 0 0 17.5 4H12v15h5.5a2 2 0 0 1 2 1.4Z" />
    </>
  ),
  // Automations — work that comes round again: a clock closing its own loop.
  automations: (
    <>
      <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6" />
      <path d="M20.4 4.2v4.2h-4.2" />
      <path d="M12 7.8V12l2.8 1.7" />
    </>
  ),
  // Training — aim and correction: rings closing on a centre.
  training: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.9" />
    </>
  ),
  // Stats — what really happened, counted.
  stats: (
    <>
      <path d="M4.5 19.5V13" />
      <path d="M9.8 19.5V6.5" />
      <path d="M15.1 19.5v-8" />
      <path d="M20.4 19.5v-4" />
    </>
  ),
  // Memory — the three tiers, stacked.
  memory: (
    <>
      <path d="M12 3.6 20.4 8 12 12.4 3.6 8Z" />
      <path d="m3.6 12 8.4 4.4 8.4-4.4" />
      <path d="m3.6 16 8.4 4.4 8.4-4.4" />
    </>
  ),
  // Console — the engine's own voice: a prompt.
  console: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m8 10 2.6 2.4L8 14.8" />
      <path d="M13.2 15h3.2" />
    </>
  ),
  // Settings — sliders, not a gear: these are values you set, not machinery.
  settings: (
    <>
      <path d="M5 7.5h14" />
      <path d="M5 16.5h14" />
      <circle cx="9.5" cy="7.5" r="2.2" />
      <circle cx="15" cy="16.5" r="2.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m15.8 15.8 4.2 4.2" />
    </>
  ),
  bell: (
    <>
      <path d="M18 16.5H6l1.3-2.2V10a4.7 4.7 0 0 1 9.4 0v4.3Z" />
      <path d="M10.2 19.2a2 2 0 0 0 3.6 0" />
    </>
  ),
  close: (
    <>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </>
  ),
  chevron: <path d="m9.5 6.5 6 5.5-6 5.5" />,
  plus: (
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>
  ),
  share: (
    <>
      <path d="M12 15.5V4.2" />
      <path d="m8 8.2 4-4 4 4" />
      <path d="M5.5 14v4.3a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V14" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M4 10h16" />
      <path d="M8.5 3.5v4" />
      <path d="M15.5 3.5v4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5" />
    </>
  ),
  check: <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />,
  // Attach — a paperclip, drawn as one continuous fold like the rest of the
  // set (the composer had a 📎 emoji here: the one glyph on the page that
  // ignored the theme, the stroke grid and currentColor all at once).
  attach: (
    <path d="m20.9 11.4-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.85 1.85 0 0 1-2.6-2.6l7.8-7.8" />
  ),
  // Image — a framed photo: horizon and sun, stroked, never a 🖼️ emoji.
  image: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <circle cx="9" cy="10.2" r="1.4" />
      <path d="m6.5 16.5 3.8-3.8 3 3 2.4-2.4 3.8 3.8" />
    </>
  ),
  // Spark — a real model answered. Used where the app marks genuine work.
  spark: (
    <>
      <path d="M12 4.2 13.7 9l4.8 1.7-4.8 1.7L12 17.2l-1.7-4.8L5.5 10.7 10.3 9Z" />
      <path d="M18.2 16.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z" />
    </>
  ),
}

export default function Icon({
  name,
  size = 18,
  title,
  className,
}: {
  name: IconName
  size?: number
  /** Give it an accessible name ONLY where the icon stands without a label. */
  title?: string
  className?: string
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}
