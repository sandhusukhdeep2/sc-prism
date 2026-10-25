// renderChatMarkdown — the coworker bar's text renderer (standing loop,
// 2026-08-29). Model replies are markdown; a cloud coworker renders it.
//
// Deliberately tiny and SAFE-BY-CONSTRUCTION: the input is only ever split
// and wrapped into React elements — there is no innerHTML path anywhere, so
// injected markup can never execute; anything unrecognized falls through as
// literal text, never dropped. Scope is the subset real model replies use:
// fenced code (with language tag), inline code, bold, italic, ### headings,
// bullet/numbered lists, bare http(s) links and [label](https://…) links.
// javascript:/data: links stay literal text.
import type { ReactNode } from 'react'

const BARE_URL = /https?:\/\/[^\s<>)"']+/g

/** Inline pass: bold → italic → inline code → links, all as React nodes. */
function inline(text: string, keyBase: string): ReactNode[] {
  // Tokenize by inline code first so `**x**` inside backticks stays literal.
  const out: ReactNode[] = []
  const codeSplit = text.split(/(`[^`\n]+`)/g)
  codeSplit.forEach((seg, ci) => {
    const key = `${keyBase}c${ci}`
    if (/^`[^`\n]+`$/.test(seg)) {
      out.push(<code key={key}>{seg.slice(1, -1)}</code>)
      return
    }
    // Markdown links with an http(s) target only; anything else stays text.
    const linkSplit = seg.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g)
    linkSplit.forEach((part, li) => {
      const lkey = `${key}l${li}`
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
      if (m) {
        out.push(
          <a key={lkey} href={m[2]} target="_blank" rel="noopener noreferrer">
            {m[1]}
          </a>,
        )
        return
      }
      // Bold / italic / bare URLs inside the remaining plain run.
      const boldSplit = part.split(/(\*\*[^*\n]+\*\*)/g)
      boldSplit.forEach((b, bi) => {
        const bkey = `${lkey}b${bi}`
        if (/^\*\*[^*\n]+\*\*$/.test(b)) {
          out.push(<strong key={bkey}>{b.slice(2, -2)}</strong>)
          return
        }
        const italSplit = b.split(/(\*[^*\n]+\*)/g)
        italSplit.forEach((t, ti) => {
          const tkey = `${bkey}t${ti}`
          if (/^\*[^*\n]+\*$/.test(t)) {
            out.push(<em key={tkey}>{t.slice(1, -1)}</em>)
            return
          }
          // Bare URLs become anchors; the surrounding text stays text.
          let last = 0
          for (const um of t.matchAll(BARE_URL)) {
            const at = um.index ?? 0
            if (at > last) out.push(t.slice(last, at))
            const url = um[0]
            out.push(
              <a key={`${tkey}u${at}`} href={url} target="_blank" rel="noopener noreferrer">
                {url}
              </a>,
            )
            last = at + url.length
          }
          if (last < t.length) out.push(t.slice(last))
        })
      })
    })
  })
  return out
}

export function renderChatMarkdown(text: string): ReactNode {
  const lines = (text ?? '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    // Fenced code: everything to the closing fence, verbatim.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume the closing fence (or EOF)
      out.push(
        <pre key={`k${k++}`} className="md__pre">
          <code data-lang={lang}>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    // Headings (any depth renders as a modest h4 — chat, not a document).
    const h = /^#{1,6}\s+(.+)$/.exec(line)
    if (h) {
      out.push(<h4 key={`k${k++}`} className="md__h">{inline(h[1], `k${k}`)}</h4>)
      i++
      continue
    }
    // Bullet list run.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(<li key={`k${k++}`}>{inline(lines[i].replace(/^\s*[-*]\s+/, ''), `k${k}`)}</li>)
        i++
      }
      out.push(<ul key={`k${k++}`} className="md__list">{items}</ul>)
      continue
    }
    // Numbered list run.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(
          <li key={`k${k++}`}>{inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''), `k${k}`)}</li>,
        )
        i++
      }
      out.push(<ol key={`k${k++}`} className="md__list">{items}</ol>)
      continue
    }
    // Plain line (blank lines become spacing via the wrapper's white-space).
    out.push(<span key={`k${k++}`}>{inline(line, `k${k}`)}</span>)
    if (i < lines.length - 1) out.push('\n')
    i++
  }
  return <>{out}</>
}
