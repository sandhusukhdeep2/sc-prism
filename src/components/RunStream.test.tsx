import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import RunStream from './RunStream'
import { modelColor } from '../lib/modelColor'
import type { EngineSpan } from '../lib/nativeEngine'

const NOW = 1_000_000_000_000

const spans: EngineSpan[] = [
  {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    duration_ms: 900,
    start: NOW - 5000,
    attrs: {
      agent: 'developer',
      provider: 'claude-cli',
      model: 'claude-code-subscription',
      route: 'local',
      is_local: true,
      reason: 'sensitivity',
      round: 1,
      tokens_in: 120,
      tokens_out: 40,
      cache: 'miss',
      is_real: true,
    },
  },
  {
    name: 'model_call',
    type: 'model_call',
    status: 'error',
    duration_ms: 300,
    start: NOW - 2000,
    attrs: {
      agent: 'reviewer',
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      route: 'cloud',
      is_local: false,
      round: 1,
      tokens_in: 50,
      tokens_out: 0,
      cache: 'miss',
      is_real: false,
    },
  },
  {
    name: 'tier1',
    type: 'tier1',
    status: 'ok',
    duration_ms: 40,
    start: NOW - 1000,
    attrs: { passed: true },
  },
]

describe('RunStream', () => {
  it('renders nothing for an empty span list', () => {
    const { container } = render(<RunStream spans={[]} now={NOW} />)
    expect(container.querySelectorAll('*').length).toBe(0)
  })

  it('renders the agent names and model chips for each model_call span', () => {
    render(<RunStream spans={spans} now={NOW} />)
    expect(screen.getByText('developer')).toBeInTheDocument()
    expect(screen.getByText('reviewer')).toBeInTheDocument()
    expect(screen.getByText('claude-code-subscription')).toBeInTheDocument()
    expect(screen.getByText('gemini-2.0-flash')).toBeInTheDocument()
  })

  it('shows the lock glyph only on the row that stayed local', () => {
    render(<RunStream spans={spans} now={NOW} />)
    const locks = document.querySelectorAll('.run__lock')
    expect(locks.length).toBe(1)
  })

  it('colors each model chip with modelColor(provider), matching the shared model-color language', () => {
    render(<RunStream spans={spans} now={NOW} />)
    const claudeChip = screen.getByText('claude-code-subscription') as HTMLElement
    const geminiChip = screen.getByText('gemini-2.0-flash') as HTMLElement
    // jsdom normalizes any color syntax (hex/hsl) to rgb() on read-back, so
    // compare through the same normalization instead of matching raw text.
    const domColor = (c: string) => {
      const probe = document.createElement('div')
      probe.style.color = c
      return probe.style.color
    }
    expect(claudeChip.style.color).toBe(domColor(modelColor('claude-cli')))
    expect(geminiChip.style.color).toBe(domColor(modelColor('gemini')))
    expect(claudeChip.style.color).not.toBe(geminiChip.style.color)
  })

  it('marks a non-real call honestly as "stub" — never dressed up as real', () => {
    render(<RunStream spans={spans} now={NOW} />)
    expect(screen.getByText('stub')).toBeInTheDocument()
    // the real call gets no stub tag
    expect(document.querySelectorAll('.run__stub').length).toBe(1)
  })

  it('shows the ✕ glyph on the failed model_call row', () => {
    render(<RunStream spans={spans} now={NOW} />)
    const errRows = document.querySelectorAll('.run__status--err')
    expect(errRows.length).toBe(1)
    expect(errRows[0].textContent).toBe('✕')
  })

  it('renders a secondary row for non-model_call spans without inventing model data', () => {
    render(<RunStream spans={spans} now={NOW} />)
    expect(document.querySelectorAll('.run__row--sec').length).toBe(1)
  })

  // Web research (web design, 2026-07-23): a provider='web' tool_exec span is a
  // governed tool call, rendered as its own timeline row with an honest source
  // label (🌐 web·web_fetch / 🔎 web·web_search) — NOT stripped to "tool_exec"
  // and NOT dressed up as a model call.
  const webSpans: EngineSpan[] = [
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 120,
      start: NOW - 500,
      attrs: { provider: 'web', server: 'web', tool: 'web_fetch', is_error: false },
    },
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'error',
      duration_ms: 5,
      start: NOW - 300,
      attrs: { provider: 'web', server: 'web', tool: 'web_search', blocked: true },
    },
  ]

  it('renders a web tool_exec span as a tool row with its source label (not a secondary row)', () => {
    render(<RunStream spans={webSpans} now={NOW} />)
    const toolRows = document.querySelectorAll('.run__row--tool')
    expect(toolRows.length).toBe(2)
    // No generic "stripped" secondary rows for web tool calls.
    expect(document.querySelectorAll('.run__row--sec').length).toBe(0)
    expect(screen.getByText('web·web_fetch')).toBeInTheDocument()
    expect(screen.getByText('web·web_search')).toBeInTheDocument()
    // Honest source glyphs: 🌐 for a fetch, 🔎 for a search.
    const glyphs = Array.from(document.querySelectorAll('.run__toolglyph')).map((g) => g.textContent)
    expect(glyphs).toContain('🌐')
    expect(glyphs).toContain('🔎')
  })

  it('surfaces a blocked web call as governance, not an infra failure', () => {
    render(<RunStream spans={webSpans} now={NOW} />)
    expect(document.querySelector('.run__toolout--blocked')).not.toBeNull()
    expect(screen.getByText(/blocked · governance/)).toBeInTheDocument()
    // A block is governance, not pass/fail — its trailing glyph must NOT be
    // dressed as an ok/err status (its own loud badge already carries it).
    const blockedRow = document.querySelectorAll('.run__row--tool')[1]
    const blockedStatus = blockedRow.querySelector('.run__status')!
    expect(blockedStatus.classList.contains('run__status--ok')).toBe(false)
    expect(blockedStatus.classList.contains('run__status--err')).toBe(false)
  })

  // A passing tool_exec row must read like a passing model_call row — the SAME
  // green run__status--ok, not the grey check it used to show. A tool that
  // returned isError:true reads with the SAME run__status--err a failed call does.
  const toolOutcomeSpans: EngineSpan[] = [
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 30,
      start: NOW - 200,
      attrs: { provider: 'mcp', server: 'echo', tool: 'add', is_error: false },
    },
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 30,
      start: NOW - 100,
      attrs: { provider: 'mcp', server: 'fs', tool: 'read_file', is_error: true },
    },
  ]

  it('maps a passing tool row to run__status--ok and an errored tool row to run__status--err', () => {
    render(<RunStream spans={toolOutcomeSpans} now={NOW} />)
    const rows = document.querySelectorAll('.run__row--tool')
    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('.run__status')!.classList.contains('run__status--ok')).toBe(true)
    expect(rows[1].querySelector('.run__status')!.classList.contains('run__status--err')).toBe(true)
  })
})

