// RunStream — the structured, per-agent, model-colored timeline of a run's
// engine spans (Manager View "read it" depth, task-as-spine). Pure +
// presentational: renders exactly the EngineSpan[] it's given, nothing
// invented. `now` is injected (not Date.now()) so a still-running span's
// elapsed time stays testable, same convention as ConsoleActivity's `now`.
//
// Order: `readSpansTail` (src-tauri/src/lib.rs `read_spans_tail`) reverses
// the file twice — once to grab the newest N lines, once back — so it
// already hands back spans oldest-first (chronological). We render them in
// the order given, top-to-bottom, so the stream reads as the task's spine.
import { useState, type ReactNode } from 'react'
import { spanLine } from '../lib/engineConsole'
import { spanDetails } from '../lib/spanDetails'
import { modelColor } from '../lib/modelColor'
import type { EngineSpan } from '../lib/nativeEngine'
import { formatBytes, webSpanDetail } from '../lib/webSpan'
import './RunStream.css'

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

// Duration text for a model_call row: the real recorded duration once the
// span finished, or — honestly derived, never fabricated — the elapsed time
// since `start` while the span is still open (status neither ok nor error).
function durationLabel(s: EngineSpan, now: number): string | null {
  if (s.duration_ms != null) return formatMs(s.duration_ms)
  if (s.start != null && s.status !== 'ok' && s.status !== 'error') {
    // `s.start` is the engine's time.time() — SECONDS — while `now` is JS ms;
    // convert before subtracting (else a live span reads ~1000× too long).
    return `${formatMs(now - s.start * 1000)}…`
  }
  return null
}

function statusGlyph(status: string | undefined): { glyph: string; cls: string } {
  if (status === 'ok') return { glyph: '✓', cls: 'run__status--ok' }
  if (status === 'error') return { glyph: '✕', cls: 'run__status--err' }
  return { glyph: '·', cls: 'run__status--run' }
}

function ModelCallRow({ s, now }: { s: EngineSpan; now: number }) {
  const a = s.attrs ?? {}
  const provider = typeof a.provider === 'string' ? a.provider : undefined
  const model = typeof a.model === 'string' ? a.model : undefined
  const agent = typeof a.agent === 'string' ? a.agent : '?'
  const route = typeof a.route === 'string' ? a.route : undefined
  const isLocal = a.is_local === true || route === 'local'
  const color = modelColor(provider ?? model ?? '')
  const { glyph, cls } = statusGlyph(s.status)
  const dur = durationLabel(s, now)
  const tokensIn = typeof a.tokens_in === 'number' ? a.tokens_in : undefined
  const tokensOut = typeof a.tokens_out === 'number' ? a.tokens_out : undefined
  const hasTokens = tokensIn != null || tokensOut != null
  const isStub = a.is_real === false

  return (
    <div className="run__row run__row--call">
      <span className="run__dot" style={{ background: color }} />
      <span className="run__agent">{agent}</span>
      <span className="run__chip" style={{ color, borderColor: color }}>
        {model ?? '?'}
      </span>
      {route && (
        <span className="run__route">
          {isLocal && (
            <span className="run__lock" title="stayed on local">
              🔒
            </span>
          )}
          {route}
        </span>
      )}
      {hasTokens && (
        <span className="run__tokens">
          {tokensIn ?? 0}→{tokensOut ?? 0}
        </span>
      )}
      {dur && <span className="run__dur">{dur}</span>}
      {isStub && <span className="run__stub">stub</span>}
      <span className={'run__status ' + cls}>{glyph}</span>
    </div>
  )
}

