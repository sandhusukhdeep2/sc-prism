import { describe, expect, it } from 'vitest'
import { composeWithAttachments, displayLine, type ChatAttachment } from './attachments'

describe('composeWithAttachments (pure)', () => {
  it('no attachments → text unchanged', () => {
    expect(composeWithAttachments('hello there', [])).toBe('hello there')
  })

  it('no attachments, empty text → still empty', () => {
    expect(composeWithAttachments('', [])).toBe('')
  })

  it('one attachment → delimited block prepended, exact delimiters', () => {
    const attachments: ChatAttachment[] = [{ name: 'foo.ts', text: 'const x = 1' }]
    expect(composeWithAttachments('what does this do?', attachments)).toBe(
      '[Attached file: foo.ts]\nconst x = 1\n[end of file]\n\nwhat does this do?',
    )
  })

  it('many attachments → blocks prepended in order, then the text', () => {
    const attachments: ChatAttachment[] = [
      { name: 'a.md', text: 'first file' },
      { name: 'b.json', text: '{"k":1}' },
    ]
    expect(composeWithAttachments('review these', attachments)).toBe(
      '[Attached file: a.md]\nfirst file\n[end of file]\n\n' +
        '[Attached file: b.json]\n{"k":1}\n[end of file]\n\n' +
        'review these',
    )
  })

  it('attachments with no typed text → blocks only, trailing text stays empty', () => {
    const attachments: ChatAttachment[] = [{ name: 'notes.txt', text: 'hi' }]
    expect(composeWithAttachments('', attachments)).toBe(
      '[Attached file: notes.txt]\nhi\n[end of file]\n\n',
    )
  })
})

describe('displayLine (pure, compact transcript/log form)', () => {
  it('no attachments → text unchanged (no refs added)', () => {
    expect(displayLine([], 'hello there')).toBe('hello there')
  })

  it('no attachments, empty text → still empty', () => {
    expect(displayLine([], '')).toBe('')
  })

  it('one attachment → compact ref with char count, then the text', () => {
    const attachments: ChatAttachment[] = [{ name: 'foo.ts', text: 'const x = 1' }]
    // never the raw file body — just a "📎 name (N chars)" reference
    expect(displayLine(attachments, 'what does this do?')).toBe(
      '📎 foo.ts (11 chars)\nwhat does this do?',
    )
  })

  it('many attachments → refs joined in order, then the text', () => {
    const attachments: ChatAttachment[] = [
      { name: 'a.md', text: 'first file' },
      { name: 'b.json', text: '{"k":1}' },
    ]
    expect(displayLine(attachments, 'review these')).toBe(
      '📎 a.md (10 chars) · 📎 b.json (7 chars)\nreview these',
    )
  })

  it('attachments with no typed text → refs only, no trailing newline', () => {
    const attachments: ChatAttachment[] = [{ name: 'notes.txt', text: 'hi' }]
    expect(displayLine(attachments, '')).toBe('📎 notes.txt (2 chars)')
  })

  it('never contains the raw file body', () => {
    const rawBody = 'THE_ENTIRE_50KB_FILE_BODY_TEXT'
    const attachments: ChatAttachment[] = [{ name: 'big.log', text: rawBody }]
    expect(displayLine(attachments, 'summarize')).not.toContain(rawBody)
  })
})
