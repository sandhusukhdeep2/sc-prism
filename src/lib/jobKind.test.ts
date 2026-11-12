import { describe, expect, it } from 'vitest'
import { asksForChange } from './jobKind'

// A project room has two honest lanes for a job: the team CHANGES the folder,
// or the team TALKS about it. Which one a message opens on is a rule about its
// first words — never a model's guess — and it is shown before the send.
describe('asksForChange — does this message ask for the folder to be changed?', () => {
  it('a message that opens with a change verb is a change', () => {
    for (const text of [
      'Rewrite hello.md as a warmer two-line greeting',
      'fix the failing test in parser.py',
      'Add a dark mode toggle',
      'rename the package to prism-cli',
      'make the greeting warmer',
      'Set up eslint',
      'update the README with install steps',
    ]) {
      expect(asksForChange(text), text).toBe(true)
    }
  })

  it('politeness in front does not hide the ask', () => {
    for (const text of [
      'please fix the typo in hello.md',
      'Can you add a test for the parser?',
      'could you rename it to prism-cli',
      'now remove the old file',
      'ok, write the changelog',
      "let's refactor the loader",
      'I want you to create a LICENSE file',
    ]) {
      expect(asksForChange(text), text).toBe(true)
    }
  })

  it('a question or a request to look is not a change', () => {
    for (const text of [
      'What does hello.md say?',
      'why is the build slow',
      'review the parser and tell me what is wrong',
      'explain how the loader works',
      'is the greeting warm enough?',
      'compare the two approaches',
      'summarise this project',
      'how would you add dark mode?',
    ]) {
      expect(asksForChange(text), text).toBe(false)
    }
  })

  it('nothing typed is nothing asked', () => {
    expect(asksForChange('')).toBe(false)
    expect(asksForChange('   ')).toBe(false)
  })
})
