import { describe, expect, it } from 'vitest'
import { initialsOf } from './initials'

// The account avatar used to be a literal "SS" — the author's initials — on
// every install. It is now derived from the name the user gives in Settings.
describe('initialsOf — the avatar shows the user, not the author', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL')
    expect(initialsOf('Grace Brewster Murray Hopper')).toBe('GH')
  })

  it('a single name gives a single letter', () => {
    expect(initialsOf('Ada')).toBe('A')
  })

  it('no name gives nothing — the shell shows a neutral glyph instead', () => {
    expect(initialsOf('')).toBe('')
    expect(initialsOf('   ')).toBe('')
  })

  it('ignores stray whitespace and is uppercase', () => {
    expect(initialsOf('  ada   lovelace  ')).toBe('AL')
  })

  it('handles names that do not start with an ASCII letter', () => {
    expect(initialsOf('Émilie du Châtelet')).toBe('ÉC')
    expect(initialsOf('李 小龍')).toBe('李小')
  })
})
