// THE CEREMONY (design 2026-11-08 §B). Making an agent is four confirmable
// parts — name & role · which AI · what it may use · what it knows — each
// snapping onto the card as it is confirmed, then PROOF: one real call on the
// agent's model and one real, harmless call per granted tool, run through the
// ordinary engine path and graded from the verdict and that run's own spans.
// "proven ✓" only if every call was real; otherwise "unproven — <the engine's
// cause>", and the agent is still created. Nothing here is a new engine mode:
// the proof is `runNativeTask` with agentName / stage 'proof' / the granted
// capabilities, a 400-token budget and one tool turn.
import { useEffect, useRef, useState } from 'react'
import type { AgentModel, StoredAgent } from '../lib/agents'
import { create, list, persistAgentToVault, update } from '../lib/agents'
import type { EngineSpan } from '../lib/nativeEngine'
import { cancelEngineRun, newRunId, readSpansTail } from '../lib/nativeEngine'
import type { Settings } from '../lib/settings'
import { proveAgent, agentSlugForRun, proofButtonLabel } from '../lib/proveAgent'
import { PROOF_MAX_TOKENS, type ProofResult } from '../lib/proofRun'
import type { Project } from '../lib/projects'
import './AgentCeremony.css'

const MODELS: { id: AgentModel; label: string; local: boolean }[] = [
  { id: 'local', label: 'local model', local: true },
  { id: 'claude', label: 'claude', local: false },
  { id: 'gemini', label: 'gemini', local: false },
]

/** The tools a proof can exercise; terminal, computer and writes are granted
 *  elsewhere and never touched by a proof. */
const TOOLS: { id: string; label: string; proof: string }[] = [
  { id: 'vault', label: 'vault', proof: 'lists your notes (names only)' },
  { id: 'web', label: 'web', proof: 'fetches one fixed page' },
  { id: 'tools', label: 'tools', proof: 'granted, not exercised — MCP servers are not reachable from a proof' },
]

