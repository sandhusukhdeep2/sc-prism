import { describe, expect, it } from 'vitest'
import { smallMessage } from './messageWeight'

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