// WHAT the web call did (2026-08-17). `🌐 web·web_fetch` on its own is a label,
// not a disclosure: 44 fetches and 22 searches all rendered identically, so the
// user could not tell the feature was working at all. The row now carries the
// real destination and outcome, read from the span's own attrs.
describe('RunStream — web tool rows disclose destination and outcome', () => {
  const detailSpans: EngineSpan[] = [
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 320,
      start: NOW - 900,
      attrs: {
        provider: 'web',
        server: 'web',
        tool: 'web_fetch',
        url: 'https://docs.anthropic.com/en/docs/agents',
        host: 'docs.anthropic.com',
        status: 200,
        bytes: 49152,
        is_error: false,
      },
    },
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 210,
      start: NOW - 600,
      attrs: {
        provider: 'web',
        server: 'web',
        tool: 'web_search',
        query: 'mlx speculative decoding',
        result_count: 8,
        is_error: false,
      },
    },
  ]

  it('shows a fetch as <host> — <status>, <size>', () => {
    render(<RunStream spans={detailSpans} now={NOW} />)
    expect(screen.getByText('docs.anthropic.com — 200, 48 KB')).toBeInTheDocument()
  })

  it('shows a search as "<query>" — <n> results', () => {
    render(<RunStream spans={detailSpans} now={NOW} />)
    expect(screen.getByText('"mlx speculative decoding" — 8 results')).toBeInTheDocument()
  })

  it('keeps the 🔒 withheld affordance AND still names where the result came from', () => {
    render(
      <RunStream
        spans={[
          {
            name: 'tool_exec',
            type: 'tool_exec',
            status: 'ok',
            attrs: {
              provider: 'web',
              server: 'web',
              tool: 'web_fetch',
              host: 'internal.example',
              status: 200,
              bytes: 2048,
              withheld: true,
            },
          },
        ]}
        now={NOW}
      />,
    )
    expect(document.querySelector('.run__toolout--withheld')).not.toBeNull()
    expect(screen.getByText(/result withheld from cloud/)).toBeInTheDocument()
    expect(screen.getByText(/internal\.example/)).toBeInTheDocument()
  })

  it('renders NO detail for a blocked call — the engine records no argument for it', () => {
    // THE PRIVACY LINE from the UI side (stated in full in
    // engine/scprism_engine/webtools.py): a blocked call did not egress, so its
    // argument is never on the span and there is nothing here to render.
    render(
      <RunStream
        spans={[
          {
            name: 'tool_exec',
            type: 'tool_exec',
            status: 'error',
            attrs: { provider: 'web', server: 'web', tool: 'web_search', blocked: true },
          },
        ]}
        now={NOW}
      />,
    )
    expect(document.querySelector('.run__toolout--blocked')).not.toBeNull()
    expect(document.querySelector('.run__tooldetail')).toBeNull()
  })

  it('renders no detail at all for a vault row — vault arguments are never recorded', () => {
    render(
      <RunStream
        spans={[
          {
            name: 'tool_exec',
            type: 'tool_exec',
            status: 'ok',
            attrs: { provider: 'vault', server: 'vault', tool: 'vault_search' },
          },
        ]}
        now={NOW}
      />,
    )
    expect(document.querySelector('.run__tooldetail')).toBeNull()
  })

  it('shows an MCP result SIZE (the safe half) and never an MCP argument', () => {
    render(
      <RunStream
        spans={[
          {
            name: 'tool_exec',
            type: 'tool_exec',
            status: 'ok',
            attrs: { provider: 'mcp', server: 'notion', tool: 'search_pages', bytes: 12288 },
          },
        ]}
        now={NOW}
      />,
    )
    expect(screen.getByText('12 KB')).toBeInTheDocument()
  })
})

