import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ConsoleActivity, { agoLabel, activityGlyph } from './ConsoleActivity'
import type { ActivityItem } from '../lib/activity'

const NOW = 1_000_000_000_000

describe('agoLabel', () => {
  it('formats minutes / hours / days and "just now"', () => {
    expect(agoLabel(NOW - 10_000, NOW)).toBe('just now')
    expect(agoLabel(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(agoLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(agoLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })
})

describe('activityGlyph', () => {
  it('is a check/cross for a passed/failed run, and a symbol per other kind', () => {
    expect(activityGlyph({ kind: 'run', label: '', when: 0, ok: true })).toBe('✓')
    expect(activityGlyph({ kind: 'run', label: '', when: 0, ok: false })).toBe('✕')
    expect(activityGlyph({ kind: 'skill', label: '', when: 0 })).toBe('◆')
    expect(activityGlyph({ kind: 'created', label: '', when: 0 })).toBe('＋')
  })
})

describe('ConsoleActivity', () => {
  it('renders exactly the items given — a failed run, a skill, a created event — with the right glyph classes', () => {
    const items: ActivityItem[] = [
      { kind: 'run', label: 'run failed · claude, local, gemini', when: NOW - 3 * 60_000, ok: false },
      { kind: 'skill', label: 'skill used: portfolio-skill', when: NOW - 6 * 3_600_000 },
      { kind: 'created', label: 'created agent: page-builder', when: 0 },
    ]
    render(<ConsoleActivity items={items} now={NOW} />)

    expect(screen.getByText('run failed · claude, local, gemini')).toBeInTheDocument()
    expect(screen.getByText('skill used: portfolio-skill')).toBeInTheDocument()
    expect(screen.getByText('created agent: page-builder')).toBeInTheDocument()

    // A failed run gets the fail modifier so it reads red at a glance.
    const failGlyph = document.querySelector('.ws__actglyph--fail')
    expect(failGlyph).not.toBeNull()
    expect(failGlyph?.textContent).toBe('✕')

    // Relative time shows for real timestamps, and is omitted for when === 0.
    expect(screen.getByText('3m ago')).toBeInTheDocument()
    expect(screen.getByText('6h ago')).toBeInTheDocument()
    // The created row (when 0) renders no time chip → exactly two time chips.
    expect(document.querySelectorAll('.ws__actwhen').length).toBe(2)
  })

  it('renders nothing for an empty feed (never a placeholder row)', () => {
    const { container } = render(<ConsoleActivity items={[]} now={NOW} />)
    expect(container.querySelectorAll('.ws__actrow').length).toBe(0)
  })
})
