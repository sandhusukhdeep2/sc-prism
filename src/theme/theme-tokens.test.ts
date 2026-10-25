import { readFileSync } from 'node:fs'
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
    'src/components/LiveActivity.css',
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
