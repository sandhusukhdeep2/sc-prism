// The coworker bar (standing loop, 2026-08-29): model replies are markdown,
// and a cloud coworker renders it. This renderer is deliberately tiny and
// SAFE-BY-CONSTRUCTION: it only ever builds React elements from text — there
// is no HTML path at all, so injected markup can never execute; unknown
// syntax falls through as literal text, never dropped.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderChatMarkdown } from './chatMarkdown'

const draw = (text: string) => render(<div data-testid="md">{renderChatMarkdown(text)}</div>)

describe('renderChatMarkdown', () => {
  it('renders code fences as real code blocks with the language tagged', () => {
    draw('before\n```ts\nconst a = 1\n```\nafter')
    const code = document.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe('const a = 1')
    expect(code?.getAttribute('data-lang')).toBe('ts')
    expect(screen.getByTestId('md').textContent).toContain('before')
    expect(screen.getByTestId('md').textContent).toContain('after')
  })

  it('renders bold, inline code, and headings', () => {
    draw('## Plan\nthis is **key** and `x = 2` inline')
    expect(document.querySelector('h4')?.textContent).toBe('Plan')
    expect(document.querySelector('strong')?.textContent).toBe('key')
    expect(document.querySelector('code')?.textContent).toBe('x = 2')
  })

  it('renders bullet lists as real lists', () => {
    draw('- first\n- second\n1. one\n2. two')
    expect(document.querySelectorAll('ul li').length).toBe(2)
    expect(document.querySelectorAll('ol li').length).toBe(2)
  })

  it('never executes injected markup — tags stay literal text', () => {
    draw('hello <img src=x onerror=alert(1)> **bold**')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByTestId('md').textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('strong')?.textContent).toBe('bold')
  })

  it('plain text passes through with line breaks preserved', () => {
    draw('one\ntwo')
    expect(screen.getByTestId('md').textContent).toContain('one')
    expect(screen.getByTestId('md').textContent).toContain('two')
  })

  it('http links become safe external anchors; javascript: stays text', () => {
    draw('see https://example.org/rules and [x](javascript:alert(1))')
    const a = document.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.org/rules')
    expect(a?.getAttribute('rel')).toContain('noopener')
    expect(document.querySelectorAll('a').length).toBe(1)
  })
})
