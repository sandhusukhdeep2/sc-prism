import { useEffect, useMemo, useRef, useState } from 'react'
import './Skills.css'
import {
  create as createSkill,
  persistSkillToVault,
  remove as removeSkill,
  removeSkillFromVault,
  syncVaultSkills,
  update as updateSkill,
  useSkills,
  type Provenance,
  type StoredSkill,
} from '../lib/skills'
import { recentFailures, skillStats, type SkillStat } from '../lib/skillStats'
import { useSettings, type Settings } from '../lib/settings'
import { useApp, buildEngineProviders, isRealCompletion } from '../store/AppStore'
import { isNative, resolveVaultDir, runNativeTask } from '../lib/nativeEngine'
import type { Verdict } from '../engine/types'
import Icon from '../components/Icon'
import PageHead from '../components/PageHead'
import { proposeSkills, type SkillProposal } from '../lib/skillProposals'
import {
  approveToolScope,
  readGeneratedTools,
  toolState,
  type ToolRow,
} from '../lib/generatedTools'

// Skills library — SKILL.md cards with provenance + portability, and a dark detail
// drawer showing the raw SKILL.md. All state is live from the localStorage-backed
// skills store: create, delete, select, and search are functional.

const PROV_CLASS: Record<Provenance, string> = {
  captured: 'captured',
  'hand-written': 'hand',
  imported: 'imported',
  vault: 'vault',
}

const PROV_TEXT: Record<Provenance, string> = {
  captured: 'captured',
  'hand-written': 'hand-written',
  imported: 'imported',
  vault: 'vault',
}

// Deterministic icon tint per skill name, so a card keeps a stable colour.
const ICONS: readonly { bg: string; color: string }[] = [
  { bg: 'rgba(55, 224, 216, 0.15)', color: '#0f7d78' },
  { bg: 'rgba(206, 105, 105, 0.15)', color: '#5f6570' },
  { bg: 'rgba(61, 165, 255, 0.14)', color: '#1258c4' },
  { bg: 'rgba(91, 224, 138, 0.15)', color: '#1f8a4d' },
  { bg: 'rgba(167, 139, 255, 0.16)', color: '#6b46c1' },
  { bg: 'rgba(255, 95, 162, 0.15)', color: '#b03060' },
]

function iconFor(name: string): { bg: string; color: string } {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ICONS[(h >>> 0) % ICONS.length]
}

function portableText(s: StoredSkill): string {
  return s.portable ? 'portable markdown — usable by any agent runtime' : 'this workbench only'
}

// Per-role skill chips (P3-3): a skill's `roles` (parsed from its vault
// frontmatter's `roles:`/`agents:` key — engine role-board disclosure scopes
// on exactly this) show as small chips. No roles ⇒ ONE "global" chip — the
// honest default for every skill created before this feature and for any
// skill whose frontmatter never set `roles:` at all.
function RoleChips({ roles }: { roles?: string[] }) {
  if (!roles || roles.length === 0) {
    return <span className="role-chip role-chip--global">global</span>
  }
  return (
    <>
      {roles.map((r) => (
        <span key={r} className="role-chip" title={`scoped to the ${r} role`}>
          {r}
        </span>
      ))}
    </>
  )
}