// Vault disclosure (2026-08-05 audit). The stream's tool filter was mcp|web, so
// every provider='vault' span fell through to the generic secondary line — the
// run stream never showed that the companion had opened the user's notes.
describe('RunStream — vault tool rows', () => {
  const vaultSpans: EngineSpan[] = [
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 12,
      start: NOW - 400,
      attrs: {
        provider: 'vault',
        server: 'vault',
        tool: 'vault_read',
        path: 'notes/health.md',
        is_error: false,
      },
    },
    {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      duration_ms: 8,
      start: NOW - 300,
      attrs: { provider: 'vault', server: 'vault', tool: 'vault_read', withheld: true },
    },
  ]

  it('renders a vault read as its own tool row, naming the note it opened', () => {
    render(<RunStream spans={[vaultSpans[0]]} now={NOW} />)
    const rows = document.querySelectorAll('.run__row--tool')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('📓')
    expect(rows[0].textContent).toContain('vault·vault_read')
    expect(rows[0].textContent).toContain('notes/health.md')
    expect(rows[0].querySelector('.run__status')!.classList.contains('run__status--ok')).toBe(true)
  })

  it('gives a withheld vault result the same 🔒 affordance a web tool gets', () => {
    render(<RunStream spans={[vaultSpans[1]]} now={NOW} />)
    expect(document.querySelector('.run__toolout--withheld')).not.toBeNull()
    expect(screen.getByText(/result withheld from cloud/)).toBeInTheDocument()
  })

  it('names no file when the span carries no path (never a guessed filename)', () => {
    const noPath: EngineSpan = {
      name: 'tool_exec',
      type: 'tool_exec',
      status: 'ok',
      start: NOW - 100,
      attrs: { provider: 'vault', server: 'vault', tool: 'vault_list' },
    }
    render(<RunStream spans={[noPath]} now={NOW} />)
    const row = document.querySelector('.run__row--tool')!
    expect(row.textContent).toContain('vault·vault_list')
    expect(row.textContent).not.toContain('·  ·')
  })
})

// Claude-Code-depth rows (Sukhdeep, 2026-08-29, from his own transcript
// screenshots): a row whose span carries real detail expands into labeled
// IN / OUT lines on click; a row with nothing to show gets no toggle at all —
// depth is offered exactly where the record has it, never as empty chrome.
describe('expandable IN/OUT rows', () => {
  it('a tier1 row expands to show the command in and the outcome out', () => {
    render(
      <RunStream
        spans={[
          {
            run_id: 'r',
            span_id: 's',
            name: 'tier1',
            type: 'tool_exec',
            status: 'ok',
            duration_ms: 4200,
            attrs: { commands: ['npm test'], cwd: '/p', passed: true },
          } as unknown as EngineSpan,
        ]}
        now={0}
      />,
    )
    expect(screen.queryByText(/\$ npm test/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /tier1/ }))
    expect(screen.getByText(/\$ npm test/)).toBeInTheDocument()
    expect(screen.getByText(/checks passed/i)).toBeInTheDocument()
  })

  it('a detail-less span renders as a plain row, not a button', () => {
    render(
      <RunStream
        spans={[
          {
            run_id: 'r',
            span_id: 's',
            name: 'stop',
            type: 'hook',
            status: 'ok',
          } as unknown as EngineSpan,
        ]}
        now={0}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

// Audit fix (2026-08-30): a vault note the stream names must be reachable
// where it is named. The expanded drawer (not the toggle header — no nested
// buttons) gets a reveal control when the caller can reveal; a pure render
// with no handler stays exactly as before.
describe('vault rows reveal their note from the drawer', () => {
  const vaultSpan = {
    run_id: 'r',
    span_id: 's',
    name: 'vault_read',
    type: 'tool_exec',
    status: 'ok',
    attrs: { provider: 'vault', server: 'vault', tool: 'vault_read', path: 'reports/sukh/heartbeat.md' },
  } as unknown as EngineSpan

  it('with a handler, the drawer offers reveal and passes the rel path', () => {
    const onReveal = vi.fn()
    render(<RunStream spans={[vaultSpan]} now={0} onRevealNote={onReveal} />)
    fireEvent.click(screen.getByRole('button', { name: /vault_read — details/ }))
    fireEvent.click(screen.getByRole('button', { name: /reveal in Finder/i }))
    expect(onReveal).toHaveBeenCalledWith('reports/sukh/heartbeat.md')
  })

  it('without a handler, no reveal control renders', () => {
    render(<RunStream spans={[vaultSpan]} now={0} />)
    fireEvent.click(screen.getByRole('button', { name: /vault_read — details/ }))
    expect(screen.queryByRole('button', { name: /reveal in Finder/i })).not.toBeInTheDocument()
  })
})
