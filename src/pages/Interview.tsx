import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOnboarding } from '../lib/onboarding'
import {
  getInterview,
  PRIORITY_LABEL,
  ROLE_HATS,
  SIGNOFFS,
  setInterview,
  useInterview,
  type Priority,
  type SignoffId,
} from '../lib/interview'
import {
  generateAdaptiveQuestion,
  nextAdaptiveStep,
  scriptedFallbackDisplay,
  type GeneratedQuestion,
} from '../lib/interviewAdaptive'
import { isCliProvider, isCustomProvider, primaryDisplayName, useSettings } from '../lib/settings'
import { isNative, resolveVaultDir, runNativeTask, writeVaultNote } from '../lib/nativeEngine'
import { buildEngineProviders, isRealCompletion, messageModelFromVerdict } from '../store/AppStore'
import Stepper from '../components/Stepper'
import './Interview.css'

// The interview is a CHAT: the co-founder asks, offers option chips (tap to
// accept) — or you type a custom answer in the input bar. Each answer lands in
// the thread, the next question follows, and only when everything is set does
// the "continue" button appear. After the company question the primary runs a
// REAL research pass, then GENERATES up to ADAPTIVE_MAX tailored questions
// live (2026-07-29 spec) before the scripted governance walk; before finishing
// it reports the capabilities and sensitivity advice for every connected AI.

type Stage =
  | 'business'
  | 'company'
  | 'research'
  | 'adaptive'
  | 'departments'
  | 'team'
  | 'budget'
  | 'roles'
  | 'priorities'
  | 'signoffs'
  | 'never'
  | 'sensitive'
  | 'verify'
  | 'compliance'
  | 'capability'
  | 'done'

interface Msg {
  role: 'ai' | 'user'
  text: string
  /** Honest attribution for a GENERATED question — the REAL "provider · model"
   * the Verdict recorded. Absent for scripted copy (no chip, never invented). */
  model?: string
  /** True when the generated question stayed on this Mac (local route). */
  isLocal?: boolean
}

interface IndustryPreset {
  id: string
  label: string
  body: string
  neverTouch: string[]
  signoffs: SignoffId[]
}

const INDUSTRIES: IndustryPreset[] = [
  {
    id: 'software',
    label: 'Software / IT services',
    body: 'Software consultancy — we build and maintain software and internal tools for clients.',
    neverTouch: ['prod DB', '/secrets', 'client repos'],
    signoffs: ['push-main', 'spend'],
  },
  {
    id: 'logistics',
    label: 'Logistics & transport',
    body: 'Logistics business — freight, fleet operations and compliance for transport clients.',
    neverTouch: ['prod DB', 'driver PII', 'compliance records'],
    signoffs: ['push-main', 'delete-audit', 'spend'],
  },
  {
    id: 'ecommerce',
    label: 'E-commerce / retail',
    body: 'E-commerce business — online store, inventory and customer operations.',
    neverTouch: ['payment settings', 'customer PII', 'live storefront'],
    signoffs: ['spend', 'change-perms'],
  },
  {
    id: 'agency',
    label: 'Marketing / creative agency',
    body: 'Agency — campaigns, content and client accounts.',
    neverTouch: ['client ad accounts', 'published campaigns', 'billing'],
    signoffs: ['spend', 'change-perms'],
  },
  {
    id: 'finance',
    label: 'Finance / accounting',
    body: 'Finance practice — bookkeeping, reporting and advisory for clients.',
    neverTouch: ['client ledgers', 'tax filings', 'banking access'],
    signoffs: ['push-main', 'delete-audit', 'change-perms', 'spend'],
  },
  {
    id: 'health',
    label: 'Healthcare / clinic',
    body: 'Healthcare practice — patient services and clinic operations.',
    neverTouch: ['patient records', 'prescriptions', 'billing'],
    signoffs: ['delete-audit', 'change-perms', 'spend'],
  },
]

const QUESTION: Record<
  Exclude<Stage, 'business' | 'research' | 'adaptive' | 'capability' | 'done'>,
  string
> = {
  company:
    'What is the business called? If it has a public website or links, drop them here too — I’ll research it. Or tap “private / skip”.',
  departments:
    'Which departments does the company have? Tap all that apply — or type your own, comma-separated.',
  team: 'How big is the team?',
  budget: 'Roughly what monthly budget for AI & tooling should I plan within?',
  roles: 'Which hats do YOU wear day-to-day? Tap all that apply, then confirm — or type them.',
  priorities:
    'What matters most right now — compliance, speed, or cost? Tap one (the other two follow in order).',
  signoffs:
    'Which actions must ALWAYS wait for your explicit sign-off? Tap to toggle, confirm when done.',
  never: 'Your never-touch list — things no agent may ever modify. Add or remove items, then confirm.',
  sensitive:
    'Which words or topics must NEVER leave this Mac? Any task mentioning them routes to your LOCAL model automatically — real enforcement, not a note. Tap suggestions or type your own.',
  verify:
    'Before I trust any work, I can run a quick automatic check first. If your project has a command that tests it (developers often use “npm test” or “pytest”), give it to me and I’ll run it every time — if it fails, I stop right there and don’t spend a cent on AI. Not technical or not sure? Just tap “skip” — you can add this later.',
  compliance:
    'Any compliance regimes that apply to the business? I fold them into every plan and report.',
}

const SENSITIVE_SUGGESTIONS = ['client PII', 'financials', 'passwords / keys', 'medical records']
const VERIFY_SUGGESTIONS = ['npm test', 'pytest', 'make test']
const COMPLIANCE_OPTIONS = ['GDPR', 'HIPAA', 'SOC 2', 'PCI-DSS', 'ISO 27001']

const DEPARTMENTS = [
  'operations',
  'sales & marketing',
  'finance',
  'tech / dev',
  'compliance',
  'HR',
  'customer support',
]
const TEAM_SIZES = ['Just me', '2–5 people', '6–20 people', '20+ people']
const BUDGETS = ['under $50/mo', '$50–200/mo', '$200–1k/mo', '$1k+/mo']

