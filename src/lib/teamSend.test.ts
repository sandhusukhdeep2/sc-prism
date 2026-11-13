import { describe, expect, it } from 'vitest'
import { teamSend } from './teamSend'

// WHAT A TEAM SEND REALLY IS (2026-11-14): which seats run, and the one line
// that says so before the send. The line is built from the roster that is
// SENT — not from a separate guess about who might lead — so the words and the
// run cannot disagree, whatever the workload slider did to the seats.
const full = 'lead:claude-cli,researcher:local,critic:gemini'
const base = { fullRoster: full, primaryToken: 'claude-cli', picked: false, attached: false }

describe('teamSend', () => {
  it('one piece of work is two seats, and says how to get everyone', () => {
    const s = teamSend({ ...base, text: 'fix the footer link' })
    expect(s.roster).toBe('lead:claude-cli,researcher:local')
    expect(s.level).toBe('job')
    expect(s.line).toBe(
      'lead on Claude + researcher on your local model · one piece of work, so two seats — pick the team to put every AI on it',
    )
  })

  it('a big job is every seat, and says what made it big', () => {
    const s = teamSend({ ...base, text: 'audit the vault for stale notes' })
    expect(s.roster).toBe(full)
    expect(s.level).toBe('big')
    expect(s.line).toBe(
      'lead on Claude + researcher on your local model + critic on Gemini · “audit” asks for more than one pair of eyes',
    )
  })

  it('a team picked by hand is every seat, whatever was typed', () => {
    const s = teamSend({ ...base, text: 'hello', picked: true })
    expect(s.roster).toBe(full)
    expect(s.line).toContain('you picked the team')
  })

  it('a file riding along is every seat', () => {
    const s = teamSend({ ...base, text: 'fix the footer link', attached: true })
    expect(s.roster).toBe(full)
    expect(s.line).toContain('a file rides along')
  })

  it('a team of two is not cut down, and is not told it was', () => {
    const s = teamSend({ ...base, fullRoster: 'lead:claude-cli,researcher:local', text: 'fix the footer link' })
    expect(s.roster).toBe('lead:claude-cli,researcher:local')
    expect(s.line).toBe('lead on Claude + researcher on your local model · one piece of work')
  })

  it('names the seats as the workload slider seated them', () => {
    const s = teamSend({
      ...base,
      fullRoster: 'lead:local,researcher:local,critic:claude-cli',
      text: 'fix the footer link',
    })
    expect(s.roster).toBe('researcher:local,critic:claude-cli')
    expect(s.line).toContain('researcher on your local model + critic on Claude')
  })

  it('with nobody to seat there is no line to draw', () => {
    expect(teamSend({ ...base, fullRoster: '', text: 'fix it' })).toEqual({ roster: '', level: 'job', line: '' })
  })
})