// Compact relative time from an ISO timestamp (mirrors Agents.tsx's `ago`
// helper, just fed an ISO string instead of an epoch ms number since that's
// the shape `verdict.at` / `SkillStat.lastUsedAt` carry).
function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / (60 * 24))}d ago`
}

// The stats line shared by the card and the drawer. It NAMES WHAT IT COUNTS:
// the percentage is of the DECIDED runs (passed or failed), and the attention
// runs — deterministic checks green, reviewer dissented — are stated on their
// own instead of silently dragging the rate down as though they were failures.
// The "last" fragment is omitted when the skill has never fired a disclosed run
// this session (`lastUsedAt === ''`). Callers hide the whole line at 0 uses (a
// stat with 0 uses has nothing worth showing).
function statsLine(stat: SkillStat): string {
  const last = stat.lastUsedAt ? ` · last ${timeAgo(stat.lastUsedAt)}` : ''
  const attention = stat.attention > 0 ? ` · ${stat.attention} needed a look (not counted)` : ''
  const rate =
    stat.decided === 0
      ? 'no decided runs'
      : `${Math.round(stat.passRate * 100)}% pass of ${stat.decided} decided`
  return `${stat.uses} uses · ${rate}${attention}${last}`
}

export default function Skills() {
  const skills = useSkills()
  const { settings } = useSettings()
  const { state } = useApp()
  const [query, setQuery] = useState('')

  // ADR-020: SKILL.md files dropped in the vault (skills/*.md) auto-join the
  // library on page load; deleting the file removes the skill again.
  useEffect(() => {
    void syncVaultSkills(settings.vaultPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<SkillProposal | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])

  // GENERATED TOOLS — the other half of what the crew can do. The four gates
  // are enforced in the engine; this is where their state becomes visible,
  // because a gate you cannot observe is one you have to take on faith.
  const [tools, setTools] = useState<ToolRow[]>([])
  useEffect(() => {
    void readGeneratedTools(settings.vaultPath).then(setTools)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deterministic: real repetition in the recorded runs. The app notices; the
  // user writes. Nothing is created without them.
  const proposals = useMemo(
    () =>
      proposeSkills(
        state.verdicts.map((v) => ({ task: v.task, passed: v.passed })),
        { existing: skills.map((s) => s.name), dismissed },
      ),
    [state.verdicts, skills, dismissed],
  )

  // Real per-skill performance, derived from the verdict history's honest
  // `native.disclosed` attribution (S3's pure aggregator) — recomputed only
  // when the verdict log or the skill list changes. The session verdict log is
  // the whole real history available in-app (the loop-run stream it used to be
  // merged with came from the deleted simulator).
  const verdicts = state.verdicts
  const stats = useMemo(() => skillStats(verdicts, skills), [verdicts, skills])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      skills.filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.whenToUse.toLowerCase().includes(q) ||
          s.agents.some((a) => a.toLowerCase().includes(q)),
      ),
    [skills, q],
  )

  // Resolve the selected skill: explicit selection, else the first visible card.
  const selected =
    skills.find((s) => s.id === selectedId) ?? filtered[0] ?? skills[0] ?? null

  const del = (s: StoredSkill) => {
    if (selectedId === s.id) setSelectedId(null)
    removeSkill(s.id)
    // Vault write-through: fire-and-forget, native-gated inside — no-op in
    // the browser and never blocks the (already-committed) local removal.
    // The whole skill goes through (not just the name) so the delete targets
    // the file it was actually discovered from (`sourcePath`) when set.
    void removeSkillFromVault(s, settings.vaultPath)
  }

  return (
    <div className="skills">
      {/* This page had NO title at all — it opened straight into a toolbar,
          which is the most literal form of "the pages don't feel connected":
          every other page in the app announces itself and this one did not. */}
      <PageHead
        title="Skill"
        em="library"
        hint={`${skills.length} skill${skills.length === 1 ? '' : 's'} · read from your vault`}
        actions={
          <>
            <span className="skills__search">
              {/* Was a hand-rolled SVG; it takes currentColor from the set now
                  and matches the one in the Vault's filter exactly. */}
              <Icon name="search" size={13} />
              <input
                className="skills__searchinput"
                placeholder="Search skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <button type="button" className="skills__new" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
              New skill
            </button>
          </>
        }
      />

      {/* SKILLS PROPOSED FROM WORK YOU HAVE ACTUALLY REPEATED.
          `provenance: 'captured'` — "captured from a repeated workflow" — was a
          LABEL with nothing behind it since the store was written. The noticing
          is deterministic (real repetition in the recorded runs, not a model's
          opinion) and the writing stays human: the benchmark evidence is that
          self-generated skills give negligible or negative gains while
          human-curated ones carry the whole improvement. */}
      {/* Generated tools: what the crew built for this business, and which
          gate each one is waiting on. Shown even when empty, so someone
          looking for the feature finds it rather than concluding it is
          missing. */}
      <div className="skills__tools">
        <div className="skills__toolshead">
          <span className="skills__propkicker mono">TOOLS YOUR CREW BUILT</span>
          <span className="settings__spacer" />
          <span className="skills__toolscount mono">
            {tools.length === 0 ? 'none yet' : `${tools.length}`}
          </span>
        </div>
        {tools.length === 0 ? (
          <div className="skills__toolsempty">
            When a job needs a tool SC Prism does not ship — reading your
            supplier&rsquo;s invoice format, say — the manager says so instead of
            guessing, and asks for a few real examples. Anything it builds appears
            here, and cannot run until you approve what it may touch.
          </div>
        ) : (
          tools.map((t) => {
            const st = toolState(t)
            return (
              <div className={'skills__tool skills__tool--' + st.id} key={t.name}>
                <div className="skills__toolrow">
                  <span className="skills__toolname mono">{t.name}</span>
                  {st.pinnedLocal && (
                    <span className="skills__toolpin mono" title="Confidential — runs on this machine only">
                      local only
                    </span>
                  )}
                  <span className="settings__spacer" />
                  <span className="skills__toolstate">{st.label}</span>
                </div>
                <div className="skills__tooldesc">{t.description}</div>
                <div className="skills__tooldetail">{st.detail}</div>
                {/* GATE 1 is the user's decision, so it gets a button. GATE 4
                    is the engine's — it needs a passing sandbox run — so no
                    button is offered for it. A control the user cannot
                    honestly press is worse than none. */}
                {st.canApproveScope && (
                  <button
                    type="button"
                    className="skills__propbtn skills__toolbtn"
                    onClick={() => {
                      void approveToolScope(t, 'user', settings.vaultPath).then((ok) => {
                        if (ok) void readGeneratedTools(settings.vaultPath).then(setTools)
                      })
                    }}
                  >
                    Approve this scope
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>

      {proposals.length > 0 && (
        <div className="skills__proposals">
          {proposals.map((p) => (
            <div className="skills__proposal" key={p.signature}>
              <div className="skills__proprow">
                <span className="skills__propkicker mono">REPEATED WORK</span>
                <span className="skills__proptimes mono">{p.timesSeen} times</span>
                <span className="settings__spacer" />
                <button
                  type="button"
                  className="skills__propbtn"
                  onClick={() => {
                    setDraft(p)
                    setAdding(true)
                  }}
                >
                  Write a skill for this
                </button>
                <button
                  type="button"
                  className="skills__propbtn skills__propbtn--quiet"
                  onClick={() => setDismissed((d) => [...d, p.signature])}
                >
                  Not useful
                </button>
              </div>
              <div className="skills__propname">{p.name}</div>
              {/* The evidence, quoted. A proposal without it is a guess
                  wearing a suggestion's clothes. */}
              <ul className="skills__propex">
                {p.examples.map((ex, i) => (
                  <li key={i}>{ex}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}


      <div className="skills__main">
        <div className="skills__cards">
          {adding && (
            <NewSkillForm
              key={draft?.signature ?? 'blank'}
              draft={draft}
              onCancel={() => {
                setAdding(false)
                setDraft(null)
              }}
              onCreate={(input) => {
                const s = createSkill(input)
                setSelectedId(s.id)
                setAdding(false)
                setDraft(null)
                void persistSkillToVault(s, settings.vaultPath)
              }}
            />
          )}
          {filtered.map((s) => (
            <SkillCard
              key={s.id}
              s={s}
              stat={stats.get(s.id)}
              selected={selected?.id === s.id}
              onSelect={() => setSelectedId(s.id)}
              onDelete={() => del(s)}
            />
          ))}
          {filtered.length === 0 && !adding && (
            <div className="skills__empty">No skills match “{query}”.</div>
          )}
        </div>

        <SkillDrawer
          skill={selected}
          stat={selected ? stats.get(selected.id) : undefined}
          verdicts={verdicts}
          settings={settings}
          onDelete={selected ? () => del(selected) : undefined}
        />
      </div>

    </div>
  )
}

function SkillCard({
  s,
  stat,
  selected,
  onSelect,
  onDelete,
}: {
  s: StoredSkill
  stat?: SkillStat
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const icon = iconFor(s.name)
  // Two-step delete confirm (durable removal, no undo) — the ✕ arms it, then an
  // explicit confirm/cancel appears in its place. Nothing is erased on one click.
  const [confirming, setConfirming] = useState(false)
  return (
    <div
      className={'skill-card' + (selected ? ' skill-card--sel' : '')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {confirming ? (
        <div className="skill-card__confirm" onClick={(e) => e.stopPropagation()}>
          <span className="skill-card__confirmq">Delete “{s.name}”?</span>
          <button
            type="button"
            className="skill-card__confirmyes"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            aria-label={`Confirm delete ${s.name}`}
          >
            confirm
          </button>
          <button
            type="button"
            className="skill-card__confirmno"
            onClick={(e) => {
              e.stopPropagation()
              setConfirming(false)
            }}
            aria-label={`Cancel deleting ${s.name}`}
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="skill-card__del"
          onClick={(e) => {
            e.stopPropagation()
            setConfirming(true)
          }}
          aria-label={`Delete ${s.name}`}
        >
          ✕
        </button>
      )}
      <div className="skill-card__head">
        <span className="skill-card__icon" style={{ background: icon.bg, color: icon.color }}>
          ◆
        </span>
        <div>
          <div className="skill-card__name">{s.name}</div>
          <div className="skill-card__sub">{s.description}</div>
          {stat && stat.uses > 0 && <div className="skill-card__stats">{statsLine(stat)}</div>}
        </div>
      </div>
      <div className="skill-card__when">
        <b>when:</b> {s.whenToUse}
      </div>
      <div className="skill-card__prov">
        <span className={`prov prov--${PROV_CLASS[s.provenance]}`}>
          {PROV_TEXT[s.provenance]}
        </span>
        <span className="portable">{portableText(s)}</span>
        {stat?.underperforming && <span className="chip-warn">underperforming</span>}
        <RoleChips roles={s.roles} />
      </div>
      <div className="skill-card__foot">
        {s.agents.map((a) => (
          <span key={a} className="skill-card__agent">
            {a}
          </span>
        ))}
      </div>
    </div>
  )
}

// Models sometimes wrap the improved body in a markdown code fence despite
// the prompt's "ONLY the body" instruction. Unwrap a single whole-response
// fence (optional language tag) so the fence never ends up inside SKILL.md;
// inner content is kept verbatim. Anything not fully fence-wrapped passes
// through untouched.
export function stripCodeFence(text: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(text.trim())
  return fenced ? fenced[1] : text
}

// Build the exact improve-prompt the brief specifies: the current body plus
// the skill's real failed runs, asking for a replacement body only (no
// frontmatter — the page re-serializes that from the existing skill fields).
function improvePrompt(skill: StoredSkill, failures: { task: string }[]): string {
  return `You maintain a skill library. Improve this SKILL.md procedure based on real failed runs.

