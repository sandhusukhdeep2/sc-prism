// renderChatMarkdown — the coworker bar's text renderer (standing loop,
// 2026-08-29). Model replies are markdown; a cloud coworker renders it.
//
// Deliberately tiny and SAFE-BY-CONSTRUCTION: the input is only ever split
// and wrapped into React elements — there is no innerHTML path anywhere, so
// injected markup can never execute; anything unrecognized falls through as
// literal text, never dropped. Scope is the subset real model replies use:
// fenced code (with language tag), inline code, bold, italic, ### headings,
// bullet/numbered lists, pipe tables, bare http(s) links and
// [label](https://…) links. javascript:/data: links stay literal text.
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

/** The cells of one `| a | b |` row, outer pipes optional. */
function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

/** `|---|:---:|---:|` — the row under a header that makes the two a table. */
function isSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  const parts = cells(line)
  return parts.length > 0 && parts.every((c) => /^:?-{1,}:?$/.test(c))
}

function alignOf(cell: string): 'left' | 'center' | 'right' | undefined {
  const l = cell.startsWith(':')
  const r = cell.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined
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
    // A pipe table: a header row with a separator row directly under it. A
    // line that merely contains a pipe is text. (Seen 2026-11-14: a team asked
    // for a table answered with one, and it was printed as rows of pipes.)
    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line)
      const aligns = cells(lines[i + 1]).map(alignOf)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(cells(lines[i]))
        i++
      }
      const tk = k++
      out.push(
        <div key={`k${tk}`} className="md__tablewrap">
          <table className="md__table">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                    {inline(c, `k${tk}h${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {/* Every row lands in the header's columns: a short row is
                      padded, a long one is cut — never a ragged table. */}
                  {head.map((_, ci) => (
                    <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                      {inline(r[ci] ?? '', `k${tk}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
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
