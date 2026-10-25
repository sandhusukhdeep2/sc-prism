// SC Prism — the run/skill/created activity feed, rendered as console rows.
// Pure + presentational: it renders exactly the ActivityItem[] it's given
// (from `projectActivity`, lib/activity.ts) — never invents a row. It lives in
// the engine console at the bottom of the Work page's chat column (a better
// home than an empty "last run" box). `now` is injected so it stays pure/testable.
import type { ActivityItem } from '../lib/activity'

export function agoLabel(when: number, now: number): string {
  const m = Math.round((now - when) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / (60 * 24))}d ago`
}

export function activityGlyph(item: ActivityItem): string {
  if (item.kind === 'run') return item.ok ? '✓' : '✕'
  if (item.kind === 'skill') return '◆'
  if (item.kind === 'created') return '＋'
  return '•'
}

export default function ConsoleActivity({ items, now }: { items: ActivityItem[]; now: number }) {
  return (
    <>
      {items.map((item, i) => (
        <div key={`${item.kind}-${item.when}-${i}`} className="ws__actrow">
          <span
            className={
              'ws__actglyph' +
              (item.kind === 'run' ? (item.ok ? ' ws__actglyph--ok' : ' ws__actglyph--fail') : '')
            }
          >
            {activityGlyph(item)}
          </span>
          <span className="ws__actlabel">{item.label}</span>
          {item.when > 0 && <span className="ws__actwhen">{agoLabel(item.when, now)}</span>}
        </div>
      ))}
    </>
  )
}
