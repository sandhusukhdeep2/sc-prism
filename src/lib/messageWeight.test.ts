import { describe, expect, it } from 'vitest'
import { smallMessage, messageLevel } from './messageWeight'

// The owner, 2026-11-11: "Even on a hello or go or any small message, it
// utilizes all three AIs. … Primary AI should do that." The team is the
// default lane, so every message staffed a lead, a researcher and a critic.
// Whether a message is a job is decided HERE, by rule — never by a model
// (a model never orchestrates models).
describe('smallMessage — is this a job, or just a message?', () => {
  it('a greeting or an acknowledgement is not a job', () => {
    for (const s of ['hello', 'Hi!', 'hey there', 'good morning', 'thanks', 'thank you so much', 'ok', 'okay cool', 'yes', 'no', 'bye']) {
      expect(smallMessage(s), s).toBe('a greeting')
    }
  })

  it('one word, or a couple of words with no work in them, is a short message', () => {
    for (const s of ['go', 'continue', 'test', 'ping', 'next one', 'landing page', 'and then']) {
      expect(smallMessage(s), s).toBe('a short message')
    }
  })

  it('a short question with no work in it is a short question', () => {
    for (const s of ['how are you?', 'what can you do?', 'who are you', 'are you there?', 'how does routing work?']) {
      expect(smallMessage(s), s).toBe('a short question')
    }
  })

  it('a greeting in front of a few more words is still a greeting', () => {
    expect(smallMessage('hello, how are you today?')).toBe('a greeting')
    expect(smallMessage('hey — quick one for you')).toBe('a greeting')
  })

  it('anything that names work is a job, however short', () => {
    for (const s of ['fix login', 'build the site', 'write the launch note', 'research competitors', 'deploy now', 'hello, please review my plan', 'why is the build failing?', 'summarize this']) {
      expect(smallMessage(s), s).toBe('')
    }
  })

  it('a real sentence of a task is a job', () => {
    expect(smallMessage('plan the SOC 2 compliance dashboard')).toBe('')
    expect(smallMessage('I need a pricing page with three tiers and a comparison table')).toBe('')
  })

  it('nothing typed is not a message at all', () => {
    expect(smallMessage('')).toBe('')
    expect(smallMessage('   ')).toBe('')
  })

  it('punctuation, case and emoji do not change the answer', () => {
    expect(smallMessage('HELLO!!! 👋')).toBe('a greeting')
    expect(smallMessage('Go.')).toBe('a short message')
  })
})

// THREE LEVELS (2026-11-14). The owner, after watching his tokens: "a normal
// hello, hi, or a normal thinking question — only the primary should answer…
// if things get a little complex, the primary and local; more complex, all
// the AIs. Even a normal hello takes lots of tokens and all three AIs."
//
// Two things were really wrong. A message with no words in it — he had sent
// "?" — was not "small" (the rule counted words and found none), so it staffed
// three AIs and spent 8,121 tokens. And an ordinary question longer than six
// words was a "job", so it staffed three as well.
describe('messageLevel — talk, a job, or a big job', () => {
  it('a message with no words in it is talk, never a job', () => {
    for (const text of ['?', '??', '...', '!', '👍', '🙏🙏', '—']) {
      expect(messageLevel(text).level, text).toBe('talk')
      expect(smallMessage(text), text).toBe('a short message')
    }
  })

  it('an ordinary question is talk, however long it runs', () => {
    for (const text of [
      'What is the difference between RAG and fine-tuning?',
      'why does the local model take so long to answer the first time',
      'Can you explain how the routing works in this app?',
      'how do you think we should price this for small teams',
      'is it better to keep the notes in one folder or split them by project?',
    ]) {
      expect(messageLevel(text).level, text).toBe('talk')
    }
    expect(messageLevel('What is the difference between RAG and fine-tuning?').kind).toBe('a question')
  })

  it('a remark with no work in it is talk', () => {
    expect(messageLevel('the greeting should be warmer I think').level).toBe('talk')
    expect(messageLevel('that looks good to me').level).toBe('talk')
  })

  it('one piece of work is a job', () => {
    for (const text of [
      'Rewrite hello.md as a warmer two-line greeting',
      'fix the footer link',
      'can you write a short changelog for this week?',
      'summarise the notes from yesterday',
      'What should I build next? Draft a plan.',
    ]) {
      expect(messageLevel(text).level, text).toBe('job')
    }
  })

  it('work that asks for more than one pair of eyes is a big job', () => {
    for (const text of [
      'Review the launch plan and give me a second opinion',
      'research the three pricing models and compare the options',
      'audit the vault for stale notes',
      'debate whether we should open source the engine',
      'get the whole team on this: rewrite the readme',
    ]) {
      expect(messageLevel(text).level, text).toBe('big')
    }
  })

  it('work in several parts is a big job', () => {
    expect(messageLevel('1. write the page\n2. add the tests\n3. update the changelog').level).toBe('big')
    expect(messageLevel('- fix the footer\n- rename the package').level).toBe('big')
    expect(messageLevel('write the landing page, then draft the launch post and then prepare the release notes').level).toBe('big')
  })

  it('a long brief is a big job', () => {
    const long = 'write ' + Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    expect(messageLevel(long).level).toBe('big')
  })

  it('says why, in a few words the composer can show', () => {
    expect(messageLevel('fix the footer link').why).toBe('one piece of work')
    expect(messageLevel('audit the vault for stale notes').why).toBe('“audit” asks for more than one pair of eyes')
    expect(messageLevel('- fix the footer\n- rename the package').why).toBe('work in several parts')
  })

  it('nothing typed is nothing', () => {
    expect(messageLevel('').level).toBe('talk')
    expect(smallMessage('')).toBe('')
  })
})