// Edit-all view: shown when the interview was already answered. Every question
// is a section with its CURRENT answer pre-selected and individually editable —
// change one thing without replaying the whole chat. Changing the industry
// offers to re-tailor the dependent drafts (not silently overwrite).
function InterviewEditAll({
  onWalkChat,
  onDone,
}: {
  onWalkChat: () => void
  onDone: () => void
}) {
  const { settings } = useSettings()
  const { interview, toggleRole, movePriority, toggleSignoff } = useInterview()
  const iv = interview
  const [customTeam, setCustomTeam] = useState('')
  const [customBudget, setCustomBudget] = useState('')
  const [deptAdd, setDeptAdd] = useState('')
  const [sensAdd, setSensAdd] = useState('')
  const [compAdd, setCompAdd] = useState('')
  const [neverAdd, setNeverAdd] = useState('')
  const [retailor, setRetailor] = useState<IndustryPreset | null>(null)
  const primaryName = primaryDisplayName(settings)

  const addTo = (key: 'departments' | 'sensitiveWords' | 'compliance' | 'neverTouch', val: string) => {
    const items = val.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
    if (!items.length) return
    const cur = iv[key]
    const merged = [...cur]
    for (const it of items) if (!merged.includes(it)) merged.push(it)
    setInterview({ [key]: merged } as Partial<typeof iv>)
  }
  const removeFrom = (key: 'departments' | 'sensitiveWords' | 'compliance' | 'neverTouch', val: string) => {
    setInterview({ [key]: iv[key].filter((x) => x !== val) } as Partial<typeof iv>)
  }
  const toggleIn = (key: 'departments' | 'sensitiveWords' | 'compliance', val: string) => {
    const cur = iv[key]
    setInterview({ [key]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] } as Partial<typeof iv>)
  }

  const pickIndustry = (p: IndustryPreset) => {
    setInterview({ business: p.body })
    setRetailor(p) // offer to also re-tailor gates + never-touch
  }
  const applyRetailor = () => {
    if (!retailor) return
    setInterview({ neverTouch: [...retailor.neverTouch], signoffs: [...retailor.signoffs] })
    setRetailor(null)
  }

  return (
    <div className="ive">
      <div className="ive__head">
        <div>
          <div className="ive__title">Your answers</div>
          <div className="ive__sub">
            Change anything — it saves instantly. {primaryName} carries these on every call.
          </div>
        </div>
        <span className="ive__spacer" />
        <button type="button" className="ive__walk" onClick={onWalkChat}>
          Walk it as a chat instead
        </button>
      </div>

      {/* Business / industry */}
      <section className="ive__q">
        <div className="ive__qlabel">What your business does</div>
        <div className="iv__chips">
          {INDUSTRIES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'iv__chip' + (iv.business === p.body ? ' iv__chip--on' : '')}
              onClick={() => pickIndustry(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="ive__textarea"
          rows={2}
          value={iv.business}
          onChange={(e) => setInterview({ business: e.target.value })}
        />
        {retailor && (
          <div className="ive__retailor">
            Re-tailor sign-off gates &amp; never-touch for <b>{retailor.label}</b>?
            <button type="button" className="ive__retailoryes" onClick={applyRetailor}>Yes, update them</button>
            <button type="button" className="ive__retailorno" onClick={() => setRetailor(null)}>Keep mine</button>
          </div>
        )}
      </section>

      {/* Company + website */}
      <section className="ive__q">
        <div className="ive__qlabel">Company name &amp; website</div>
        <div className="ive__row">
          <input className="ive__input" value={iv.companyName} placeholder="company name"
            onChange={(e) => setInterview({ companyName: e.target.value })} />
          <input className="ive__input mono" value={iv.website} placeholder="website / links (optional)"
            onChange={(e) => setInterview({ website: e.target.value })} />
        </div>
      </section>

      {/* Departments */}
      <section className="ive__q">
        <div className="ive__qlabel">Departments · {iv.departments.length}</div>
        <div className="iv__chips">
          {[...new Set([...DEPARTMENTS, ...iv.departments])].map((d) => (
            <button key={d} type="button"
              className={'iv__chip' + (iv.departments.includes(d) ? ' iv__chip--on' : '')}
              onClick={() => toggleIn('departments', d)}>
              {iv.departments.includes(d) ? '✓ ' : ''}{d}
            </button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input" value={deptAdd} placeholder="add a department…"
            onChange={(e) => setDeptAdd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addTo('departments', deptAdd); setDeptAdd('') } }} />
        </div>
      </section>

      {/* Team size */}
      <section className="ive__q">
        <div className="ive__qlabel">Team size — <b>{iv.teamSize || 'not set'}</b></div>
        <div className="iv__chips">
          {TEAM_SIZES.map((t) => (
            <button key={t} type="button"
              className={'iv__chip' + (iv.teamSize === t ? ' iv__chip--on' : '')}
              onClick={() => setInterview({ teamSize: t })}>{t}</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input" value={customTeam} placeholder='exact number — e.g. "12 people"'
            onChange={(e) => setCustomTeam(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customTeam.trim()) {
                const n = parseInt(customTeam.replace(/[^0-9]/g, ''), 10)
                setInterview({ teamSize: Number.isFinite(n) && n > 0 ? `${n} people` : customTeam.trim() })
                setCustomTeam('')
              }
            }} />
        </div>
      </section>

      {/* Budget */}
      <section className="ive__q">
        <div className="ive__qlabel">Monthly AI/tooling budget — <b>{iv.budget || 'not set'}</b></div>
        <div className="iv__chips">
          {BUDGETS.map((b) => (
            <button key={b} type="button"
              className={'iv__chip' + (iv.budget === b ? ' iv__chip--on' : '')}
              onClick={() => setInterview({ budget: b })}>{b}</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input" value={customBudget} placeholder='exact amount — e.g. "$500" or "3k"'
            onChange={(e) => setCustomBudget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customBudget.trim()) {
                const m = customBudget.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(k)?/)
                if (m) { let a = parseFloat(m[1].replace(',', '.')); if (m[2]) a *= 1000; if (a > 0) setInterview({ budget: `$${Math.round(a).toLocaleString()}/mo` }) }
                setCustomBudget('')
              }
            }} />
        </div>
      </section>

      {/* Roles */}
      <section className="ive__q">
        <div className="ive__qlabel">Your hats</div>
        <div className="iv__chips">
          {ROLE_HATS.map((r) => (
            <button key={r} type="button"
              className={'iv__chip' + (iv.roles.includes(r) ? ' iv__chip--on' : '')}
              onClick={() => toggleRole(r)}>{iv.roles.includes(r) ? '✓ ' : ''}{r}</button>
          ))}
        </div>
      </section>

      {/* Priorities */}
      <section className="ive__q">
        <div className="ive__qlabel">Priorities (top first)</div>
        <div className="iv__rank">
          {iv.priorities.map((p, i) => (
            <div key={p} className={'iv__rankcard' + (i === 0 ? ' iv__rankcard--top' : '')}>
              <div className={'iv__rankorder mono' + (i === 0 ? ' iv__rankorder--top' : '')}>{i + 1}</div>
              <div className="iv__ranklabel">{PRIORITY_LABEL[p]}</div>
              <div className="iv__rankmove">
                <button type="button" className="iv__movebtn" disabled={i === 0} onClick={() => movePriority(p, -1)}>▲</button>
                <button type="button" className="iv__movebtn" disabled={i === iv.priorities.length - 1} onClick={() => movePriority(p, 1)}>▼</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sign-off gates */}
      <section className="ive__q">
        <div className="ive__qlabel">Sign-off gates</div>
        <div className="iv__chips">
          {SIGNOFFS.map((s) => (
            <button key={s.id} type="button"
              className={'iv__chip' + (iv.signoffs.includes(s.id) ? ' iv__chip--on' : '')}
              onClick={() => toggleSignoff(s.id)}>{iv.signoffs.includes(s.id) ? '✓ ' : ''}{s.label}</button>
          ))}
        </div>
      </section>

      {/* Sensitive words */}
      <section className="ive__q">
        <div className="ive__qlabel">Force-local words · {iv.sensitiveWords.length}</div>
        <div className="iv__chips">
          {[...new Set([...SENSITIVE_SUGGESTIONS, ...iv.sensitiveWords])].map((w) => (
            <button key={w} type="button"
              className={'iv__chip' + (iv.sensitiveWords.includes(w) ? ' iv__chip--on' : '')}
              onClick={() => toggleIn('sensitiveWords', w)}>{iv.sensitiveWords.includes(w) ? '✓ ' : ''}{w}</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input" value={sensAdd} placeholder="add force-local words…"
            onChange={(e) => setSensAdd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addTo('sensitiveWords', sensAdd); setSensAdd('') } }} />
        </div>
      </section>

      {/* Verify command */}
      <section className="ive__q">
        <div className="ive__qlabel">Auto-check before trusting work</div>
        <div className="ive__qhelp">
          A test command I run automatically first — if it fails I stop and spend no AI tokens.
          Leave blank if you&rsquo;re not sure.
        </div>
        <div className="iv__chips">
          {VERIFY_SUGGESTIONS.map((c) => (
            <button key={c} type="button"
              className={'iv__chip mono' + (iv.verifyCommand === c ? ' iv__chip--on' : '')}
              onClick={() => setInterview({ verifyCommand: c })}>{c}</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input mono" value={iv.verifyCommand} placeholder='e.g. "./verify.sh"'
            onChange={(e) => setInterview({ verifyCommand: e.target.value })} />
        </div>
      </section>

      {/* Compliance */}
      <section className="ive__q">
        <div className="ive__qlabel">Compliance regimes</div>
        <div className="iv__chips">
          {[...new Set([...COMPLIANCE_OPTIONS, ...iv.compliance])].map((c) => (
            <button key={c} type="button"
              className={'iv__chip' + (iv.compliance.includes(c) ? ' iv__chip--on' : '')}
              onClick={() => toggleIn('compliance', c)}>{iv.compliance.includes(c) ? '✓ ' : ''}{c}</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input" value={compAdd} placeholder="add a regime…"
            onChange={(e) => setCompAdd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addTo('compliance', compAdd); setCompAdd('') } }} />
        </div>
      </section>

      {/* Never-touch */}
      <section className="ive__q">
        <div className="ive__qlabel">Never-touch list</div>
        <div className="iv__tags">
          {iv.neverTouch.map((t) => (
            <button key={t} type="button" className="iv__tag mono" onClick={() => removeFrom('neverTouch', t)}>{t} ✕</button>
          ))}
        </div>
        <div className="ive__row">
          <input className="ive__input mono" value={neverAdd} placeholder="add items, comma-separated…"
            onChange={(e) => setNeverAdd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addTo('neverTouch', neverAdd); setNeverAdd('') } }} />
        </div>
      </section>

      <div className="ive__cta">
        <button type="button" className="btn-gold" onClick={onDone}>Save &amp; continue to review →</button>
      </div>
    </div>
  )
}

export default function Interview() {
  const { completeStep, nextRoute, completedSteps, pause } = useOnboarding()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const alreadyDone = completedSteps.includes('interview')
  // Default to edit-all when answers already exist; let the user switch to chat.
  const [editMode, setEditMode] = useState(alreadyDone)
  const { interview, toggleRole, toggleSignoff, addTag, removeTag } = useInterview()
  const { business, companyName, website, departments, teamSize, budget, roles, priorities, signoffs, neverTouch, sensitiveWords, verifyCommand, compliance } = interview
  const primaryName = primaryDisplayName(settings)

  const [msgs, setMsgs] = useState<Msg[]>([])
  const [stage, setStage] = useState<Stage>('business')
  const [input, setInput] = useState('')
  const [researching, setResearching] = useState(false)
  // Adaptive phase (2026-07-29 spec): the generated question awaiting an
  // answer, how many were answered this walk, and an epoch guard so a late
  // generation result is dropped after the user skips ahead.
  const [generating, setGenerating] = useState(false)
  const pendingQRef = useRef<GeneratedQuestion | null>(null)
  const adaptiveTurnsRef = useRef(0)
  const adaptiveEpochRef = useRef(0)
  const industryRef = useRef<IndustryPreset | null>(null)
  const startedRef = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // "Custom…" chips: prompt + focus the chat input for a typed value.
  const promptCustom = (hint: string) => {
    say({ role: 'ai', text: hint })
    inputRef.current?.focus()
  }

  const say = (m: Msg) => setMsgs((t) => [...t, m])

  // REAL industry research through the engine → primary. Falls back honestly.
  const runResearch = async (name: string, links: string) => {
    setStage('research')
    if (!isNative()) {
      say({ role: 'ai', text: 'Research needs the installed app — skipping ahead.' })
      startAdaptive()
      return
    }
    const { providers, primaryReal } = buildEngineProviders(settings)
    if (!primaryReal) {
      say({ role: 'ai', text: 'No primary AI connected for research — skipping ahead.' })
      startAdaptive()
      return
    }
    setResearching(true)
    say({
      role: 'ai',
      text: `Give me a moment — researching ${name || 'your industry'}${links ? ` (${links})` : ''}…`,
    })
    try {
      const vault = await resolveVaultDir(settings.vaultPath)
      const prompt = [
        '[SETUP RESEARCH] Research brief for a new client of SC Prism (AI workbench with governance).',
        `Business description: ${business || '(none given)'}`,
        `Company name: ${name || '(not given)'}`,
        `Public website/links: ${links || '(none — private)'}`,
        industryRef.current ? `Industry category: ${industryRef.current.label}` : '',
        '',
        'In under 180 words, plain text with short bullets, give:',
        '1) What this company appears to do.',
        '2) Three things competitors in this industry are doing right now.',
        '3) Two or three concrete improvements an AI workbench could implement for them first.',
        'If you cannot browse the web, open with the line "(from model knowledge)" and be honest about uncertainty.',
      ]
        .filter(Boolean)
        .join('\n')
      const verdict = await Promise.race([
        runNativeTask(prompt, vault, providers),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
      ])
      if (verdict && isRealCompletion(verdict.response)) {
        say({ role: 'ai', text: verdict.response })
        // First real deliverable: draft a "first 3 automations" plan and save
        // it into the vault as markdown — setup ends with actual work product.
        const planPrompt = [
          '[SETUP DELIVERABLE] Based on the research above, write a concise markdown plan titled "First 3 Automations".',
          `Business: ${business || name || 'this business'}.`,
          'For EACH of the 3, give: a bold one-line name, 2 sentences on what it does and why it wins, and a "First step:" line.',
          'Under 220 words. Markdown only — no preamble.',
          '',
          `Research findings:\n${verdict.response}`,
        ].join('\n')
        const planVerdict = await Promise.race([
          runNativeTask(planPrompt, vault, providers),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
        ])
        if (planVerdict && isRealCompletion(planVerdict.response)) {
          const md = `# First 3 Automations\n\n> Drafted by ${primaryName} during setup — your first deliverable.\n\n${planVerdict.response}\n`
          const path = await writeVaultNote(vault, 'plans/first-automations.md', md)
          say({
            role: 'ai',
            text: path
              ? `I drafted our first plan and saved it to your vault → plans/first-automations.md. It's your first real deliverable — open it in the vault (or Obsidian) anytime.`
              : `I drafted a first-automations plan — I'll save it to the vault once we finish setup.`,
          })
        }
      } else {
        say({ role: 'ai', text: `Couldn't reach ${primaryName} for the research just now — we can rerun it later from the Workspace chat.` })
      }
    } finally {
      setResearching(false)
      // Research done — the primary now interviews adaptively (falls back to
      // the scripted questions, honestly marked, if it can't).
      startAdaptive()
    }
  }

  // Opening question (guarded against double-mount).
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    say({
      role: 'ai',
      text: `${primaryName} here — a few quick questions and I'll draft your governance from the answers. First: what does your business do? Tap the closest category below, or just type it.`,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Optional-call: jsdom has no scrollIntoView, and a scroll convenience
    // must never be able to throw out of an effect.
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [msgs, stage])

  // ---- stage transitions ------------------------------------------------

  const askNext = (
    next: Exclude<Stage, 'business' | 'research' | 'adaptive' | 'capability' | 'done'>,
  ) => {
    setStage(next)
    say({ role: 'ai', text: QUESTION[next] })
  }

  // ---- adaptive questions (2026-07-29 spec) -----------------------------
  // After the seed answers the PRIMARY generates up to 5 next questions — one
  // governed run each (same idiom as the research brief, token-capped). Any
  // failure (no provider, stub, timeout, unusable reply) drops STRAIGHT into
  // the scripted flow: the next unused scripted question is asked with the
  // honest marker — never presented as generated, and the interview never
  // blocks on a provider.

  /** Hand over to the scripted flow. `marked` = a generated question was due
   * but no live model delivered one → the fallback carries the honest marker. */
  const enterScripted = (marked: boolean) => {
    pendingQRef.current = null
    setGenerating(false)
    if (marked) {
      setStage('departments')
      say({ role: 'ai', text: scriptedFallbackDisplay(QUESTION.departments) })
    } else {
      askNext('departments')
    }
  }

  const continueAdaptive = async () => {
    const { providers, primaryReal } = buildEngineProviders(settings)
    const step = nextAdaptiveStep(adaptiveTurnsRef.current, isNative(), primaryReal)
    if (step.kind === 'scripted') {
      enterScripted(step.marked)
      return
    }
    const epoch = ++adaptiveEpochRef.current
    setStage('adaptive')
    pendingQRef.current = null
    setGenerating(true)
    try {
      const vault = await resolveVaultDir(settings.vaultPath)
      const iv = getInterview()
      const generated = await generateAdaptiveQuestion(
        vault,
        providers,
        {
          business: iv.business,
          companyName: iv.companyName,
          qa: iv.adaptive.map(({ q, a }) => ({ q, a })),
        },
        // The REAL engine + the sanctioned honesty helpers — the lib races the
        // run against its timeout and returns null on anything non-real.
        { runTask: runNativeTask, isRealCompletion, modelMeta: messageModelFromVerdict },
      )
      if (epoch !== adaptiveEpochRef.current) return // user moved on — drop the late result
      if (!generated) {
        enterScripted(true)
        return
      }
      pendingQRef.current = generated
      say({
        role: 'ai',
        text: generated.q,
        // Attribution only when the Verdict named a real model — never invented.
        ...(generated.model ? { model: generated.model, isLocal: generated.isLocal } : {}),
      })
    } finally {
      if (epoch === adaptiveEpochRef.current) setGenerating(false)
    }
  }

  const startAdaptive = () => {
    adaptiveTurnsRef.current = 0
    setInterview({ adaptive: [] }) // fresh walk — clear a previous walk's Q&A
    void continueAdaptive()
  }

  /** User opts out — their call, not a provider failure, so no marker. */
  const skipAdaptive = () => {
    adaptiveEpochRef.current++ // any in-flight generation resolves into the void
    say({ role: 'user', text: 'Switch to the standard questions' })
    enterScripted(false)
  }

  const answerBusiness = (text: string, preset?: IndustryPreset) => {
    industryRef.current = preset ?? null
    if (preset) {
      setInterview({
        business: preset.body,
        neverTouch: [...preset.neverTouch],
        signoffs: [...preset.signoffs],
      })
    } else {
      setInterview({ business: text })
    }
    say({ role: 'user', text: preset ? `${preset.label} — ${preset.body}` : text })
    say({
      role: 'ai',
      text: preset
        ? `${preset.label} — noted. I've pre-tailored your sign-off gates and never-touch drafts for that category; you'll confirm them shortly.`
        : 'Got it — I’ll plan around that.',
    })
    askNext('company')
  }

  const answerCompany = (text: string) => {
    const urls = text.match(/(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+\.(com|ai|io|net|org|au|in)[^\s]*)/gi) ?? []
    const name = text
      .replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, '')
      .replace(/[,;]+/g, ' ')
      .trim()
    setInterview({ companyName: name, website: urls.join(' ') })
    say({ role: 'user', text })
    void runResearch(name, urls.join(' '))
  }

  const skipCompany = () => {
    setInterview({ companyName: '', website: '' })
    say({ role: 'user', text: 'Private — skip the research' })
    say({ role: 'ai', text: 'No problem — everything stays between us.' })
    startAdaptive()
  }

  const toggleDepartment = (d: string) => {
    const cur = departments
    setInterview({
      departments: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d],
    })
  }

  const confirmDepartments = () => {
    say({
      role: 'user',
      text: departments.length ? `Departments: ${departments.join(', ')}` : 'No separate departments',
    })
    say({
      role: 'ai',
      text: departments.length
        ? `${departments.length} department${departments.length === 1 ? '' : 's'} — I'll consider who owns what when drafting work.`
        : 'All-in-one team — keeps approvals simple.',
    })
    askNext('team')
  }

  const pickTeam = (t: string) => {
    setInterview({ teamSize: t })
    say({ role: 'user', text: t })
    askNext('budget')
  }

  const pickBudget = (b: string) => {
    setInterview({ budget: b })
    say({ role: 'user', text: b })
    say({
      role: 'ai',
      text: `Planning within ${b} — I'll favor ${b.startsWith('under') ? 'local + free-tier routes and flag anything that costs money' : 'the best tool for each task while tracking burn on the Stats page'}.`,
    })
    askNext('roles')
  }

  const confirmRoles = () => {
    if (roles.length === 0) {
      say({ role: 'ai', text: 'Pick at least one hat — or type e.g. “developer and reviewer”.' })
      return
    }
    say({ role: 'user', text: `My hats: ${roles.join(', ')}` })
    say({ role: 'ai', text: `${roles.length} hat${roles.length === 1 ? '' : 's'} — noted.` })
    askNext('priorities')
  }

  const pickPriority = (first: Priority) => {
    const rest = priorities.filter((p) => p !== first)
    setInterview({ priorities: [first, ...rest] })
    say({ role: 'user', text: `${PRIORITY_LABEL[first]} first` })
    say({
      role: 'ai',
      text: `${PRIORITY_LABEL[first]}-first — routing and my drafts will honor that order (then ${rest
        .map((p) => PRIORITY_LABEL[p].toLowerCase())
        .join(', ')}).`,
    })
    askNext('signoffs')
  }

  const confirmSignoffs = () => {
    const gates = SIGNOFFS.filter((s) => signoffs.includes(s.id)).map((s) => s.gate)
    say({
      role: 'user',
      text: gates.length ? `Sign-off gates: ${gates.join(', ')}` : 'No sign-off gates',
    })
    say({
      role: 'ai',
      text: gates.length
        ? `${gates.length} gate${gates.length === 1 ? '' : 's'} — I will always stop and ask there.`
        : 'No gates — I will still confirm anything risky.',
    })
    askNext('never')
  }

  const confirmNever = () => {
    say({
      role: 'user',
      text: neverTouch.length ? `Never touch: ${neverTouch.join(', ')}` : 'Nothing is off-limits',
    })
    say({
      role: 'ai',
      text: neverTouch.length
        ? `${neverTouch.length} item${neverTouch.length === 1 ? '' : 's'} locked.`
        : 'Nothing locked — I will still confirm anything risky.',
    })
    askNext('sensitive')
  }

  const toggleSensitive = (w: string) => {
    const cur = sensitiveWords
    setInterview({
      sensitiveWords: cur.includes(w) ? cur.filter((x) => x !== w) : [...cur, w],
    })
  }

  const confirmSensitive = () => {
    say({
      role: 'user',
      text: sensitiveWords.length
        ? `Force local: ${sensitiveWords.join(', ')}`
        : 'No extra sensitive words',
    })
    say({
      role: 'ai',
      text: sensitiveWords.length
        ? `Enforced — any task mentioning ${sensitiveWords.length === 1 ? 'that word' : 'those words'} routes to your local model, never a cloud AI. (The built-in list — passwords, credentials, PII, prod — always applies too.)`
        : 'Just the built-in protections then — passwords, credentials, PII and prod always stay local.',
    })
    askNext('verify')
  }

  const pickVerify = (cmd: string) => {
    setInterview({ verifyCommand: cmd })
    say({ role: 'user', text: cmd || 'No verify command yet' })
    say({
      role: 'ai',
      text: cmd
        ? `Got it — I’ll run “${cmd}” automatically before trusting any work. If it fails, I stop right there and spend no AI tokens.`
        : 'No problem — no auto-check for now. You can add one anytime here or just ask me in chat.',
    })
    askNext('compliance')
  }

  const toggleCompliance = (c: string) => {
    const cur = compliance
    setInterview({
      compliance: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c],
    })
  }

  const confirmCompliance = () => {
    say({
      role: 'user',
      text: compliance.length ? `Compliance: ${compliance.join(', ')}` : 'No formal regimes',
    })
    // Capability check-in: honest classes + sensitivity advice for every
    // connected AI, and how I'll divide work between them.
    const lines: string[] = ['One last thing — my capability check-in for your connected AIs:']
    for (const p of settings.providers.filter((x) => x.enabled)) {
      const tag = p.primary ? ' (primary)' : ''
      if (p.id === 'local') {
        lines.push(`🟢 ${p.name}${tag} — runs on this Mac. SAFE for sensitive data; nothing leaves the machine.`)
      } else if (isCliProvider(p.id)) {
        lines.push(`🟡 ${p.name}${tag} — cloud via your subscription. Strong planning/coding; treat like any cloud AI: business docs fine, raw secrets never.`)
      } else if (isCustomProvider(p.id)) {
        lines.push(`🟡 ${p.name}${tag} — custom endpoint. Check its data policy; treat as cloud.`)
      } else if (p.id === 'gemini') {
        lines.push(`🟡 ${p.name}${tag} — cloud API (free tier may use data to improve). Keep client PII and your never-touch items away from it.`)
      } else {
        lines.push(`🟡 ${p.name}${tag} — cloud API. Fine for business documents; never raw secrets or protected records.`)
      }
    }
    lines.push(
      `How I'll divide work: I (${primaryName}) take planning, drafting and reviews; the local model handles sensitive or bulk work; others give second opinions. Your never-touch list and sensitive keywords route LOCAL automatically — and if a task would push protected data to a cloud AI, I stop and ask you first.`,
    )
    setStage('capability')
    say({ role: 'ai', text: lines.join('\n') })
  }

  const confirmCapability = () => {
    say({ role: 'user', text: 'Looks right' })
    say({
      role: 'ai',
      text: `Perfect — that's everything I need. Your governance draft is on the right; press continue to review and confirm it. These rules ride along on every call I make for you.`,
    })
    setStage('done')
  }

  // ---- typed custom answers (the chat input always works) ---------------

  const submitTyped = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    const low = text.toLowerCase()

    if (stage === 'business') {
      answerBusiness(text)
      return
    }
    if (stage === 'company') {
      if (/private|skip|no website|none/i.test(low) && text.length < 40) {
        skipCompany()
      } else {
        answerCompany(text)
      }
      return
    }
    if (stage === 'research') {
      say({ role: 'user', text })
      say({ role: 'ai', text: 'One moment — finishing the research, then I’ll take that.' })
      return
    }
    if (stage === 'adaptive') {
      const pending = pendingQRef.current
      say({ role: 'user', text })
      if (!pending) {
        say({ role: 'ai', text: 'One moment — thinking of the next question, I’ll take that right after.' })
        return
      }
      pendingQRef.current = null
      // The answer stays local like every other answer, and feeds the next
      // generation's "answers so far".
      setInterview({
        adaptive: [
          ...getInterview().adaptive,
          { q: pending.q, a: text, model: pending.model, local: pending.isLocal },
        ],
      })
      adaptiveTurnsRef.current += 1
      void continueAdaptive()
      return
    }
    if (stage === 'departments') {
      if (/^(none|no departments?|just me)$/i.test(low)) {
        setInterview({ departments: [] })
        confirmDepartments()
        return
      }
      const items = text
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const merged = [...departments]
      for (const item of items) if (!merged.includes(item)) merged.push(item)
      setInterview({ departments: merged })
      say({ role: 'user', text: `Departments: ${items.join(', ')}` })
      say({
        role: 'ai',
        text: `Added — ${merged.length} selected now. Any other department to add? Type it, or confirm with the button.`,
      })
      return
    }
    if (stage === 'team') {
      // Custom exact size is stored verbatim — "12 people", not a bucket.
      const n = parseInt(low.replace(/[^0-9]/g, ''), 10)
      if (/just|solo|only me|myself/.test(low) || n === 1) {
        pickTeam(TEAM_SIZES[0])
        return
      }
      if (Number.isFinite(n) && n > 0) {
        pickTeam(`${n} people`)
        return
      }
      say({ role: 'user', text })
      say({ role: 'ai', text: 'Tap a size, or tell me the exact number (e.g. "12 people").' })
      return
    }
    if (stage === 'budget') {
      // Custom amount: "$3k", "2000", "1.5k a month" → stored as $N/mo.
      const m = low.match(/(\d+(?:[.,]\d+)?)\s*(k\b)?/)
      if (/free|nothing|zero|no budget/.test(low)) {
        pickBudget('$0/mo — free routes only')
        return
      }
      if (m && m[1]) {
        let amt = parseFloat(m[1].replace(',', '.'))
        if (m[2]) amt *= 1000
        if (Number.isFinite(amt) && amt > 0) {
          pickBudget(`$${Math.round(amt).toLocaleString()}/mo`)
          return
        }
      }
      say({ role: 'user', text })
      say({ role: 'ai', text: 'Tap a range, or tell me the amount — e.g. "$100 a month" or "3k".' })
      return
    }
    if (stage === 'sensitive') {
      const items = text
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const merged = [...sensitiveWords]
      for (const item of items) if (!merged.includes(item)) merged.push(item)
      setInterview({ sensitiveWords: merged })
      say({ role: 'user', text: `Force local: ${items.join(', ')}` })
      say({ role: 'ai', text: `Added — ${merged.length} enforced. More words, or confirm.` })
      return
    }
    if (stage === 'verify') {
      pickVerify(text)
      return
    }
    if (stage === 'compliance') {
      const items = text
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const merged = [...compliance]
      for (const item of items) if (!merged.includes(item)) merged.push(item)
      setInterview({ compliance: merged })
      say({ role: 'user', text: `Compliance: ${items.join(', ')}` })
      say({ role: 'ai', text: `Noted — ${merged.length} regime${merged.length === 1 ? '' : 's'}. More, or confirm.` })
      return
    }
    if (stage === 'capability') {
      say({ role: 'user', text })
      say({ role: 'ai', text: 'Noted — providers can be adjusted anytime in Settings. Confirm when ready.' })
      return
    }
    if (stage === 'roles') {
      const matched = ROLE_HATS.filter((r) => low.includes(r.replace('-', ' ')) || low.includes(r))
      if (matched.length === 0) {
        say({ role: 'user', text })
        say({
          role: 'ai',
          text: 'I know these hats: developer, reviewer, admin, data-owner. Tap the chips or name them.',
        })
        return
      }
      setInterview({ roles: matched })
      say({ role: 'user', text: `My hats: ${matched.join(', ')}` })
      say({ role: 'ai', text: `${matched.length} hat${matched.length === 1 ? '' : 's'} — noted.` })
      askNext('priorities')
      return
    }
    if (stage === 'priorities') {
      const first = (['compliance', 'speed', 'cost'] as Priority[]).find((p) => low.includes(p))
      if (!first) {
        say({ role: 'user', text })
        say({ role: 'ai', text: 'Tell me which comes first: compliance, speed, or cost.' })
        return
      }
      pickPriority(first)
      return
    }
    if (stage === 'signoffs') {
      const map: [string, SignoffId][] = [
        ['main', 'push-main'],
        ['push', 'push-main'],
        ['audit', 'delete-audit'],
        ['permission', 'change-perms'],
        ['perms', 'change-perms'],
        ['spend', 'spend'],
        ['$', 'spend'],
        ['money', 'spend'],
      ]
      const matched = [...new Set(map.filter(([k]) => low.includes(k)).map(([, id]) => id))]
      if (matched.length === 0) {
        say({ role: 'user', text })
        say({
          role: 'ai',
          text: 'I can gate: pushing to main, deleting audit history, changing permissions, spending over $5. Tap or name them — or confirm with none.',
        })
        return
      }
      setInterview({ signoffs: matched })
      say({ role: 'user', text: `Gate: ${matched.join(', ')}` })
      askNext('never')
      say({ role: 'ai', text: 'Gates set.' })
      return
    }
    if (stage === 'never') {
      const items = text
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      for (const item of items) addTag(item)
      say({ role: 'user', text: `Add to never-touch: ${items.join(', ')}` })
      say({ role: 'ai', text: 'Added — confirm the list when it looks complete.' })
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitTyped()
    }
  }

  // ---- current question's options ---------------------------------------

  const selectedRoles = ROLE_HATS.filter((r) => roles.includes(r))
  const gateLabels = SIGNOFFS.filter((s) => signoffs.includes(s.id)).map((s) => s.gate)

  const PLACEHOLDERS: Record<Stage, string> = {
    business: 'type what your business does — or tap a category above',
    company: 'e.g. "Northwind Supply — example.com" — or tap skip',
    research: 'researching… you can type, I’ll take it right after',
    adaptive: 'answer in your own words — or switch to the standard questions',
    departments: 'type departments, comma-separated — or tap the chips',
    team: 'e.g. "3 people" — or tap a size',
    budget: 'e.g. "$100 a month" — or tap a range',
    roles: 'e.g. "developer and reviewer" — or tap the chips',
    priorities: 'e.g. "speed first" — or tap one',
    signoffs: 'e.g. "pushing to main and spending" — or tap the chips',
    never: 'add items, comma-separated — e.g. "prod DB, billing"',
    sensitive: 'type words, comma-separated — e.g. "driver PII, client rates"',
    verify: 'type a test command like "npm test" — or tap skip if unsure',
    compliance: 'type a regime — e.g. "ISO 27001" — or tap the chips',
    capability: 'any notes? — or confirm with the button above',
    done: 'all done — press continue below',
  }
  const placeholder = PLACEHOLDERS[stage]

  return (
    <div className="iv">
      <button type="button" className="wizback" onClick={() => navigate('/companion-grants')}>
        ← Back
      </button>
      <div className="wizactions">
        {alreadyDone && (
          <button
            type="button"
            className="wizskip"
            onClick={() => navigate(nextRoute('interview'))}
          >
            Skip — already answered →
          </button>
        )}
        <button
          type="button"
          className="wizclose"
          aria-label="Close setup"
          onClick={() => {
            pause()
            navigate('/')
          }}
        >
          ✕ Close
        </button>
      </div>
      <Stepper active={4} />

      {editMode ? (
        <InterviewEditAll
          onWalkChat={() => setEditMode(false)}
          onDone={() => {
            completeStep('interview')
            navigate(nextRoute('interview'))
          }}
        />
      ) : (
      <div className="iv__split">
        {/* chat column */}
        <div className="iv__chat">
          {msgs.map((m, i) =>
            m.role === 'ai' ? (
              <div key={i} className="iv__ask iv__stage">
                <span className="orb orb--34" />
                <div className="iv__askbubble">
                  {m.text}
                  {/* Honest attribution for a GENERATED question — the real
                      model the Verdict named, 🔒 when it stayed local. No
                      meta → no line (scripted copy renders exactly as before). */}
                  {m.model && (
                    <div className="iv__askedby mono">
                      asked by {m.model}
                      {m.isLocal ? ' · 🔒 local' : ''}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div key={i} className="iv__userrow iv__stage">
                <div className="iv__userbubble">{m.text}</div>
              </div>
            ),
          )}

          {/* options for the CURRENT question */}
          {stage === 'business' && (
            <div className="iv__chips iv__stage">
              {INDUSTRIES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="iv__chip"
                  onClick={() => answerBusiness('', preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          {stage === 'company' && (
            <div className="iv__chips iv__stage">
              <button type="button" className="iv__chip" onClick={skipCompany}>
                It&rsquo;s private — skip →
              </button>
            </div>
          )}

          {stage === 'research' && researching && (
            <div className="iv__ask iv__stage">
              <span className="orb orb--34 orb--shimmer" />
              <div className="iv__askbubble mono">
                {primaryName} is researching… (15–60s — real call on your plan)
              </div>
            </div>
          )}

          {stage === 'adaptive' && (
            <div className="iv__stage">
              {generating && (
                <div className="iv__ask">
                  <span className="orb orb--34 orb--shimmer" />
                  <div className="iv__askbubble mono">
                    {primaryName} is thinking of the next question… (real call on your plan)
                  </div>
                </div>
              )}
              <div className="iv__chips">
                <button type="button" className="iv__chip" onClick={skipAdaptive}>
                  Switch to the standard questions →
                </button>
              </div>
            </div>
          )}

          {stage === 'departments' && (
            <div className="iv__stage">
              <div className="iv__chips">
                {[...new Set([...DEPARTMENTS, ...departments])].map((d) => {
                  const on = departments.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      className={'iv__chip' + (on ? ' iv__chip--on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleDepartment(d)}
                    >
                      {on ? '✓ ' : ''}
                      {d}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="iv__chip"
                  onClick={() =>
                    promptCustom('Type the department name(s) below, comma-separated — I’ll add them.')
                  }
                >
                  ✏️ add another…
                </button>
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmDepartments}>
                  {departments.length === 0
                    ? 'No separate departments →'
                    : `That's the org (${departments.length} selected) →`}
                </button>
              </div>
              <div className="iv__count mono">
                {departments.length} department{departments.length === 1 ? '' : 's'} selected —
                any other to add? Type it below, or confirm.
              </div>
            </div>
          )}

          {stage === 'team' && (
            <div className="iv__chips iv__stage">
              {TEAM_SIZES.map((t) => (
                <button key={t} type="button" className="iv__chip" onClick={() => pickTeam(t)}>
                  {t}
                </button>
              ))}
              <button
                type="button"
                className="iv__chip"
                onClick={() => promptCustom('Type the exact team size below — e.g. "12 people".')}
              >
                ✏️ custom number…
              </button>
            </div>
          )}

          {stage === 'budget' && (
            <div className="iv__chips iv__stage">
              {BUDGETS.map((b) => (
                <button key={b} type="button" className="iv__chip" onClick={() => pickBudget(b)}>
                  {b}
                </button>
              ))}
              <button
                type="button"
                className="iv__chip"
                onClick={() =>
                  promptCustom('Type the monthly amount below — e.g. "$500", "3k", or "free only".')
                }
              >
                ✏️ custom amount…
              </button>
            </div>
          )}

          {stage === 'sensitive' && (
            <div className="iv__stage">
              <div className="iv__chips">
                {[...new Set([...SENSITIVE_SUGGESTIONS, ...sensitiveWords])].map((w) => {
                  const on = sensitiveWords.includes(w)
                  return (
                    <button
                      key={w}
                      type="button"
                      className={'iv__chip' + (on ? ' iv__chip--on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleSensitive(w)}
                    >
                      {on ? '✓ ' : ''}
                      {w}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="iv__chip"
                  onClick={() => promptCustom('Type the words below, comma-separated — each becomes a force-local rule.')}
                >
                  ✏️ add my own…
                </button>
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmSensitive}>
                  {sensitiveWords.length === 0
                    ? 'Built-in protection only →'
                    : `Enforce these (${sensitiveWords.length}) →`}
                </button>
              </div>
            </div>
          )}

          {stage === 'verify' && (
            <div className="iv__chips iv__stage">
              {VERIFY_SUGGESTIONS.map((cmd) => (
                <button key={cmd} type="button" className="iv__chip mono" onClick={() => pickVerify(cmd)}>
                  {cmd}
                </button>
              ))}
              <button
                type="button"
                className="iv__chip"
                onClick={() => promptCustom('Type your exact command below — e.g. "./verify.sh" or "npm run test:ci".')}
              >
                ✏️ my own command…
              </button>
              <button type="button" className="iv__chip" onClick={() => pickVerify('')}>
                skip — none yet
              </button>
            </div>
          )}

          {stage === 'compliance' && (
            <div className="iv__stage">
              <div className="iv__chips">
                {[...new Set([...COMPLIANCE_OPTIONS, ...compliance])].map((c) => {
                  const on = compliance.includes(c)
                  return (
                    <button
                      key={c}
                      type="button"
                      className={'iv__chip' + (on ? ' iv__chip--on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleCompliance(c)}
                    >
                      {on ? '✓ ' : ''}
                      {c}
                    </button>
                  )
                })}
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmCompliance}>
                  {compliance.length === 0 ? 'None apply →' : `Those apply (${compliance.length}) →`}
                </button>
              </div>
            </div>
          )}

          {stage === 'capability' && (
            <div className="iv__chips iv__stage">
              <button type="button" className="iv__chip iv__chip--go" onClick={confirmCapability}>
                Looks right →
              </button>
            </div>
          )}

          {stage === 'roles' && (
            <div className="iv__stage">
              <div className="iv__chips">
                {ROLE_HATS.map((role) => {
                  const on = roles.includes(role)
                  return (
                    <button
                      key={role}
                      type="button"
                      className={'iv__chip' + (on ? ' iv__chip--on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleRole(role)}
                    >
                      {on ? '✓ ' : ''}
                      {role}
                    </button>
                  )
                })}
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmRoles}>
                  That&rsquo;s all my hats →
                </button>
              </div>
            </div>
          )}

          {stage === 'priorities' && (
            <div className="iv__chips iv__stage">
              {(['compliance', 'speed', 'cost'] as Priority[]).map((p) => (
                <button key={p} type="button" className="iv__chip" onClick={() => pickPriority(p)}>
                  {PRIORITY_LABEL[p]} first
                </button>
              ))}
            </div>
          )}

          {stage === 'signoffs' && (
            <div className="iv__stage">
              <div className="iv__chips">
                {SIGNOFFS.map((s) => {
                  const on = signoffs.includes(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={'iv__chip' + (on ? ' iv__chip--on' : '')}
                      aria-pressed={on}
                      onClick={() => toggleSignoff(s.id)}
                    >
                      {on ? '✓ ' : ''}
                      {s.label}
                    </button>
                  )
                })}
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmSignoffs}>
                  Those are my gates →
                </button>
              </div>
            </div>
          )}

          {stage === 'never' && (
            <div className="iv__stage">
              <div className="iv__tags">
                {neverTouch.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="iv__tag mono"
                    aria-label={`Remove ${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    {tag} &times;
                  </button>
                ))}
                <button type="button" className="iv__chip iv__chip--go" onClick={confirmNever}>
                  List is complete →
                </button>
              </div>
            </div>
          )}

          {stage === 'done' && (
            <div className="iv__cta iv__stage">
              <Link
                to={nextRoute('interview')}
                className="btn-gold"
                onClick={() => completeStep('interview')}
              >
                Continue to review &rarr;
              </Link>
            </div>
          )}

          {/* chat input — always available for a custom answer */}
          <div className="iv__inputbar">
            <input
              ref={inputRef}
              className="iv__input"
              value={input}
              placeholder={placeholder}
              aria-label="Type your answer"
              disabled={stage === 'done'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
            />
            <button
              type="button"
              className="iv__sendbtn"
              aria-label="Send"
              disabled={stage === 'done' || !input.trim()}
              onClick={submitTyped}
            >
              ↑
            </button>
          </div>
          <div className="iv__pad" ref={endRef} />
        </div>

        {/* drafting rail — reflects the actual selections */}
        <aside className="iv__rail">
          <div className="iv__railcard">
            <div className="iv__railhead">
              <span className="iv__raildot" />
              <span className="iv__railkicker">Drafting from your answers&hellip;</span>
            </div>
            <div className="iv__railrows mono">
              <RailRow label="Business">
                {business ? (
                  business.length > 60 ? business.slice(0, 60) + '…' : business
                ) : (
                  <span className="iv__raildim">not answered yet</span>
                )}
              </RailRow>
              <RailRow label="Company">
                {companyName || website ? (
                  `${companyName}${website ? ` · ${website}` : ''}`
                ) : (
                  <span className="iv__raildim">private / not given</span>
                )}
              </RailRow>
              <RailRow label={`Departments · ${departments.length}`}>
                {departments.length ? (
                  departments.join(' · ')
                ) : (
                  <span className="iv__raildim">none yet</span>
                )}
              </RailRow>
              <RailRow label="Team · Budget">
                {teamSize || budget ? (
                  `${teamSize || '—'} · ${budget || '—'}`
                ) : (
                  <span className="iv__raildim">not answered yet</span>
                )}
              </RailRow>
              <RailRow label={`Roles · ${selectedRoles.length}`}>
                {selectedRoles.length ? (
                  selectedRoles.join(' · ')
                ) : (
                  <span className="iv__raildim">none selected yet</span>
                )}
              </RailRow>
              <RailRow label={`Never-touch · ${neverTouch.length}`}>
                {neverTouch.length ? (
                  neverTouch.join(' · ')
                ) : (
                  <span className="iv__raildim">nothing off-limits yet</span>
                )}
              </RailRow>
              <RailRow label={`Gates · ${gateLabels.length}`}>
                {gateLabels.length ? (
                  gateLabels.join(' · ')
                ) : (
                  <span className="iv__raildim">no sign-off gates</span>
                )}
              </RailRow>
              <RailRow label={`Force-local · ${sensitiveWords.length}`}>
                {sensitiveWords.length ? (
                  sensitiveWords.join(' · ')
                ) : (
                  <span className="iv__raildim">built-in list only</span>
                )}
              </RailRow>
              <RailRow label="Verify · Compliance">
                {verifyCommand || compliance.length ? (
                  `${verifyCommand || '—'} · ${compliance.join(', ') || '—'}`
                ) : (
                  <span className="iv__raildim">not set yet</span>
                )}
              </RailRow>
              <div className="iv__railrow iv__railrow--gold">
                <div className="iv__raillabel iv__raillabel--gold">Routing</div>
                <div className="iv__railval iv__railval--gold">
                  {PRIORITY_LABEL[priorities[0]]}-first{' '}
                  <span className="iv__raildim--gold">
                    &middot; then {priorities.slice(1).map((p) => PRIORITY_LABEL[p].toLowerCase()).join(', ')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
      )}

      {/* progress toast (chat mode only) */}
      {!editMode && (
        <div className="iv__thinking">
          <div className="iv__thinkpill">
            {stage === 'done' ? 'governance drafted — review next' : 'drafting your governance…'}
          </div>
          <span className="orb orb--48 orb--shimmer" />
        </div>
      )}
    </div>
  )
}

function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="iv__railrow">
      <div className="iv__raillabel">{label}</div>
      <div className="iv__railval">{children}</div>
    </div>
  )
}
