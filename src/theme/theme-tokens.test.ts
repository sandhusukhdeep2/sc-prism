import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * THEME LEGIBILITY GUARD — rewritten 2026-08-19 for the v2 adoption.
 *
 * WHAT CHANGED. This file used to be a byte-identity ledger: it pinned ~60
 * legacy tokens to the exact Amber literal each one replaced, and asserted that
 * the two dark themes overrode every one of them by hand. That protected a real
 * guarantee — nothing illegible on any theme — but it protected it by freezing
 * one palette in place, and every surface had to be flipped three times by hand.
 *
 * The app now has ONE palette (the v2 system), defined per theme, and every
 * legacy token is an ALIAS of a v2 token. That makes the old assertions
 * meaningless (there are no per-theme legacy literals left to compare) while
 * making the underlying guarantee much easier to prove, and impossible to
 * regress by forgetting a theme:
 *
 *   1. every legacy semantic token resolves through a --v2-* token, so a raw
 *      literal cannot creep back in and freeze one theme's colour;
 *   2. every --v2-* token is defined in ALL THREE theme blocks, so an alias can
 *      never resolve to nothing on a theme somebody forgot;
 *   3. the dark themes' surfaces are genuinely dark, their ink genuinely light,
 *      and the pairs that sit on top of each other clear WCAG AA;
 *   4. component CSS still drives its fills from tokens, never a raw light
 *      literal — the rule that started this file, and the only one that has to
 *      be checked against the components themselves.
 *
 * Files are read relative to the repo root (vitest's cwd).
 */
const read = (repoRelPath: string) => readFileSync(repoRelPath, 'utf8')
const tokens = read('src/theme/tokens.css')

/** Every stylesheet the radius/shadow sweep touched. */
const CSS_FILES = [
  'src/pages/Settings.css', 'src/pages/Providers.css', 'src/pages/Agents.css',
  'src/pages/Automations.css', 'src/pages/Memory.css', 'src/pages/Skills.css',
  'src/pages/Stats.css', 'src/pages/Console.css', 'src/pages/Vault.css',
  'src/pages/Projects.css', 'src/pages/VerdictDetail.css', 'src/pages/Workspace.css',
  'src/components/RunLedger.css', 'src/components/CrewBoard.css',
  'src/components/AppShell.css', 'src/components/Desk.css',
]

const amber = tokens.slice(0, tokens.indexOf("[data-theme='prism']"))
const prism = tokens.slice(
  tokens.indexOf("[data-theme='prism']"),
  tokens.indexOf("[data-theme='obsidian']"),
)
const obsidian = tokens.slice(tokens.indexOf("[data-theme='obsidian']"))
const THEMES = [
  ['light', amber],
  ['prism', prism],
  ['obsidian', obsidian],
] as const

const tokenValue = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

// WCAG sRGB relative luminance + contrast.
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The legacy tokens the unconverted pages still read. Each MUST be an alias.
const ALIASED = [
  '--card', '--card-solid', '--input-fill', '--field-fill', '--code-fill',
  '--raise', '--raise-35', '--raise-50', '--raise-55',
  '--dark', '--chart-dark', '--on-chart-dark', '--on-dark', '--on-dark-2',
  '--hair', '--hair-2', '--hair-7', '--hair-10', '--hair-strong', '--edge',
  '--fill-soft', '--fill-soft-2', '--area-soft',
  '--ink', '--ink-2', '--ink-3', '--muted', '--muted-2', '--muted-3', '--bubble-ink',
  '--gold', '--gold-deep', '--gold-soft', '--gold-grad', '--on-gold',
  '--ok', '--ok-ink', '--warn', '--warn-ink', '--danger', '--danger-ink', '--eval-ink',
  '--track', '--dot-idle', '--scrollbar', '--dash', '--meter-track',
  '--orb', '--r-card', '--r-btn', '--r-pill', '--shadow-card',
]

describe('every legacy token is an alias of the v2 system', () => {
  it('resolves through a --v2-* token rather than a frozen literal', () => {
    const frozen: string[] = []
    for (const tok of ALIASED) {
      const v = tokenValue(amber, tok)
      expect(v, `${tok} is missing entirely`).not.toBeNull()
      // `none` is a legitimate "switched off" value (the retired orb glow).
      if (v !== 'none' && !/var\(--v2-[a-z0-9-]+\)/.test(v!)) frozen.push(`${tok} = ${v}`)
    }
    expect(frozen).toEqual([])
  })

  it('the dark themes do NOT re-freeze an alias — they inherit it and flip underneath', () => {
    const reFrozen: string[] = []
    for (const [name, block] of [
      ['prism', prism],
      ['obsidian', obsidian],
    ] as const) {
      for (const tok of ALIASED) {
        const v = tokenValue(block, tok)
        if (v !== null) reFrozen.push(`${name}: ${tok} = ${v}`)
      }
    }
    expect(reFrozen).toEqual([])
  })
})

// The v2 tokens the aliases point at — the ones that must exist everywhere.
const V2_REQUIRED = [
  '--v2-ink', '--v2-ink-2', '--v2-muted', '--v2-paper', '--v2-card', '--v2-board',
  '--v2-line', '--v2-fill', '--v2-track', '--v2-idle',
  '--v2-blue', '--v2-coral', '--v2-local',
  '--v2-blue-ink', '--v2-coral-ink', '--v2-local-ink',
  '--v2-accent', '--v2-on-accent', '--v2-on-fill',
]

describe('the v2 palette is complete on every theme', () => {
  it('defines every token the aliases depend on, in all three blocks', () => {
    const missing: string[] = []
    for (const [name, block] of THEMES) {
      for (const tok of V2_REQUIRED) {
        if (tokenValue(block, tok) === null) missing.push(`${name}: ${tok}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('light is light and the dark themes are genuinely dark', () => {
    expect(parseInt(tokenValue(amber, '--v2-card')!.slice(1, 3), 16)).toBeGreaterThan(0xd0)
    for (const [name, block] of [
      ['prism', prism],
      ['obsidian', obsidian],
    ] as const) {
      const card = tokenValue(block, '--v2-card')!
      expect(card, `${name} card`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(parseInt(card.slice(1, 3), 16), `${name} card should be dark`).toBeLessThan(0x40)
      // ...and the ink on it flips light, so a card is never dark-on-dark.
      expect(parseInt(tokenValue(block, '--v2-ink')!.slice(1, 3), 16)).toBeGreaterThan(0x80)
    }
  })
})

describe('the pairs that sit on each other clear WCAG AA', () => {
  it('body ink on a card, on every theme', () => {
    for (const [name, block] of THEMES) {
      const c = contrast(tokenValue(block, '--v2-card')!, tokenValue(block, '--v2-ink')!)
      expect(c, `${name} ink on card`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the accent surface and the text ON it, on every theme', () => {
    for (const [name, block] of THEMES) {
      const c = contrast(tokenValue(block, '--v2-accent')!, tokenValue(block, '--v2-on-accent')!)
      expect(c, `${name} on-accent`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every status INK reads on a card — a truthful colour is never illegible', () => {
    for (const [name, block] of THEMES) {
      const card = tokenValue(block, '--v2-card')!
      for (const ink of ['--v2-blue-ink', '--v2-coral-ink', '--v2-local-ink']) {
        const c = contrast(card, tokenValue(block, ink)!)
        expect(c, `${name} ${ink} on card`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('muted secondary text still clears AA — it carries real reasons, not decoration', () => {
    for (const [name, block] of THEMES) {
      const c = contrast(tokenValue(block, '--v2-card')!, tokenValue(block, '--v2-muted')!)
      expect(c, `${name} muted on card`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('primary surfaces drive their fill from tokens, not raw light literals', () => {
  const SURFACE_FILES = [
    'src/pages/Workspace.css',
    'src/pages/Settings.css',
    'src/pages/Providers.css',
    'src/pages/Agents.css',
    'src/components/AgentCard.css',
    'src/pages/Memory.css',
    'src/components/Desk.css',
    'src/components/DrawerSection.css',
    'src/pages/Stats.css',
    'src/pages/Console.css',
  ]

  // The only legitimate light `background:` literals are the toggle knob (a
  // constant white puck) and the divider inside the always-dark hero card.
  const ALLOW = /__knob|hero-hr/
  const LIGHT_FILL = /background:[^;]*(#fff\b|#ffffff\b|#f6f3e8\b|rgba\(255,\s*255,\s*255)/i

  it('no light-fill background literal survives on a primary surface', () => {
    const offenders: string[] = []
    for (const rel of SURFACE_FILES) {
      for (const block of read(rel).split('}')) {
        const [selector, ...rest] = block.split('{')
        const decls = rest.join('{')
        if (LIGHT_FILL.test(decls) && !ALLOW.test(selector)) {
          offenders.push(`${rel}: ${selector.trim()} => ${decls.trim().slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the composer and message bubble use the flipping surface tokens', () => {
    const ws = read('src/pages/Workspace.css')
    expect(ws).toMatch(/\.chat__composer\s*\{[^}]*background:\s*var\(--input-fill\)/s)
    expect(ws).toMatch(/\.msg__bubble\s*\{[^}]*background:\s*var\(--input-fill\)/s)
    expect(ws).toMatch(/\.msg__bubble\s*\{[^}]*color:\s*var\(--bubble-ink\)/s)
  })

  it('the Stats/Memory cost area still fills from a token', () => {
    expect(read('src/pages/Stats.tsx')).toContain('fill="var(--area-soft)"')
    expect(read('src/pages/Memory.tsx')).toContain('fill="var(--area-soft)"')
  })
})

describe('the retired amber palette does not come back', () => {
  // The signature literals of the old warm system. Their presence anywhere in
  // the token file would mean a surface had been pinned to one theme again.
  const AMBER_SIGNATURES = ['#ffd23f', '#f5c020', '#ffe08a', '#fbf7ec', '#fdfbf4', '#f6f3e8']

  it('no amber literal survives in the token file', () => {
    const found = AMBER_SIGNATURES.filter((hex) => tokens.toLowerCase().includes(hex))
    expect(found).toEqual([])
  })
})

// A MECHANICAL SWEEP NEEDS A MECHANICAL GUARD.
//
// Snapping 370 hand-written radii onto the v2 scale by SIZE broke seven
// controls whose shape was never a size choice: a toggle 24px tall with a 12px
// radius is a PILL — the radius is exactly half its height — and mapping it to
// the 15px "inner panel" step made it a rounded rectangle. It also hit the
// ledger's arc, whose 78px radius on a 78x39 box is the geometry that makes it
// the top half of a circle, not a style.
//
// The rule, stated so no future sweep can rediscover it the hard way: if a rule
// declares a small explicit height, its radius must be either well under half
// that height (a genuine corner) or the pill step (a genuine capsule) — never
// the ambiguous middle, which renders as neither.
describe('the radius scale did not flatten the capsules', () => {
  const RULE = /([^{}]+)\{([^}]*)\}/g
  const STEP: Record<string, number> = {
    '--v2-r-chip': 10,
    '--v2-r-inner': 15,
    '--v2-r-card': 22,
  }

  it('no small control sits in the ambiguous middle', () => {
    const offenders: string[] = []
    for (const rel of CSS_FILES) {
      const css = read(rel)
      for (const m of css.matchAll(RULE)) {
        const [, selector, body] = m
        const h = body.match(/(?<!line-)height:\s*(\d+(?:\.\d+)?)px/)
        const r = body.match(/border-radius:\s*var\((--v2-r-(?:chip|inner|card))\)/)
        if (!h || !r) continue
        const height = parseFloat(h[1])
        if (height <= 44 && STEP[r[1]] >= height / 2) {
          offenders.push(`${rel}: ${selector.trim().split(',')[0]} (h=${height}, ${r[1]})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the ledger arc keeps the radius that makes it a half-circle', () => {
    // 78px on a 78x39 box. Any token would round the corners of a rectangle
    // instead of describing a circle's top half.
    expect(read('src/components/RunLedger.css')).toMatch(
      /\.ledger__donut\s*\{[^}]*border-radius:\s*78px 78px 0 0/s,
    )
  })
})

// ONE MOTION LANGUAGE (premium pass, 2026-11-09). The app had the right
// instincts scattered: a 380ms settle for arrivals, a slow breathe for live
// seats, reduced-motion guards per file. These pins make it one system: the
// durations and easings are tokens, every surface below animates through
// them, and reduced-motion is honoured globally rather than file by file.
describe('motion is one system', () => {
  const globalCss = read('src/theme/global.css')
  const shell = read('src/components/AppShell.css')
  const agents = read('src/pages/Agents.css')
  const meter = read('src/components/LocalMeter.css')
  const ceremony = read('src/components/AgentCeremony.css')

  it('defines the motion tokens once, in tokens.css', () => {
    for (const t of ['--ease-out', '--ease-inout', '--dur-fast', '--dur', '--dur-slow']) {
      expect(tokens, t).toMatch(new RegExp(`^\\s*${t}:`, 'm'))
    }
  })
  it('honours prefers-reduced-motion for every animation and transition, globally', () => {
    expect(globalCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms !important/)
    expect(globalCss).toMatch(/transition-duration: 0\.01ms !important/)
  })
  it('a page arrives (fade + rise) through the tokens', () => {
    expect(shell).toMatch(/\.content > \*[\s\S]*animation: [a-zA-Z]+ var\(--dur\) var\(--ease-out\)/)
  })
  it('agent tiles stagger in, lift on hover, and the working dot breathes — all through the tokens', () => {
    expect(agents).toMatch(/\.agent-tile \{[\s\S]*animation: [a-zA-Z]+ var\(--dur\) var\(--ease-out\) both/)
    expect(agents).toMatch(/animation-delay: calc\(var\(--i, 0\) \* \d+ms\)/)
    expect(agents).toMatch(/\.agent-tile:hover \{[^}]*transform: translateY\(-2px\)/)
    expect(agents).toMatch(/\.agent-usage__dot--working \{[^}]*animation: [a-zA-Z]+ var\(--dur-slow\)/)
    expect(agents).toMatch(/\.agent-tile__proof\.is-proven \{[^}]*animation: [a-zA-Z]+ var\(--dur\)/)
  })
  it('the local meter fills smoothly and the ceremony’s live lines arrive one by one', () => {
    expect(meter).toMatch(/\.meter__fill \{[^}]*transition: width var\(--dur-slow\)/)
    expect(ceremony).toMatch(/\.ceremony__line \{[^}]*animation: [a-zA-Z]+ var\(--dur\) var\(--ease-out\) both/)
  })
})

// THE ICON RAIL (≤ 820px): the rail is 60px wide and the links are icons only,
// but the local-share meter at its foot still laid out its bar and its token
// line at full width and spilled past the rail. There it shows the number only.
describe('the meter fits the icon rail', () => {
  it('hides the bar and the token line, and keeps the number, below 820px', () => {
    const shell = read('src/components/AppShell.css')
    const narrow = shell.slice(shell.indexOf('@media (max-width: 820px)'))
    expect(narrow).toMatch(/\.meter__bar,?\s*\n?\s*\.meter__sub[^}]*display: none/)
    expect(narrow).toMatch(/\.meter \{[^}]*padding: [^;]+;/)
  })
})


// The engine steps in the room sat on a hard-coded #17161c with light grey
// text — the one black block on a light page (his screenshot, 2026-11-09).
// In the room it sits on the token surfaces like everything else.
describe('the engine console uses the room’s surfaces', () => {
  it('no hard-coded dark literals in the console rules', () => {
    const ws = read('src/pages/Workspace.css')
    const console = ws.slice(ws.indexOf('.ws__console {'), ws.indexOf('.ws__console {') + 2600)
    expect(console).not.toMatch(/#17161c|#c9cdd6|#cfc8e8|#55525f/)
    expect(console).toMatch(/\.ws__console \{[^}]*background: var\(--/)
  })
})

// SMALL WINDOWS (clear-room spec 2026-11-09 §C). At 1000×760 during a live
// run the stage above the chat kept its full height and the chat — the hero —
// was a sliver with its composer clipped. Since 2026-11-14 the room's team
// stands on ONE BOARD above the chat: its height is its content's and cannot
// grow with the run (a seat's state is held to two lines), in a short window
// it drops its token line — and the chat column still keeps its floor.
describe('a live run never squeezes the chat in a small window', () => {
  it('floors the chat column under a narrow or short media query', () => {
    const ws = read('src/pages/Workspace.css')
    const small = ws.slice(ws.indexOf('@media (max-width: 1180px), (max-height: 820px)'))
    expect(small.length).toBeGreaterThan(10)
    expect(small).toMatch(/\.ws__chatcol \{[^}]*min-height: 2\d\dpx/)
    // The row that had to be capped is gone, not merely restyled.
    expect(ws).not.toMatch(/\.ws__stage\b/)
  })
  it('the Team board is a fixed band: it neither shrinks to a sliver nor grows with the run', () => {
    const css = read('src/components/TeamBoard.css')
    const rule = css.match(/^\.board \{[^}]*\}/m)?.[0] ?? ''
    expect(rule).toMatch(/flex: none/)
    // The band of links has a height of its own, and what a seat says is
    // held to two lines however long the engine's sentence is.
    expect(css).toMatch(/\.board__links \{[^}]*height: \d\dpx/)
    expect(css).toMatch(/\.board__state \{[^}]*line-clamp: 2/)
  })
  it('in a short window the board gives up its token line before the chat gives up room', () => {
    const css = read('src/components/TeamBoard.css')
    const short = css.slice(css.indexOf('@media (max-height: 820px)'))
    expect(short.length).toBeGreaterThan(10)
    expect(short).toMatch(/\.board__tokens \{[^}]*display: none/)
  })
})

// READING COMFORT AND SENTENCE TYPE, CONTINUED (2026-11-11).
describe('wide windows and sentences', () => {
  it('a chat bubble stops at a readable measure however wide the window is', () => {
    const ws = read('src/pages/Workspace.css')
    expect(ws).toMatch(/\.msg__bubble \{[^}]*max-width: min\(72%, \d\dch\)/)
  })
  it('an open sidebar section keeps its chevron at the right edge', () => {
    expect(read('src/components/DrawerSection.css')).toMatch(/\.dsec__chev \{[^}]*margin-left: auto/)
  })
  it('an agent tile sets its role, proof and activity lines as text, with aligned figures', () => {
    const css = read('src/pages/Agents.css')
    const sub = css.match(/\.agent-tile__sub \{[^}]*\}/)?.[0] ?? ''
    expect(sub).not.toMatch(/font-mono/)
    expect(css).toMatch(/\.agent-usage__label \{[^}]*font-variant-numeric: tabular-nums/)
    const tsx = read('src/pages/Agents.tsx')
    expect(tsx).not.toContain("'agent-tile__proof mono'")
    expect(tsx).not.toContain('agent-usage__label mono')
  })
})

describe('page heads and the icon rail', () => {
  it('a page\u2019s one-line hint is a sentence, not code', () => {
    expect(read('src/components/PageHead.tsx')).not.toMatch(/phead__hint mono/)
  })
  it('the icon rail never scrolls sideways', () => {
    const shell = read('src/components/AppShell.css')
    const narrow = shell.slice(shell.indexOf('@media (max-width: 820px)'))
    expect(narrow).toMatch(/\.rail \{[^}]*overflow-x: hidden/)
  })
})

// THE AGENTS TABS (seen 2026-11-11): on Managers the companion's state line
// was cut to "On · resti…" — it carries when the next check is — because two
// cards sat in fixed 340px columns beside an empty third; and both tabs'
// subtitles were sentences in monospace.
describe('the Agents tabs', () => {
  const css = read('src/pages/Agents.css')
  const tsx = read('src/pages/Agents.tsx')
  it('manager cards share the row they have, and the state line is never cut', () => {
    expect(css).toMatch(/\.mgrs__grid \{[^}]*repeat\(auto-fit, minmax\(340px, 1fr\)\)/)
    expect(css).toMatch(/\.hb__row \{[^}]*flex-wrap: wrap/)
    const state = css.match(/\.hb__state \{[^}]*\}/)?.[0] ?? ''
    expect(state).not.toMatch(/text-overflow: ellipsis/)
  })
  it('the tab subtitles are sentences, not code', () => {
    expect(tsx).not.toMatch(/mgrs__hint mono/)
    expect(tsx).not.toMatch(/team__hint mono/)
  })
})

// LOCAL IS NOT CLOUD (seen 2026-11-11). The legacy tokens --gold and
// --chart-dark both alias the accent black, so every local-versus-cloud bar
// and legend was one black shape with two labels, and the headline number on
// the dark savings card was black on black. These are the charts that show how
// much work stayed on this Mac: local wears the local green, cloud the blue,
// and anything on a dark card is an on-dark colour.
describe('local and cloud are told apart, and dark cards are legible', () => {
  const stats = read('src/pages/Stats.css')
  const mem = read('src/pages/Memory.css')
  const con = read('src/pages/Console.css')
  it('share bars and their legends: local green, cloud blue, ink that reads on both', () => {
    expect(stats).toMatch(/\.stats__seg--local \{[^}]*background: var\(--v2-local\)/)
    expect(stats).toMatch(/\.stats__seg--cloud \{[^}]*background: var\(--v2-blue\)/)
    expect(stats).toMatch(/\.stats__seg-txt \{[^}]*color: var\(--v2-on-fill\)/)
    expect(stats).toMatch(/\.stats__sw--gold \{[^}]*background: var\(--v2-local\)/)
    expect(stats).toMatch(/\.stats__sw--cloud \{[^}]*background: var\(--v2-blue\)/)
    expect(mem).toMatch(/\.mem-share__seg--local \{[^}]*background: var\(--v2-local\)/)
    expect(mem).toMatch(/\.mem-share__seg--cloud \{[^}]*background: var\(--v2-blue\)/)
    const memTsx = read('src/pages/Memory.tsx')
    expect(memTsx).not.toMatch(/mem-legend__sw" style=\{\{ background: 'var\(--(gold|chart-dark)\)'/)
    // Console: the local bar is the local green; every cloud provider is the
    // cloud blue and can never be handed the local one.
    expect(con).toMatch(/\.console__bar--local \{[^}]*background: var\(--v2-local\)/)
    expect(con).toMatch(/\.console__bar--cloud \{[^}]*background: var\(--v2-blue\)/)
    const conTsx = read('src/pages/Console.tsx')
    expect(conTsx).toMatch(/p\.isLocal \? 'console__bar--local' : 'console__bar--cloud'/)
  })
  it('the headline number on a dark card is an on-dark colour, never the accent', () => {
    expect(stats).toMatch(/\.stats__hero-num \{[^}]*color: var\(--on-dark\)/)
    expect(mem).toMatch(/\.mem-saves__num \{[^}]*color: var\(--on-dark\)/)
  })
  it('secondary text on a dark card is a tint of the on-dark colour in every theme', () => {
    expect(tokens).toMatch(/--on-dark-muted:\s*color-mix\(in srgb, var\(--v2-on-accent\) \d+%, transparent\)/)
    for (const rule of ['.stats__kicker-dark', '.stats__dim']) {
      const r = stats.match(new RegExp(rule.replace('.', '\\.') + ' \\{[^}]*\\}'))?.[0] ?? ''
      expect(r, rule).toMatch(/color: var\(--on-dark-muted\)/)
    }
    for (const rule of ['.mem-saves__kicker', '.mem-saves__sub', '.mem-saves__note']) {
      const r = mem.match(new RegExp(rule.replace('.', '\\.') + ' \\{[^}]*\\}'))?.[0] ?? ''
      expect(r, rule).toMatch(/color: var\(--on-dark-muted\)/)
    }
  })
  it('the Stats page grows and scrolls instead of squeezing its cards into each other', () => {
    const page = stats.match(/^\.stats \{[^}]*\}/m)?.[0] ?? ''
    expect(page).not.toMatch(/[^-]height: 100%/)
    expect(stats).toMatch(/\.stats__grid \{[^}]*flex: 1 0 auto/)
  })
})

describe('the Vault tree', () => {
  it('the open file is legible on its selection bar', () => {
    const rule = read('src/pages/Vault.css').match(/\.vault__file--active \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/color: var\(--on-gold\)/)
  })
  it('never scrolls sideways: a long name wraps inside the tree', () => {
    const css = read('src/pages/Vault.css')
    expect(css.match(/\.vault__tree \{[^}]*\}/)?.[0] ?? '').toMatch(/overflow-x: hidden/)
    expect(css.match(/\.vault__file \{[^}]*\}/)?.[0] ?? '').toMatch(/overflow-wrap: anywhere/)
    expect(css.match(/\.vault__folder \{[^}]*\}/)?.[0] ?? '').toMatch(/overflow-wrap: anywhere/)
  })
})

// 2026-11-11: --on-dark-muted and --on-dark-label became tints of the on-dark
// colour so that dark cards read. Eight rules on LIGHT surfaces had borrowed
// the label token as a general grey and turned white on white with it: the
// attribution line under every chat reply, the narration strip, and the skill
// and agent chips. The tokens are for the dark card and stay there.
describe('text tokens for the dark card stay on the dark card', () => {
  const cssFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`
      return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : []
    })
  const DARK_SURFACE = /^\.(verdict__|vd__|stats__|mem-saves__)/

  it('no rule outside a dark card uses them', () => {
    const offenders: string[] = []
    for (const file of cssFiles('src')) {
      if (file.endsWith('tokens.css')) continue
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/var\(--on-dark-(muted|label)\)/.test(m[2])) continue
        for (const sel of m[1].split(',').map((x) => x.trim())) {
          if (!DARK_SURFACE.test(sel)) offenders.push(`${file}: ${sel}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the verdict page does not put its dark-card dim text on the light hooks card', () => {
    expect(read('src/pages/VerdictDetail.tsx')).not.toMatch(/vd__hookname vd__dim/)
  })
})

// 2026-11-11: the Agents page's Crew / Team / Managers tabs were <button>s whose
// class set no border, background or font, so the system's grey bevelled button
// showed through beside the Library's clean pills. One tab look for both.
describe('a tab is never a native button', () => {
  it('the Agents tabs carry the same reset as the Library tabs', () => {
    const rule = (file: string, sel: string) =>
      read(file).match(new RegExp(sel.replace('.', '\\.') + ' \\{[^}]*\\}'))?.[0] ?? ''
    for (const [file, sel] of [
      ['src/pages/Library.css', '.library__tab'],
      ['src/pages/Agents.css', '.agents__tab'],
    ] as const) {
      const r = rule(file, sel)
      expect(r, sel).toMatch(/border: 0/)
      expect(r, sel).toMatch(/background: none/)
      expect(r, sel).toMatch(/font: inherit/)
      expect(r, sel).toMatch(/cursor: pointer/)
    }
  })
})

describe('the Agents page section note', () => {
  it('is a phrase set as text, at a readable size', () => {
    const r = read('src/pages/Agents.css').match(/\.sect-head__note \{[^}]*\}/)?.[0] ?? ''
    expect(r).not.toBe('')
    expect(r).not.toMatch(/font-mono/)
    expect(Number(r.match(/font-size: ([\d.]+)px/)?.[1] ?? 0)).toBeGreaterThanOrEqual(11.5)
  })
})