function splitList(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function AgentCeremony({
  vaultPath,
  settings,
  seatGate,
  projectId = '',
  projects = [],
  onCreated,
  onCancel,
}: {
  vaultPath: string
  settings: Settings
  /** Token → '' or the reason that model cannot answer right now. */
  seatGate: (token: string) => string
  projectId?: string
  projects?: readonly Project[]
  onCreated: (agent: StoredAgent) => void
  onCancel: () => void
}) {
  const [part, setPart] = useState(0) // how many parts are confirmed
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [model, setModel] = useState<AgentModel>('local')
  const [tools, setTools] = useState<string[]>([])
  const [memory, setMemory] = useState('')
  const [skills, setSkills] = useState('')
  const [worksIn, setWorksIn] = useState(projectId)
  const [proving, setProving] = useState(false)
  const [proof, setProof] = useState<ProofResult | null>(null)
  const [liveLines, setLiveLines] = useState<EngineSpan[]>([])
  const runIdRef = useRef('')

  const isLocal = MODELS.find((m) => m.id === model)?.local ?? false
  const ready = part >= 4 && name.trim() && role.trim()

  // While a proof runs, show its calls as they land in the span tail.
  useEffect(() => {
    if (!proving) return
    let stop = false
    const tick = async () => {
      try {
        const tail = await readSpansTail(vaultPath, 200)
        // The engine stamps its own run id; this run's spans carry the agent and the stage.
        const slug = agentSlugForRun(name)
        if (!stop) setLiveLines(tail.filter((s) => s.type === 'tool_exec' && s.attrs?.agent === slug && s.attrs?.round === 'proof'))
      } catch {
        // the tail is a nicety; the grade comes from the verdict + spans after the run
      }
    }
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [proving, vaultPath, name])

  const prove = async () => {
    if (proving) return
    setProving(true)
    setProof(null)
    const runId = newRunId()
    runIdRef.current = runId
    setProof(await proveAgent({ name, role, model, tools }, vaultPath, settings, runId))
    setProving(false)
  }

  const createAgent = () => {
    if (!ready || proving) return
    const a = create({ name: name.trim(), role: role.trim(), model, skills: splitList(skills), assignedTo: worksIn })
    update(a.id, {
      tools,
      memory: splitList(memory),
      ...(proof ? { proof: { at: proof.at, proven: proof.proven, reason: proof.reason } } : {}),
    })
    const final = list().find((x) => x.id === a.id) ?? a
    void persistAgentToVault(final, vaultPath)
    onCreated(final)
  }

  const confirm = (n: number) => () => setPart((p) => Math.max(p, n))
  const cancel = () => {
    if (proving && runIdRef.current) void cancelEngineRun(runIdRef.current)
    onCancel()
  }

  return (
    <section className="ceremony" aria-label="New agent">
      {/* THE CARD — grows a part at a time. */}
      <div className="ceremony__card" data-testid="ceremony-card">
        <span className={'ceremony__mono' + (proof ? (proof.proven ? ' is-proven' : ' is-unproven') : '')} aria-hidden="true">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="ceremony__who">
          <div className="ceremony__name">{name.trim() || 'New agent'}</div>
          <div className="ceremony__role">{role.trim() || 'what it is for'}</div>
        </div>
        {part >= 2 && <span className={'ceremony__chip snap' + (isLocal ? ' ceremony__chip--local' : '')}>{isLocal ? '🔒 ' : ''}{model}</span>}
        {part >= 3 && tools.map((t) => <span key={t} className="ceremony__chip snap">{t}</span>)}
        {part >= 4 && (splitList(memory).length > 0 || splitList(skills).length > 0) && (
          <span className="ceremony__chip snap">{[...splitList(memory), ...splitList(skills)].join(' · ')}</span>
        )}
        <span className={'ceremony__badge' + (proof ? (proof.proven ? ' is-proven' : ' is-unproven') : '')}>
          {proof ? (proof.proven ? `proven ✓ ${clock(proof.at)}` : `unproven — ${proof.reason}`) : 'not yet proven'}
        </span>
      </div>

      {/* PART 1 */}
      <div className="ceremony__part">
        <span className={'ceremony__num' + (part >= 1 ? ' is-done' : '')}>1</span>
        <div className="ceremony__body">
          <h3>Name &amp; role</h3>
          <input className="ceremony__input" aria-label="Name" placeholder="e.g. Compliance checker" value={name} onChange={(e) => setName(e.target.value)} disabled={part >= 1} />
          <input className="ceremony__input" aria-label="What it is for" placeholder="in plain words — checks every proposal against the never-touch list" value={role} onChange={(e) => setRole(e.target.value)} disabled={part >= 1} />
          {projects.length > 0 && (
            <select className="ceremony__input" aria-label="Works in" value={worksIn} onChange={(e) => setWorksIn(e.target.value)} disabled={part >= 1}>
              <option value="">the library (no project yet)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
        {part < 1 && (
          <button type="button" className="ceremony__confirm" onClick={confirm(1)} disabled={!name.trim() || !role.trim()}>
            Confirm name &amp; role
          </button>
        )}
      </div>

      {/* PART 2 */}
      {part >= 1 && (
        <div className="ceremony__part">
          <span className={'ceremony__num' + (part >= 2 ? ' is-done' : '')}>2</span>
          <div className="ceremony__body">
            <h3>Which AI</h3>
            <div className="ceremony__choices" role="radiogroup" aria-label="Which AI">
              {MODELS.map((m) => {
                const blocked = seatGate(m.id)
                return (
                  <label key={m.id} className={'ceremony__choice' + (model === m.id ? ' is-on' : '')} title={blocked || undefined}>
                    <input type="radio" name="ceremony-model" aria-label={m.label} checked={model === m.id} disabled={part >= 2 || !!blocked} onChange={() => setModel(m.id)} />
                    {m.local ? '🔒 ' : ''}{m.label}{blocked ? ' — ' + blocked : ''}
                  </label>
                )
              })}
            </div>
            <p className="ceremony__hint">local stays on this Mac; a cloud brand costs tokens and proving it costs cents.</p>
          </div>
          {part < 2 && (
            <button type="button" className="ceremony__confirm" onClick={confirm(2)}>
              Confirm which AI
            </button>
          )}
        </div>
      )}

      {/* PART 3 */}
      {part >= 2 && (
        <div className="ceremony__part">
          <span className={'ceremony__num' + (part >= 3 ? ' is-done' : '')}>3</span>
          <div className="ceremony__body">
            <h3>What it may use</h3>
            <div className="ceremony__choices">
              {TOOLS.map((t) => (
                <label key={t.id} className={'ceremony__choice' + (tools.includes(t.id) ? ' is-on' : '')}>
                  <input
                    type="checkbox"
                    aria-label={`may use ${t.label}`}
                    checked={tools.includes(t.id)}
                    disabled={part >= 3}
                    onChange={() => setTools((ts) => (ts.includes(t.id) ? ts.filter((x) => x !== t.id) : [...ts, t.id]))}
                  />
                  {t.label} <span className="ceremony__hint">· proof {t.proof}</span>
                </label>
              ))}
            </div>
            <p className="ceremony__hint">your own grants are the ceiling; terminal, computer and file writes are granted on the agent's page and never exercised by a proof; MCP tools are not exercised by a proof either.</p>
          </div>
          {part < 3 && (
            <button type="button" className="ceremony__confirm" onClick={confirm(3)}>
              Confirm what it may use
            </button>
          )}
        </div>
      )}

      {/* PART 4 */}
      {part >= 3 && (
        <div className="ceremony__part">
          <span className={'ceremony__num' + (part >= 4 ? ' is-done' : '')}>4</span>
          <div className="ceremony__body">
            <h3>What it knows</h3>
            <input className="ceremony__input" aria-label="Memory scopes" placeholder="vault folders it may read, comma-separated — e.g. proposals/, governance/" value={memory} onChange={(e) => setMemory(e.target.value)} disabled={part >= 4} />
            <input className="ceremony__input" aria-label="Skills" placeholder="skills from your library, comma-separated" value={skills} onChange={(e) => setSkills(e.target.value)} disabled={part >= 4} />
          </div>
          {part < 4 && (
            <button type="button" className="ceremony__confirm" onClick={confirm(4)}>
              Confirm what it knows
            </button>
          )}
        </div>
      )}

      {/* PROOF + CREATE */}
      {part >= 4 && (
        <div className="ceremony__proof">
          <div className="ceremony__proofhead">
            <strong>Prove it</strong>
            <span className="ceremony__hint">one real call on its model, one real call per tool · replies capped at {PROOF_MAX_TOKENS} tokens · the proof asks it to use each tool; a model that ignores the ask reads unproven · MCP tools are not exercised by a proof</span>
          </div>
          {proving && (
            <div className="ceremony__lines" aria-live="polite">
              <div className="ceremony__line">asking {model}…</div>
              {liveLines.map((s, i) => (
                <div key={i} className="ceremony__line">{String(s.attrs?.tool ?? 'tool')} {String(s.attrs?.path ?? s.attrs?.url ?? s.attrs?.server ?? '')}</div>
              ))}
            </div>
          )}
          {proof && (
            <div className="ceremony__lines">
              {proof.lines.map((l, i) => (
                <div key={i} className={'ceremony__line' + (l.ok ? ' is-ok' : ' is-no')}>
                  {l.ok ? '✓' : '✕'} {l.kind === 'model' ? 'answered' : l.label} — {l.detail}
                </div>
              ))}
            </div>
          )}
          <div className="ceremony__actions">
            <button type="button" className="ceremony__prove" onClick={() => void prove()} disabled={proving}>
              {proofButtonLabel(model)}
            </button>
            <span className="ceremony__spacer" />
            <button type="button" className="ceremony__cancel" onClick={cancel}>Cancel</button>
            <button type="button" className="ceremony__create" onClick={createAgent} disabled={!ready || proving}>
              Create agent
            </button>
          </div>
          <p className="ceremony__hint">
            Writes <code>agents/{agentSlugForRun(name)}.md</code> to your vault — the same file other tools can read. If a proof call fails, the agent is still created, marked unproven, with the reason in the engine's own words.
          </p>
        </div>
      )}
    </section>
  )
}
