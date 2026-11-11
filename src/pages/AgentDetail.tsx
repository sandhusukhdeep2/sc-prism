import { useEffect, useMemo, useState } from 'react'
import { agentRecord, ownActivity } from '../lib/ownActivity'
import { readSpansTail, resolveVaultDir, type EngineSpan } from '../lib/nativeEngine'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { proofChipText } from '../lib/proveAgent'
import './AgentDetail.css'
import {
  agentActivity,
  agentSlug,
  agentWritePath,
  persistAgentToVault,
  remove as removeAgent,
  removeAgentFromVault,
  update as updateAgent,
  useAgents,
  type AgentModel,
  type StoredAgent,
} from '../lib/agents'
import AgentMonogram from '../components/AgentMonogram'
import { rosterGate } from '../lib/roster'
import { useConnectivity } from '../lib/connectivity'
import { useSettings } from '../lib/settings'
import { useProjects } from '../lib/projects'
import { useSkills } from '../lib/skills'
import { MAX_CHARTER } from '../lib/managers'
import { useApp } from '../store/AppStore'

/**
 * The per-agent page (Sukhdeep, dogfooding day one, 2026-08-29): every crew
 * card opens here to be customised. What you edit IS the agent's definition
 * file — Save writes the store and then `persistAgentToVault`, the same
 * write-through every other mutation uses, so the page and the file can never
 * disagree. Built-ins are shown read-only (their store rows are protected by
 * `update()` itself); the enable toggle is the one control they share.
 */
export default function AgentDetail() {
  const { slug } = useParams<{ slug: string }>()
  const agents = useAgents()
  const agent = agents.find((a) => agentSlug(a.name) === slug)

  if (!agent) {
    return (
      <div className="adetail">
        <div className="adetail__missing">
          <p>
            No agent called <span className="mono">{slug}</span> — it may have been renamed or
            deleted.
          </p>
          <Link className="adetail__back" to="/agents">
            ‹ Back to Agents
          </Link>
        </div>
      </div>
    )
  }
  return <AgentEditor key={agent.id} a={agent} />
}