SKILL: ${skill.name}
CURRENT BODY:
${skill.body}

FAILED RUNS:
${failures.map((f) => `- ${f.task}`).join('\n')}

Reply with ONLY the improved SKILL.md body (markdown, no frontmatter).`
}

function SkillDrawer({
  skill,
  stat,
  verdicts,
  settings,
  onDelete,
}: {
  skill: StoredSkill | null
  stat?: SkillStat
  verdicts: Verdict[]
  settings: Settings
  onDelete?: () => void
}) {
  // Improve-flow state lives here (keyed implicitly to the selected skill via
  // the reset effect below) — hooks must run unconditionally on every render,
  // so they sit above the `!skill` early return.
  const [improving, setImproving] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [improveError, setImproveError] = useState<string | null>(null)
  // Two-step delete confirm (mirrors the card's ✕) — the durable removal only
  // fires after an explicit confirm; switching skills resets it below.
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(() => {
    setImproving(false)
    setDraft(null)
    setImproveError(null)
    setConfirmDel(false)
  }, [skill?.id])

  // The improve flow races a 90s timeout, so the user is free to select a
  // different skill (this same component instance, new props) before it
  // settles. `selectedIdRef` (kept fresh every render, mirroring AppStore's
  // `settingsRef` pattern) lets the async continuation notice its answer has
  // gone stale and drop it — never paint skill A's AI draft onto skill B's
  // drawer.
  const selectedIdRef = useRef(skill?.id)
  selectedIdRef.current = skill?.id

  if (!skill) {
    return (
      <div className="sk-drawer">
        <div className="sk-drawer__head">
          <span className="sk-drawer__kicker">SKILL.md</span>
        </div>
        <div className="sk-drawer__body">
          <div className="c-mut">No skill selected — add one, then select it to see its SKILL.md.</div>
        </div>
      </div>
    )
  }

  const portableList = skill.portable
    ? '[claude-code, codex, cursor, gemini-cli]'
    : '[this-runtime]'

  const improve = async () => {
    if (!isNative()) {
      setImproveError('Improving skills needs the installed app.')
      return
    }
    const { providers, primaryReal } = buildEngineProviders(settings)
    if (!primaryReal) {
      setImproveError('No primary AI is connected yet — connect a real provider first.')
      return
    }
    const targetId = skill.id
    setImproving(true)
    setImproveError(null)
    try {
      const failures = recentFailures(verdicts, skill.name)
      const prompt = improvePrompt(skill, failures)
      const vault = await resolveVaultDir(settings.vaultPath)
      const verdict = await Promise.race([
        runNativeTask(prompt, vault, providers),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
      ])
      // The user may have selected a different skill while this was in
      // flight — this component instance's state now belongs to that skill,
      // so a late answer for `targetId` must be dropped, not misattributed.
      if (selectedIdRef.current !== targetId) return
      if (verdict && isRealCompletion(verdict.response)) {
        setDraft(stripCodeFence(verdict.response))
      } else {
        setImproveError('The AI did not return a usable draft — try again.')
      }
    } catch {
      if (selectedIdRef.current === targetId) {
        setImproveError('Something went wrong drafting the improvement — try again.')
      }
    } finally {
      if (selectedIdRef.current === targetId) setImproving(false)
    }
  }

  const applyDraft = () => {
    if (draft === null) return
    updateSkill(skill.id, { body: draft })
    void persistSkillToVault({ ...skill, body: draft }, settings.vaultPath)
    setDraft(null)
  }

  const discardDraft = () => {
    setDraft(null)
    setImproveError(null)
  }

  return (
    <div className="sk-drawer">
      <div className="sk-drawer__head">
        <span className="sk-drawer__kicker">SKILL.md · {skill.name}</span>
        {stat?.underperforming && <span className="sk-drawer__warnchip">underperforming</span>}
        <span className="sk-drawer__spacer" />
        {onDelete &&
          (confirmDel ? (
            <span className="sk-drawer__confirm">
              <span className="sk-drawer__confirmq">Delete “{skill.name}”?</span>
              <button type="button" className="sk-drawer__confirmyes" onClick={onDelete}>
                confirm
              </button>
              <button
                type="button"
                className="sk-drawer__confirmno"
                onClick={() => setConfirmDel(false)}
              >
                cancel
              </button>
            </span>
          ) : (
            <button type="button" className="sk-drawer__del" onClick={() => setConfirmDel(true)}>
              Delete
            </button>
          ))}
      </div>
      <div className="sk-drawer__body">
        <div className="c-mut">---</div>
        <div className="c-key">
          name: <span className="c-teal">{skill.name}</span>
        </div>
        <div className="c-key">
          description: <span className="c-val">{skill.description}</span>
        </div>
        <div className="c-key">
          when-to-use: <span className="c-val">{skill.whenToUse}</span>
        </div>
        <div className="c-key">
          provenance: <span className="c-green">{PROV_TEXT[skill.provenance]}</span>
        </div>
        <div className="c-key">
          portable: <span className="c-val">{portableList}</span>
        </div>
        {skill.agents.length > 0 && (
          <div className="c-key">
            agents: <span className="c-val">[{skill.agents.join(', ')}]</span>
          </div>
        )}
        <div className="c-key">
          roles:{' '}
          <span className="c-val">
            {skill.roles && skill.roles.length > 0 ? `[${skill.roles.join(', ')}]` : 'global'}
          </span>
        </div>
        <div className="c-mut">---</div>
        {skill.body.split('\n').map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('#') ? 'c-gold ln--mt' : line.trim() === '' ? 'c-mut' : 'c-val'
            }
          >
            {line || ' '}
          </div>
        ))}

        {stat && stat.uses > 0 && (
          <>
            <div className="c-mut ln--mt">---</div>
            <div className="c-key">
              stats: <span className="c-val">{statsLine(stat)}</span>
            </div>
            {stat.recent.length > 0 && (
              <div className="sk-drawer__recent">
                <div className="sk-drawer__recent-title">Recent runs</div>
                {stat.recent.map((r) => (
                  <div key={r.taskId} className="sk-drawer__recent-row">
                    {/* Three dots, not two: an attention run is neither the
                        green pass nor the red failure it used to share a dot
                        with. */}
                    <span
                      className={`sk-dot ${
                        r.outcome === 'attention'
                          ? 'sk-dot--attention'
                          : r.passed
                            ? 'sk-dot--ok'
                            : 'sk-dot--err'
                      }`}
                    />
                    <span className="sk-drawer__recent-task">
                      {r.task.slice(0, 80)}
                      {r.outcome === 'attention' && (
                        <span className="sk-drawer__recent-note"> · needed a look</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {stat?.underperforming && (
          <div className="sk-drawer__improve">
            {draft === null ? (
              <>
                <button
                  type="button"
                  className="sk-drawer__improve-btn"
                  disabled={improving}
                  onClick={() => {
                    void improve()
                  }}
                >
                  {improving ? 'Drafting…' : 'Draft improvement with AI'}
                </button>
                {improveError && <div className="sk-drawer__improve-error">{improveError}</div>}
              </>
            ) : (
              <div className="sk-drawer__draftbox">
                <div className="sk-drawer__draftlabel">Improved draft — not saved yet</div>
                <pre className="sk-drawer__draft">{draft}</pre>
                <div className="sk-drawer__draftactions">
                  <button type="button" className="sk-drawer__apply" onClick={applyDraft}>
                    Apply
                  </button>
                  <button type="button" className="sk-drawer__discard" onClick={discardDraft}>
                    Discard
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="sk-drawer__foot">
        {skill.portable
          ? 'runs in Claude Code · Codex · Cursor · Gemini CLI — cross-agent SKILL.md standard'
          : 'runs in this runtime only'}
      </div>
    </div>
  )
}

function NewSkillForm({
  onCreate,
  onCancel,
  draft,
}: {
  onCreate: (input: {
    name: string
    description: string
    whenToUse: string
    provenance: Provenance
  }) => void
  onCancel: () => void
  /** A proposal from repeated work. Pre-fills the form and marks the result
   *  `captured` — which is what that provenance meant all along. */
  draft?: { name: string; timesSeen: number } | null
}) {
  const [name, setName] = useState(draft?.name ?? '')
  const [description, setDescription] = useState(
    draft ? `A procedure for work you have done ${draft.timesSeen} times.` : '',
  )
  const [whenToUse, setWhenToUse] = useState(draft?.name ?? '')
  const [provenance, setProvenance] = useState<Provenance>(
    draft ? 'captured' : 'hand-written',
  )

  const submit = () => {
    if (!name.trim()) return
    onCreate({ name, description, whenToUse, provenance })
  }

  return (
    <form
      className="skill-card skill-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="skill-card__name">New skill</div>
      <input
        className="skill-form__input"
        placeholder="name (e.g. secret-scan)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        className="skill-form__input"
        placeholder="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input
        className="skill-form__input"
        placeholder="when to use"
        value={whenToUse}
        onChange={(e) => setWhenToUse(e.target.value)}
      />
      <select
        className="skill-form__input"
        value={provenance}
        onChange={(e) => setProvenance(e.target.value as Provenance)}
        aria-label="Provenance"
      >
        <option value="hand-written">hand-written</option>
        <option value="captured">captured</option>
        <option value="imported">imported</option>
      </select>
      <div className="skill-form__actions">
        <button type="submit" className="skill-form__btn skill-form__btn--dark" disabled={!name.trim()}>
          Create skill
        </button>
        <button type="button" className="skill-form__btn skill-form__btn--soft" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
