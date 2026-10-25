import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { proposeAgentBrief } from './agentProposals'
import { STARTER_CHARTER, ladderBrief } from './managers'

/**
 * THE APP MUST NOT SPEAK AS IF EVERY USER IS ITS AUTHOR (2026-10-25).
 *
 * Found while preparing the source for public release: the author's first name
 * was written into strings the app ships. The account avatar was a literal "SS"
 * with the label "Your account — Sukhdeep", so every install showed his
 * initials. Worse, the system prompts sent to the models said "Sukhdeep is
 * asking for a new agent", "ask Sukhdeep up to N questions about his business",
 * "Waiting on Sukhdeep", and the desk printed "nothing is waiting on Sukhdeep
 * right now" — so for any other user, every model was told it worked for
 * somebody else.
 *
 * The author's name is welcome in COMMENTS — they record whose decision a line
 * came from. It may not appear in anything the app shows or sends. So this walks
 * the TypeScript AST of every shipped file and checks only string literals,
 * template text and JSX text, which keeps every attribution comment intact.
 */
const AUTHOR = /\b(sukhdeep|sandhu|sukh)\b/i

// Every user is not a "he", and neither is an AI. The prompts called the user
// "him" ("do not interrupt him", "until he answers") and the companion "he"
// ("that note is all he remembers") — the codebase's own rule is that agents
// are not people, and a companion the user names should not arrive gendered.
const GENDERED = /\b(he|him|his|himself)\b/i

function shippedSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...shippedSources(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}

/** Every piece of text in `file` that can reach a screen or a model. */
function shippedText(file: string): { line: number; text: string }[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: { line: number; text: string }[] = []
  const visit = (n: ts.Node) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      found.push({ line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.text })
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return found
}

describe('no shipped string speaks as the author', () => {
  it('no string literal, template or JSX text in src/ names the author', () => {
    const offenders = shippedSources('src').flatMap((f) =>
      shippedText(f)
        .filter((t) => AUTHOR.test(t.text))
        .map((t) => `${f}:${t.line}  ${t.text.trim().slice(0, 90)}`),
    )
    expect(offenders).toEqual([])
  })

  it('no shipped string calls the user or an agent "he"', () => {
    const offenders = shippedSources('src').flatMap((f) =>
      shippedText(f)
        .filter((t) => GENDERED.test(t.text))
        .map((t) => `${f}:${t.line}  ${t.text.trim().slice(0, 90)}`),
    )
    expect(offenders).toEqual([])
  })

  it('the agent-proposal brief addresses the user, not a named person', () => {
    const brief = proposeAgentBrief('a weekly invoice checker')
    expect(brief).toContain('The user is asking for a new agent')
    expect(brief).not.toMatch(/\b(his|him|he)\b/)
  })

  it("the companion's starter charter waits on the user, not on a named person", () => {
    expect(STARTER_CHARTER).toContain('1. Waiting on the user')
    expect(STARTER_CHARTER).not.toMatch(/\b(his|him|he)\b/)
  })

  it('the ladder brief says nothing is waiting on you', () => {
    const brief = ladderBrief({ needsYou: 0, vaultNotes: 0, projects: 0 } as never)
    expect(brief).toContain('nothing is waiting on you right now')
  })
})