function AgentEditor({ a }: { a: StoredAgent }) {
  const navigate = useNavigate()
  const { settings } = useSettings()
  const { health } = useConnectivity()
  const { projects } = useProjects()
  const { state } = useApp()
  const skills = useSkills()

  const [name, setName] = useState(a.name)
  const [role, setRole] = useState(a.role)
  const [model, setModel] = useState<AgentModel>(a.model)
  const [picked, setPicked] = useState<string[]>(a.skills)
  const [charter, setCharter] = useState(a.charter ?? '')
  const [tools, setTools] = useState<string[]>(a.tools ?? [])
  const [assignedTo, setAssignedTo] = useState(a.assignedTo ?? '')
  const [savedAt, setSavedAt] = useState(0)
  const [confirmDel, setConfirmDel] = useState(false)

  const seatGate = useMemo(() => rosterGate(settings, { health }), [settings, health])
  const sitsOut = seatGate(model)
  const activity = agentActivity(a, state.verdicts)
  // ITS OWN RECORD (2026-11-11): the same span log its card on the crew page
  // reads, far enough back to find its turns days later.
  const [spans, setSpans] = useState<readonly EngineSpan[]>([])
  useEffect(() => {
    let stop = false
    void (async () => {
      try {
        const vault = await resolveVaultDir(settings.vaultPath)
        const tail = await readSpansTail(vault, 4000)
        if (!stop) setSpans(tail)
      } catch {
        /* no log yet — the page says the record is empty */
      }
    })()
    return () => {
      stop = true
    }
  }, [settings.vaultPath, a.id])
  const own = ownActivity(spans, a.name, false)
  const record = agentRecord(spans, a.name, 8)
  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : ms > 0 ? `${Math.round(ms)}ms` : '')

  const toggleSkill = (n: string) =>
    setPicked((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]))

  const toggleTool = (t: string) =>
    setTools((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  const save = () => {
    const nextCharter = charter.slice(0, MAX_CHARTER)
    // A proof vouches for ONE identity — this charter, on this model, with
    // these tools. Change any of those and the dated chip would be a fact
    // about a different agent, so it goes back to "not yet proven". A role
    // line or a skill pick does not change what was proven.
    const sameTools = [...tools].sort().join(',') === [...(a.tools ?? [])].sort().join(',')
    const identityChanged = model !== a.model || nextCharter !== (a.charter ?? '') || !sameTools
    const patch = {
      name: name.trim() || a.name,
      role: role.trim(),
      model,
      skills: picked,
      tools,
      charter: nextCharter,
      assignedTo,
      proof: identityChanged ? undefined : a.proof,
    }
    updateAgent(a.id, patch)
    // Write-through with the merged row (the store hook re-renders async, so
    // build the row the file should say right here).
    void persistAgentToVault({ ...a, ...patch }, settings.vaultPath)
    setSavedAt(Date.now())
  }

  const del = () => {
    removeAgent(a.id)
    if (!a.system) void removeAgentFromVault(a, settings.vaultPath)
    navigate('/agents')
  }

  return (
    <div className="adetail">
      <div className="adetail__top">
        <Link className="adetail__back" to="/agents">
          ‹ Agents
        </Link>
      </div>

      <div className="adetail__head">
        <AgentMonogram name={a.name} model={model} sitsOut={a.enabled ? sitsOut : 'switched off'} />
        <div className="adetail__id">
          {a.system ? (
            <div className="adetail__name">{a.name}</div>
          ) : (
            <input
              className="adetail__name adetail__nameinput"
              value={name}
              aria-label="Agent name"
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <div className="adetail__meta">
            <span className={'adetail__proof' + (a.proof ? (a.proof.proven ? ' is-proven' : ' is-unproven') : '')}>{proofChipText(a.proof)}</span> ·{' '}
            {a.system ? 'built-in · read-only definition' : 'your agent'}
            {' · '}
            {(own ?? activity).label}
          </div>
        </div>
        <span className="adetail__spacer" />
        <button
          type="button"
          className={'adetail__toggle' + (a.enabled ? ' adetail__toggle--on' : '')}
          onClick={() => updateAgent(a.id, { enabled: !a.enabled })}
        >
          {a.enabled ? 'enabled' : 'switched off'}
        </button>
      </div>

      {sitsOut && a.enabled && <div className="adetail__sitout">sits out: {sitsOut}</div>}

      <div className="adetail__grid">
        <section className="adetail__card">
          <h3 className="adetail__kicker">Definition</h3>
          <label className="adetail__field">
            <span className="adetail__flabel">What this coworker is for</span>
            {a.system ? (
              <div className="adetail__ro">{a.role}</div>
            ) : (
              <input
                className="adetail__input"
                value={role}
                aria-label="What this coworker is for"
                onChange={(e) => setRole(e.target.value)}
              />
            )}
          </label>
          <label className="adetail__field">
            <span className="adetail__flabel">Model preference</span>
            {a.system ? (
              <div className="adetail__ro mono">{a.model}</div>
            ) : (
              <select
                className="adetail__input mono"
                value={model}
                aria-label="Model preference"
                onChange={(e) => setModel(e.target.value as AgentModel)}
              >
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
                <option value="local">local</option>
              </select>
            )}
          </label>
          <label className="adetail__field">
            <span className="adetail__flabel">
              Charter — travels into this agent&rsquo;s turns
            </span>
            {a.system ? (
              <div className="adetail__ro">{a.charter?.trim() || 'no charter — runs on its role line alone'}</div>
            ) : (
              <textarea
                className="adetail__input adetail__charter"
                rows={5}
                maxLength={MAX_CHARTER}
                value={charter}
                aria-label="Charter"
                placeholder="What this coworker should always know, in plain words."
                onChange={(e) => setCharter(e.target.value)}
              />
            )}
          </label>
        </section>

        <section className="adetail__card">
          <h3 className="adetail__kicker">Skills</h3>
          {skills.length === 0 && (
            <div className="adetail__hint">no skills in the library yet — add them on the Skills page</div>
          )}
          <div className="adetail__skills">
            {skills.map((s) => (
              <label key={s.id} className="adetail__skill">
                <input
                  type="checkbox"
                  disabled={a.system}
                  checked={picked.includes(s.name)}
                  onChange={() => toggleSkill(s.name)}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </div>

          <h3 className="adetail__kicker adetail__kicker--gap">Tools — what this seat may touch on a board</h3>
          <div className="adetail__skills">
            <label className="adetail__skill">
              <input
                type="checkbox"
                disabled={a.system}
                checked={tools.includes('vault')}
                aria-label="read the vault"
                onChange={() => toggleTool('vault')}
              />
              <span>read the vault (its own retrieval mid-turn)</span>
            </label>
            <label className="adetail__skill">
              <input
                type="checkbox"
                disabled={a.system}
                checked={tools.includes('web')}
                aria-label="use the web"
                onChange={() => toggleTool('web')}
              />
              <span>use the web (search + fetch, only when web research is on)</span>
            </label>
          </div>
          <div className="adetail__hint">
            no boxes ticked = this seat runs with the run&rsquo;s defaults; a tick past your own
            grants is refused out loud at launch, never silently
          </div>

          <h3 className="adetail__kicker adetail__kicker--gap">Placement</h3>
          <label className="adetail__field">
            <span className="adetail__flabel">Works on</span>
            {a.system ? (
              <div className="adetail__ro mono">system-wide</div>
            ) : (
              <select
                className="adetail__input mono"
                value={assignedTo}
                aria-label="Works on"
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                <option value="">library (unassigned)</option>
                <option value="system">system-wide</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="adetail__file mono">file: {agentWritePath(a)}</div>
        </section>
      </div>

      {/* WHAT IT HAS REALLY DONE — its latest turns and the tools it called,
          read from the engine's spans that carry its name. Nothing inferred:
          an empty record says so. */}
      <section className="adetail__card adetail__record" aria-label="Its record">
        <h3 className="adetail__kicker">Its record — from the engine’s own spans</h3>
        {record.turns.length === 0 ? (
          <div className="adetail__hint">
            No turns of its own in the recent log. Prove it on the crew page, or give its project a task.
          </div>
        ) : (
          <>
            <ol className="adetail__turns">
              {record.turns.map((t, i) => (
                <li key={i} className={'adetail__turn' + (t.result === 'no answer' ? ' is-no' : '')}>
                  <span className="adetail__turnstage">{t.stage || 'turn'}</span>
                  <span className="adetail__turnai mono" title={t.ai}>
                    {t.ai || 'an AI'}
                  </span>
                  <span className="adetail__turntok mono" title="tokens in → out">
                    {t.tokensIn.toLocaleString()} → {t.tokensOut.toLocaleString()}
                  </span>
                  <span className="adetail__turnms mono">{fmtMs(t.ms)}</span>
                  <span className="adetail__turnres">
                    {t.result}
                    {t.cause ? ` — ${t.cause}` : ''}
                  </span>
                </li>
              ))}
            </ol>
            {record.tools.length > 0 && (
              <div className="adetail__tools">
                tools it called: {record.tools.map((t) => `${t.name} ×${t.count}`).join(' · ')}
              </div>
            )}
          </>
        )}
      </section>

      {!a.system && (
        <div className="adetail__actions">
          <button type="button" className="adetail__save" onClick={save}>
            Save
          </button>
          {savedAt > 0 && <span className="adetail__saved">saved — the file matches</span>}
          <span className="adetail__spacer" />
          {confirmDel ? (
            <span className="adetail__confirm">
              <span className="mono">Delete “{a.name}”?</span>
              <button type="button" className="adetail__delyes" onClick={del}>
                confirm
              </button>
              <button type="button" className="adetail__delno" onClick={() => setConfirmDel(false)}>
                cancel
              </button>
            </span>
          ) : (
            <button type="button" className="adetail__del" onClick={() => setConfirmDel(true)}>
              Delete agent
            </button>
          )}
        </div>
      )}
    </div>
  )
}