// A governed tool call (v2b) as its own timeline entry: <glyph> server·tool,
// duration, and a distinct OUTCOME — a governance block and a result-withhold
// are surfaced separately from an infra error / a plain success (M1/M2/M3), so
// tool activity + governance are actually visible, not stripped to "tool_exec".
// Covers MCP tools (⛭), web-research tools (web design, 2026-07-23) — a web call
// reads as its honest source, 🌐 web·web_fetch / 🔎 web·web_search — and the
// engine's own VAULT tools (mission control, 2026-08-05): 📓 vault·vault_read ·
// <note>. Vault rows were dropped from this stream entirely, so the one piece of
// activity this product's promise turns on — he opened your notes — was the one
// piece the run stream never showed.
//
// WHAT the call did (2026-08-17): a web row also shows the real destination and
// outcome — `docs.anthropic.com — 200, 48 KB`, `"mlx multi token prediction" —
// 8 results` — read from the span's own attrs via lib/webSpan, and an MCP row
// shows how much came back. A web ARGUMENT may be shown because it already left
// the machine; a vault/MCP argument is never recorded and can never appear here.
// THE PRIVACY LINE is stated in full in engine/scprism_engine/webtools.py.
function ToolExecRow({ s, now }: { s: EngineSpan; now: number }) {
  const a = s.attrs ?? {}
  const web = a.provider === 'web'
  const vault = a.provider === 'vault'
  const server = typeof a.server === 'string' ? a.server : web ? 'web' : vault ? 'vault' : 'mcp'
  const tool = typeof a.tool === 'string' ? a.tool : s.name
  const toolGlyph = web ? (tool === 'web_search' ? '🔎' : '🌐') : vault ? '📓' : '⛭'
  // Named only when the span really carries a path — never a guessed filename.
  const notePath = vault && typeof a.path === 'string' && a.path ? a.path : ''
  // Ditto: '' when the span carried no real destination/outcome, and then the
  // row renders exactly as it did before this landed.
  const webDetail = web ? webSpanDetail(a, tool) : ''
  const mcpSize =
    !web && !vault && typeof a.bytes === 'number' && Number.isFinite(a.bytes)
      ? formatBytes(a.bytes)
      : ''
  const detail = webDetail || mcpSize
  const blocked = a.blocked === true
  const withheld = a.withheld === true
  // A tool that returned isError:true FAILED even if the span status reads ok;
  // an infra fault sets status='error'. Neither applies to a block/withhold.
  const failed = !blocked && !withheld && (a.is_error === true || s.status === 'error')
  const dur = durationLabel(s, now)
  // `statusCls` maps the tool row's real pass/fail outcome onto the SAME
  // run__status--ok / run__status--err classes the model rows use, so an equal
  // outcome reads equally (a passing tool_exec was a grey check before). A
  // block / withhold is governance, not pass/fail — its own loud badge carries
  // it, so the trailing glyph stays neutral rather than claiming ok/err.
  const outcome = blocked
    ? { label: 'blocked · governance (allow-list / sensitivity)', cls: 'run__toolout--blocked', glyph: '⛔', statusCls: '' }
    : withheld
      ? { label: 'result withheld from cloud (sensitive)', cls: 'run__toolout--withheld', glyph: '🔒', statusCls: '' }
      : failed
        ? { label: 'failed', cls: 'run__toolout--err', glyph: '✕', statusCls: 'run__status--err' }
        : { label: '', cls: 'run__toolout--ok', glyph: '✓', statusCls: 'run__status--ok' }
  return (
    <div className="run__row run__row--tool">
      <span className="run__toolglyph">{toolGlyph}</span>
      <span className="run__toolid mono">
        {server}·{tool}
        {notePath && ' · ' + notePath}
      </span>
      {detail && <span className="run__tooldetail mono">{detail}</span>}
      {dur && <span className="run__dur">{dur}</span>}
      {outcome.label && <span className={'run__toolout ' + outcome.cls}>{outcome.label}</span>}
      <span className={'run__status' + (outcome.statusCls ? ' ' + outcome.statusCls : '')}>{outcome.glyph}</span>
    </div>
  )
}

// Claude-Code-depth wrapper (2026-08-29, the founder's own transcript as the
// bar): a row whose span carries real IN/OUT detail becomes a toggle that
// expands into labeled lines; a detail-less span stays a plain row — depth is
// offered exactly where the record has it, never as empty chrome.
function ExpandableRow({
  s,
  children,
  drawerExtra,
}: {
  s: EngineSpan
  children: ReactNode
  drawerExtra?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const d = spanDetails(s)
  if (d.in.length === 0 && d.out.length === 0 && !drawerExtra) return <>{children}</>
  return (
    <div className="run__expand">
      <button
        type="button"
        className={'run__expandbtn' + (open ? ' run__expandbtn--open' : '')}
        aria-expanded={open}
        aria-label={`${s.name} — details`}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div className="run__io mono">
          {d.in.map((l, i) => (
            <div key={'i' + i} className="run__ioline">
              <span className="run__iolabel">IN</span>
              <span className="run__iotext">{l}</span>
            </div>
          ))}
          {d.out.map((l, i) => (
            <div key={'o' + i} className="run__ioline">
              <span className="run__iolabel run__iolabel--out">OUT</span>
              <span className="run__iotext">{l}</span>
            </div>
          ))}
          {drawerExtra}
        </div>
      )}
    </div>
  )
}

export default function RunStream({
  spans,
  now,
  onRevealNote,
}: {
  spans: EngineSpan[]
  now: number
  /** Audit fix (2026-08-30): when the host can reveal vault notes, a vault
   *  row's drawer offers it — a file the stream names becomes reachable
   *  where it is named. Pure renders without the handler are unchanged. */
  onRevealNote?: (rel: string) => void
}) {
  if (spans.length === 0) return null
  return (
    <div className="run__stream">
      {spans.map((s, i) => {
        const a = s.attrs ?? {}
        const isModelCall = s.type === 'model_call' || s.name === 'model_call'
        const isTool =
          s.type === 'tool_exec' &&
          (a.provider === 'mcp' || a.provider === 'web' || a.provider === 'vault')
        const row = isModelCall ? (
          <ModelCallRow s={s} now={now} />
        ) : isTool ? (
          <ToolExecRow s={s} now={now} />
        ) : (
          <div className="run__row run__row--sec">{spanLine(s)}</div>
        )
        const vaultRel =
          s.type === 'tool_exec' && a.provider === 'vault' && typeof a.path === 'string' && a.path
            ? a.path
            : ''
        return (
          <ExpandableRow
            key={i}
            s={s}
            drawerExtra={
              onRevealNote && vaultRel ? (
                <button
                  type="button"
                  className="run__reveal mono"
                  onClick={() => onRevealNote(vaultRel)}
                >
                  reveal in Finder ›
                </button>
              ) : undefined
            }
          >
            {row}
          </ExpandableRow>
        )
      })}
    </div>
  )
}
