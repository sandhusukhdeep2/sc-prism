import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * THE DESK BAND MUST SHRINK ITS BODY, NOT SLICE IT (2026-09-03).
 *
 * Reported from a real window: the two heartbeat rows on the Work page were
 * each cut in half — the first showing only the bottom of its text, the second
 * only the top — with the chat card butting straight up against the wound. No
 * scrollbar, no way to reach the rest of either row.
 *
 * The cause is a squeeze landing in the wrong place. `.ws__desk` is
 * deliberately shrinkable (`flex: 0 1 auto`) so the ambient band yields before
 * the conversation does, and it clips (`overflow: hidden`) so a collapsed band
 * cannot paint its label over the chat. But it was a BLOCK container, so
 * `.ws__deskbody` kept its full natural height inside it and the parent simply
 * cut it off wherever the squeeze landed — mid-row. The body's own
 * `overflow-y: auto` never engaged, because the body never learned it had less
 * room; it only ever saw its own `max-height: 32vh`.
 *
 * The fix is to make the band a flex column and let the body absorb the
 * squeeze: `flex: 1 1 auto` + `min-height: 0` turns the body into the scroll
 * viewport, so a short band means a scrollable list of whole rows instead of a
 * sliced one.
 *
 * This is a layout guarantee, so it is asserted against the stylesheet: jsdom
 * does not lay out, and a DOM test would pass against the broken CSS.
 */
const css = readFileSync('src/pages/Workspace.css', 'utf8')

/**
 * Every declaration block for `selector`, joined in source order.
 *
 * A selector may legitimately appear more than once — `.ws__deskbody` carries
 * its layout in one block and its entry animation in another. Taking only the
 * last block reads the animation and reports the layout as absent, so the
 * blocks are concatenated and the later declaration of any given property
 * wins, which is what the cascade does at equal specificity.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `(?![\w-])` so `.ws__desk` does not also match `.ws__deskbody`.
  const matches = [...css.matchAll(new RegExp(`${escaped}(?![\\w-])\\s*\\{([^}]*)\\}`, 'g'))]
  expect(matches.length, `no rule found for ${selector}`).toBeGreaterThan(0)
  return matches.map((m) => m[1]).join(';')
}

/** The winning value of `prop` — the last one declared, as the cascade sees it. */
function declaration(block: string, prop: string): string | null {
  const all = [...block.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))]
  return all.length ? all[all.length - 1][1].trim() : null
}

describe('the coworker desk yields by scrolling, never by slicing a row', () => {
  it('the band is a flex column, so a squeeze can reach the body', () => {
    const band = rule('.ws__desk')
    expect(declaration(band, 'display')).toBe('flex')
    expect(declaration(band, 'flex-direction')).toBe('column')
  })

  it('the band still clips and still floors at its own toggle', () => {
    // Both were deliberate fixes; the flex change must not undo either.
    const band = rule('.ws__desk')
    expect(declaration(band, 'overflow')).toBe('hidden')
    expect(declaration(band, 'min-height')).toBe('30px')
    expect(declaration(band, 'flex')).toBe('0 1 auto')
  })

  it('the toggle never shrinks — the label must stay whole', () => {
    expect(declaration(rule('.ws__desktoggle'), 'flex')).toBe('0 0 auto')
  })

  it('the body absorbs the squeeze and scrolls instead of being cut off', () => {
    const body = rule('.ws__deskbody')
    // `min-height: 0` is the whole fix: without it a flex child refuses to
    // shrink below its content, and the parent goes back to clipping it.
    expect(declaration(body, 'min-height')).toBe('0')
    expect(declaration(body, 'flex')).toBe('1 1 auto')
    expect(declaration(body, 'overflow-y')).toBe('auto')
  })
})
