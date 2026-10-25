// SC Prism — skills store.
//
// A localStorage-backed library of SKILL.md-style skills, mirroring the
// vault/agents store pattern (synchronous in-memory `state` as the source of
// truth; every mutation replaces `state`, persists, and notifies subscribers).
//
// Each skill carries its provenance (captured from a task, hand-written, or
// imported), the agents that use it, a portability flag, and a markdown
// `body` — the procedure shown in the detail drawer.

import { useSyncExternalStore } from 'react'
import {
  deleteVaultFile,
  isNative,
  listVaultTree,
  readVaultFile,
  resolveVaultDir,
  writeVaultNote,
} from './nativeEngine'

const KEY = 'scprism.skills'

/** Where a skill came from. `vault` = auto-discovered SKILL.md (ADR-020). */
export type Provenance = 'captured' | 'hand-written' | 'imported' | 'vault'

/** A stored skill. */
export interface StoredSkill {
  id: string
  name: string
  description: string
  whenToUse: string
  provenance: Provenance
  agents: string[]
  portable: boolean
  body: string // SKILL.md procedure (markdown)
  usage: string // human-readable "last used", e.g. 'just now'
  // Vault-relative path of the file this skill was discovered from
  // (`syncVaultSkills` records it). Vault skills can live at ANY
  // `skills/*.md` filename or a nested `**/SKILL.md` — not just the
  // canonical name-slug path — so delete/persist must target THIS path when
  // present, or a deleted skill's real file survives and silently resurrects
  // it on the next sync. Optional for back-compat: pre-existing persisted
  // arrays (and locally-created skills) simply don't have it.
  sourcePath?: string
  // Role scoping (P3-1 engine / P3-3 client), from a vault file's `roles:`/
  // `agents:` frontmatter (parsed by `parseVaultSkill`) — the same role
  // names the engine's role board disclosure filters on. Absent/undefined =
  // GLOBAL (discloses to every role), exactly like a pre-P3-3 skill —
  // optional so every existing persisted skill stays byte-identical.
  roles?: string[]
}

/** The subset a caller supplies when creating a skill. */
export interface NewSkillInput {
  name: string
  description: string
  whenToUse: string
  provenance?: Provenance
  agents?: string[]
  portable?: boolean
  body?: string
  // See `StoredSkill.roles` — parsed from vault frontmatter by
  // `parseVaultSkill`; undefined/absent = global.
  roles?: string[]
}

/** The editable subset. */
export type SkillPatch = Partial<Omit<StoredSkill, 'id'>>

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const SEED: StoredSkill[] = [
  {
    id: 'skill-seed-goldens',
    name: 'seed-goldens',
    description: 'seeds golden tests for a new module',
    whenToUse: 'a module gains its first public function',
    provenance: 'captured',
    agents: ['test-writer'],
    portable: true,
    usage: '',
    body: `# Procedure

1. Read the module's public surface; list each exported fn.
2. For each fn, write one happy-path golden + one edge case.
3. Name tests golden_<fn>_<case>; snapshot outputs.
4. Run Tier-1; only keep deterministic assertions.
5. Write a one-line note to vault:notes/<module>.md.

# captured because you ran these steps twice today`,
  },
  {
    id: 'skill-code-review',
    name: 'code-review',
    description: 'reviews diffs for correctness',
    whenToUse: 'any diff > 5 lines before Tier-2',
    provenance: 'hand-written',
    agents: ['reviewer', 'pr-reviewer'],
    portable: true,
    usage: '',
    body: `# Procedure

1. Read the full diff and the surrounding context of each hunk.
2. Flag correctness bugs first; style/nits last.
3. Check tests exist and cover the changed branches.
4. Reject on any hallucinated API or unverified assumption.
5. Emit a rubric score with a one-line rationale per finding.`,
  },
  {
    id: 'skill-diff-context',
    name: 'diff-context',
    description: 'builds minimal context for an edit',
    whenToUse: 'editing an existing file',
    provenance: 'captured',
    agents: ['implementer'],
    portable: true,
    usage: '',
    body: `# Procedure

1. Resolve the symbol under edit and its direct callers/callees.
2. Pull only those spans into context — nothing whole-file.
3. Include the file's imports and type signatures.
4. Cap the window; drop the least-referenced spans first.`,
  },
  {
    id: 'skill-vault-search',
    name: 'vault-search',
    description: 'retrieves + cites vault notes',
    whenToUse: 'task mentions prior decisions',
    provenance: 'imported',
    agents: ['retrieval'],
    portable: true,
    usage: '',
    body: `# Procedure

1. Read the index first; never scan the whole vault.
2. Expand to the pages the index names, then their backlinks.
3. Quote the source path inline with every claim.
4. Return "no record" rather than guess when the vault is silent.`,
  },
]

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

function isProvenance(x: unknown): x is Provenance {
  return x === 'captured' || x === 'hand-written' || x === 'imported' || x === 'vault'
}

function isSkill(x: unknown): x is StoredSkill {
  if (typeof x !== 'object' || x === null) return false
  const s = x as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.description === 'string' &&
    typeof s.whenToUse === 'string' &&
    isProvenance(s.provenance) &&
    Array.isArray(s.agents) &&
    s.agents.every((a) => typeof a === 'string') &&
    typeof s.portable === 'boolean' &&
    typeof s.body === 'string' &&
    typeof s.usage === 'string' &&
    // Optional (back-compat: older persisted arrays predate it) — but when
    // present it must be a string, since delete/persist targets it directly.
    (s.sourcePath === undefined || typeof s.sourcePath === 'string') &&
    // Optional (back-compat: pre-P3-3 persisted arrays predate it) — but
    // when present it must be a string array, since it drives role chips.
    (s.roles === undefined ||
      (Array.isArray(s.roles) && s.roles.every((r) => typeof r === 'string')))
  )
}

function persist(next: StoredSkill[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable — keep the in-memory copy
  }
}

function load(): StoredSkill[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isSkill)) {
        // Migrate: an old UI bug could save the same skill repeatedly —
        // keep the first of each name.
        const seen = new Set<string>()
        const deduped = parsed.filter((sk) => {
          const k = sk.name.trim().toLowerCase()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        if (deduped.length !== parsed.length) persist(deduped)
        return deduped
      }
    }
  } catch {
    // corrupt or unavailable — fall through to seed
  }
  const seeded = SEED.map((s) => ({ ...s }))
  persist(seeded)
  return seeded
}

let state: StoredSkill[] = load()

// ---------------------------------------------------------------------------
// Pub/sub
// ---------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commit(next: StoredSkill[]): void {
  state = next
  persist(next)
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every skill, in stored order (newest last). */
export function list(): StoredSkill[] {
  return state
}

let seq = 0

/** Create a skill. Returns the new skill (prepended so it surfaces first). */
export function create(input: NewSkillInput): StoredSkill {
  // No duplicate names — creating an existing skill returns it instead.
  const existing = state.find(
    (sk) => sk.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
  )
  if (existing) return existing

  const name = input.name.trim() || 'untitled-skill'
  const description = input.description.trim() || 'a captured workflow'
  const whenToUse = input.whenToUse.trim() || 'when the workflow repeats'
  // Slug-collision guard: two DISTINCT skills can pass the name-dedupe above
  // yet slug to the SAME canonical path (e.g. "code-review" vs "Code Review",
  // or a new local "notes" vs an imported vault skill sitting at
  // skills/notes.md). If the canonical path is already owned by another skill,
  // give this one an explicit, distinct sourcePath so persist/remove can never
  // clobber or delete the other's durable vault file. Name-dedupe guarantees
  // names are unique, so fnv1a(name) suffixes are distinct — no re-collision.
  // Non-colliding creates leave sourcePath undefined (byte-identical to today).
  const canonical = skillVaultPath(name)
  const collides = state.some((sk) => skillWritePath(sk) === canonical)
  const skill: StoredSkill = {
    id: `skill-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    name,
    description,
    whenToUse,
    provenance: input.provenance ?? 'captured',
    agents: (input.agents ?? []).map((a) => a.trim()).filter(Boolean),
    portable: input.portable ?? true,
    body:
      input.body?.trim() ||
      `# Procedure

1. ${description}.
2. Verify the result before writing anything back.

# ${input.provenance === 'captured' || !input.provenance ? 'captured from a repeated workflow' : 'authored by hand'}`,
    usage: '',
    ...(collides ? { sourcePath: `skills/${skillSlug(name)}-${fnv1a(name)}.md` } : {}),
    ...(input.roles && input.roles.length
      ? { roles: input.roles.map((r) => r.trim()).filter(Boolean) }
      : {}),
  }
  commit([skill, ...state])
  return skill
}

/** Patch a skill. */
export function update(id: string, patch: SkillPatch): void {
  let changed = false
  const next = state.map((s) => {
    if (s.id !== id) return s
    changed = true
    return {
      ...s,
      ...patch,
      agents: patch.agents ? patch.agents.map((a) => a.trim()).filter(Boolean) : s.agents,
      roles: patch.roles ? patch.roles.map((r) => r.trim()).filter(Boolean) : s.roles,
    }
  })
  if (changed) commit(next)
}

/** Remove a skill. No-op if it does not exist. */
export function remove(id: string): void {
  if (!state.some((s) => s.id === id)) return
  commit(state.filter((s) => s.id !== id))
}

// ---------------------------------------------------------------------------
// Vault auto-discovery (ADR-020: a SKILL.md dropped in the vault is
// auto-discovered — `skills/*.md` or any `SKILL.md` — and joins the library)
// ---------------------------------------------------------------------------

/** Parse one vault skill file: YAML-ish frontmatter wins, then headings. */
/** Keys a `metadata:` child may never set — mirrors `_RESERVED_FM_KEYS`. */
const RESERVED_FM_KEYS = new Set(['name', 'description', 'allowed_tools'])

/** Strip ONE matched surrounding quote pair — mirrors the engine's `_unquote`. */
function unquoteFm(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    const inner = value.slice(1, -1)
    return value[0] === '"' ? inner.replace(/\\"/g, '"') : inner
  }
  return value
}

export function parseVaultSkill(relpath: string, raw: string): NewSkillInput {
  let body = raw.trim()
  const fm: Record<string, string> = {}
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (fmMatch) {
    body = body.slice(fmMatch[0].length).trim()
    for (const line of fmMatch[1].split('\n')) {
      // Indentation captured BEFORE the trim — see the engine's identical rule
      // in skills.py. Flattening a `metadata:` child into a top-level key is
      // what carries SC Prism's own properties inside the spec's escape hatch;
      // the guard stops a legal foreign skill's metadata block from hijacking
      // name/description/allowed-tools.
      const indented = /^\s/.test(line)
      const kv = /^([A-Za-z_-]+)\s*:\s*(.+)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase().replace(/-/g, '_')
      if (indented && RESERVED_FM_KEYS.has(key)) continue
      fm[key] = unquoteFm(kv[2].trim())
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const fileName = relpath
    .replace(/\.md$/i, '')
    .split('/')
    .filter((seg) => seg && !/^skills$/i.test(seg) && !/^SKILL$/i.test(seg))
    .pop()
  const firstPara = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  // Role scoping (P3-3, mirrors the engine's `_split_roles`,
  // engine/scprism_engine/skills.py ~L165): `roles:` OR `agents:` (alias) ->
  // the role list. No key ⇒ [] ⇒ omitted below ⇒ global.
  const roles = splitRoles(fm.scprism_roles || fm.roles || fm.agents || '')
  return {
    name: fm.scprism_display_name || fm.name || heading || fileName || relpath,
    description: fm.description || firstPara || 'a vault-published skill',
    whenToUse:
      fm.when_to_use ||
      fm.whentouse ||
      fm.scprism_when_to_use ||
      'when the procedure matches the task',
    provenance: 'vault',
    body,
    ...(roles.length > 0 ? { roles } : {}),
  }
}

/** Split a `roles:`/`agents:` frontmatter value into role names on commas or
 * whitespace (mirrors the engine loader's `_split_roles`,
 * engine/scprism_engine/skills.py ~L165); each stripped, empties dropped. An
 * empty value yields `[]` (global). */
function splitRoles(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** FNV-1a hash (hex) — mirrors the icon-tint hash in pages/Skills.tsx; kept
 * local so this store stays dependency-free. */
function fnv1a(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/** Slug a skill name for its vault filename: lowercase, non-`[a-z0-9]` runs
 * collapse to a single '-', leading/trailing '-' trimmed. Names with no
 * sluggable characters at all (e.g. '!!!') fall back to a deterministic
 * `skill-<fnv1a hex>` slug, so distinct all-punctuation names get distinct
 * stable paths — never a shared 'skills/.md' (which would silently collide
 * on write and delete the wrong file on remove). */
/**
 * The six capability words, which a skill may never be NAMED.
 *
 * `agentCapabilityNames` (delegation.ts) unions an agent's `skills` list into
 * its capability REQUEST. In a folder-shaped ecosystem `skills/web/SKILL.md` is
 * an ordinary import, and importing it would hand that agent the `web`
 * capability by name alone — no grant, no declaration, no approval. Suffixing
 * keeps the name recognisable instead of hashing it into nonsense.
 */
const CAPABILITY_WORDS = new Set(['vault', 'web', 'computer', 'terminal', 'tools', 'writes'])

export function skillSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (CAPABILITY_WORDS.has(slug)) return `${slug}-skill`
  return slug || `skill-${fnv1a(name.trim())}`
}

/**
 * Whether a vault-relative path is a skill FILE — a flat `skills/<slug>.md` or
 * a folder's `skills/<slug>/SKILL.md`, and nothing else.
 *
 * The old inline filter was `/^skills\/.+\.md$/i`, whose `.+` crosses slashes.
 * Once folder-shaped skills exist that matches `skills/x/references/api.md`,
 * which then becomes a `provenance: 'vault'` library skill: its Delete button
 * erases the real reference file, and an AI-improve Apply overwrites it with
 * model-written frontmatter. Extracted and pure so it can be pinned by test.
 */
export function isVaultSkillFile(relPath: string): boolean {
  return (
    /^skills\/[^/]+\.md$/i.test(relPath) || /^skills\/[^/]+\/SKILL\.md$/i.test(relPath)
  )
}

/** Vault-relative path for a skill's durable copy. */
export function skillVaultPath(name: string): string {
  return `skills/${skillSlug(name)}.md`
}

/**
 * The single source of truth for WHERE a skill's vault file lives — used by
 * both `persistSkillToVault` and `removeSkillFromVault` so they can never
 * disagree. A vault-discovered skill's real file (`sourcePath`, recorded by
 * `syncVaultSkills`) wins; anything else (locally-created skills, legacy
 * entries persisted before sourcePath existed) gets the canonical name-slug
 * path. Pure and exported so the targeting rule is unit-testable.
 */
export function skillWritePath(s: Pick<StoredSkill, 'name' | 'sourcePath'>): string {
  return s.sourcePath || skillVaultPath(s.name)
}

/**
 * Serialize a skill to the vault markdown format `parseVaultSkill` round-trips
 * (frontmatter name/description/when_to_use, then the body). Newlines inside
 * the frontmatter fields are sanitized to single spaces — a bare field must
 * stay on one line, and an embedded blank line could otherwise be mistaken
 * for the closing `---`.
 *
 * Never emits an empty frontmatter value: parseVaultSkill's `key: value`
 * regex requires a value, so an empty `description: ` would be skipped and
 * the parser would fall back to the BODY's first paragraph (contamination).
 * Empty/whitespace fields get stable defaults instead — `when_to_use`'s
 * default is the exact string parseVaultSkill already defaults to, so the
 * round-trip has a fixed point.
 */
/**
 * A YAML-safe scalar. Ordinary prose breaks bare YAML: a description like
 * "Reviews diffs: correctness and style" is something SC Prism renders
 * perfectly and every conformant consumer rejects. Quote when the value could
 * be read as anything but a string.
 */
function yamlScalar(value: string): string {
  const needsQuote =
    value.includes(': ') ||
    value.includes(' #') ||
    value.endsWith(':') ||
    /^[>|*&!%@`[\]{},?:'"#-]/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Serialize a skill as a spec-conformant `SKILL.md`.
 *
 * Top-level keys are exactly `{name, description, metadata}` — the two the
 * Agent Skills spec requires, plus its sanctioned escape hatch. `name` is
 * clamped to the spec's 64 characters and its lowercase-alphanumeric-and-
 * hyphen charset (via `skillSlug`, which also refuses the capability words);
 * `description` to 1024.
 *
 * SC Prism's own properties ride inside `metadata`, where the spec permits
 * arbitrary string keys — and where our parsers already read them for free,
 * because flattening an indented child into a top-level key is exactly what
 * both of them do.
 *
 * `allowed-tools` is deliberately NOT written. We read it leniently so foreign
 * skills work, but emitting our own capability vocabulary into an experimental
 * spec field would be non-conformant in the other direction.
 */
export function serializeSkillMd(
  s: Pick<StoredSkill, 'name' | 'description' | 'whenToUse' | 'body'> &
    Partial<Pick<StoredSkill, 'roles'>>,
): string {
  const oneLine = (v: string) => (v ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
  const name = skillSlug(oneLine(s.name) || 'untitled-skill').slice(0, 64).replace(/-+$/, '')
  const description = (oneLine(s.description) || 'a saved skill').slice(0, 1024)
  const whenToUse = oneLine(s.whenToUse) || 'when the procedure matches the task'
  // `StoredSkill.agents` is NEVER the source of these and is never serialized:
  // it is a separate, populated, displayed store field, and sourcing roles from
  // it would give every seeded skill a role scope it never had and silently
  // halve disclosure on the roster path.
  const roles = (s.roles ?? []).map((r) => r.trim()).filter(Boolean)

  // The metadata block is never emitted empty — an empty `metadata:` parses as
  // null and crashes a conformant consumer's `.items()`. `when_to_use` is
  // always present, so the block always has at least one child.
  const meta = [`  when_to_use: ${yamlScalar(whenToUse)}`]
  // The spec's `name` charset cannot hold a human title like "Deploy: Staging
  // -> Prod!!". Slugging it keeps the file conformant; without preserving the
  // original we would silently RENAME the user's skill on the next save. Only
  // emitted when it actually differs, so ordinary slug-shaped names are
  // byte-identical to a file with no display name at all.
  const display = oneLine(s.name)
  if (display && display !== name) {
    meta.push(`  scprism_display_name: ${yamlScalar(display)}`)
  }
  if (roles.length > 0) meta.push(`  scprism_roles: ${yamlScalar(roles.join(', '))}`)

  return (
    `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n` +
    `metadata:\n${meta.join('\n')}\n---\n\n${s.body.trim()}\n`
  )
}

/**
 * The conformant location for a skill: `skills/<slug>/SKILL.md`.
 *
 * The Agent Skills spec addresses a skill as a DIRECTORY whose name equals its
 * `name`, so the flat `skills/<slug>.md` dialect can never be conformant. Both
 * shapes are read forever; this is only where an upgraded one lands.
 */
export function skillFolderPath(s: Pick<StoredSkill, 'name'>): string {
  return `skills/${skillSlug(s.name)}/SKILL.md`
}

/**
 * Whether a skill can move to the folder shape WITHOUT being renamed.
 *
 * The spec requires `name` to equal the directory, and the verdict→library
 * join matches skills by their name string — so upgrading a skill whose name
 * is not already its own slug would silently zero its usage stats and suppress
 * the underperforming → AI-improve gate. Refuse instead of renaming behind the
 * user's back. A skill already in a folder has nothing to do.
 */
export function canUpgradeToFolder(s: Pick<StoredSkill, 'name' | 'sourcePath'>): boolean {
  if (s.sourcePath && /\/SKILL\.md$/i.test(s.sourcePath)) return false
  const name = (s.name ?? '').trim()
  return name.length > 0 && name === skillSlug(name)
}

/** What an upgrade attempt did. `sourcePath` is set only on success. */
export interface FolderUpgrade {
  ok: boolean
  sourcePath?: string
  reason?: string
}

/**
 * Move ONE skill from the flat shape to the conformant folder shape.
 *
 * Order is the whole design: write → read back to verify → delete the flat
 * original → only then report the new `sourcePath` for the caller to stamp.
 *
 * The delete is not optional. Leaving both files on disk puts the vault in the
 * state where the engine's folder-wins rule hides the flat twin, Delete then
 * targets the folder file, the flat one survives, and the next sync re-inserts
 * the skill with its PRE-UPGRADE body. If the delete fails we roll the folder
 * file back rather than leave that state behind — a failed upgrade is fine, a
 * silently resurrecting skill is not.
 *
 * Never throws and never sweeps: one skill, one explicit action.
 */
export async function upgradeSkillToFolder(
  s: Pick<StoredSkill, 'name' | 'description' | 'whenToUse' | 'body' | 'sourcePath'> &
    Partial<Pick<StoredSkill, 'roles'>>,
  vaultPath?: string,
): Promise<FolderUpgrade> {
  if (!isNative()) return { ok: false, reason: 'not running natively' }
  if (!canUpgradeToFolder(s)) {
    return { ok: false, reason: `"${s.name}" would have to be renamed to move into a folder` }
  }
  const target = skillFolderPath(s)
  const flat = s.sourcePath || skillVaultPath(s.name)
  if (target === flat) return { ok: false, reason: 'already in the folder shape' }

  try {
    const vault = await resolveVaultDir(vaultPath)

    // Never clobber: something already at the target is not ours to overwrite.
    const existing = await readVaultFile(vault, target)
    if (existing !== null) {
      return { ok: false, reason: `${target} already exists` }
    }

    const content = serializeSkillMd(s)
    const written = await writeVaultNote(vault, target, content)
    if (written === null) return { ok: false, reason: `could not write ${target}` }

    // Read back before destroying anything. A write that reported success but
    // did not land would otherwise cost the user the whole skill.
    const readBack = await readVaultFile(vault, target)
    if (readBack === null) {
      return { ok: false, reason: `could not verify ${target} after writing it` }
    }

    const delErr = await deleteVaultFile(vault, flat)
    if (delErr !== null) {
      // Roll back so the two-file resurrection state can never exist. If even
      // the rollback cannot run we are stuck in that state, and the only
      // useful thing left is to name BOTH files so the user can clean up by
      // hand. Never report success, and never stamp the new sourcePath.
      const rollbackErr = await deleteVaultFile(vault, target)
      if (rollbackErr !== null) {
        return {
          ok: false,
          reason:
            `could not remove ${flat} (${delErr}), and could not roll back ` +
            `${target} either — both files now exist; delete one by hand ` +
            `before using this skill again`,
        }
      }
      return { ok: false, reason: `could not remove ${flat} — ${delErr}` }
    }

    return { ok: true, sourcePath: target }
  } catch {
    return { ok: false, reason: 'the upgrade failed' }
  }
}

/**
 * Write a skill's durable copy into the vault at `skillWritePath(s)` — the
 * discovered `sourcePath` when the vault owns the file, else the canonical
 * `skills/<slug>.md`. (Writing the canonical path for a vault skill that
 * lives elsewhere would fork it: a fresh duplicate at the slug path while
 * the real source file stays stale.) Native-only (mirrors `syncVaultSkills`'s
 * gate): resolves `false` in the browser or on any failure — never throws,
 * so callers (the page, S5) can fire this after `create`/`update` without an
 * extra try/catch.
 */
export async function persistSkillToVault(
  s: Pick<StoredSkill, 'name' | 'description' | 'whenToUse' | 'body' | 'sourcePath'> &
    Partial<Pick<StoredSkill, 'roles'>>,
  vaultPath?: string,
): Promise<boolean> {
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const written = await writeVaultNote(vault, skillWritePath(s), serializeSkillMd(s))
    return written !== null
  } catch {
    return false
  }
}

/**
 * Delete a skill's vault file — at `skillWritePath(s)`, the same target
 * `persistSkillToVault` writes, so deleting a vault-discovered skill removes
 * its REAL file (deleting the canonical slug path instead would leave the
 * real file behind, and the next sync would silently resurrect the skill).
 * Native-only; resolves `false` in the browser or on any failure. Callers
 * invoke this after the local `remove()`.
 */
export async function removeSkillFromVault(
  s: Pick<StoredSkill, 'name' | 'sourcePath'>,
  vaultPath?: string,
): Promise<boolean> {
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const err = await deleteVaultFile(vault, skillWritePath(s))
    return err === null
  } catch {
    return false
  }
}

/**
 * Merge a parsed vault file into an EXISTING same-named library skill. Pure
 * so the provenance/sourcePath gating is unit-testable without a native
 * runtime.
 *
 * The name-match lookup in `syncVaultSkills` is provenance-agnostic, so a
 * hand-written or seed skill can collide by name with a hand-authored vault
 * file sitting at an arbitrary path. `provenance` and `sourcePath` must
 * therefore be gated IDENTICALLY: only a skill the vault ALREADY owns
 * (`provenance === 'vault'`) adopts the file's path. Otherwise leaving
 * `sourcePath` unchanged is what keeps ordinary Delete on a non-vault skill
 * from ever resolving to — and erasing — an unrelated real vault file.
 */
export function mergeVaultSkill(
  existing: StoredSkill,
  parsed: NewSkillInput,
  rel: string,
): StoredSkill {
  const ownedByVault = existing.provenance === 'vault'
  return {
    ...existing,
    description: parsed.description ?? existing.description,
    whenToUse: parsed.whenToUse ?? existing.whenToUse,
    body: parsed.body ?? existing.body,
    // only claim it for the vault if the vault owns it already
    provenance: ownedByVault ? 'vault' : existing.provenance,
    // gate the path the SAME way — a non-vault name-collision must never
    // inherit an unrelated file's path (that path is a delete target)
    sourcePath: ownedByVault ? rel : existing.sourcePath,
    // roles (P3-3) are vault-frontmatter content, so gate them the SAME way:
    // vault content wins for a skill the vault already owns (including a
    // resync that removed the `roles:` key, honestly reverting to global);
    // a non-vault name-collision never inherits an unrelated file's roles.
    roles: ownedByVault ? parsed.roles : existing.roles,
  }
}

/**
 * Scan the vault for SKILL.md files and sync them into the library.
 * Vault content wins on re-sync; vault skills deleted on disk are removed
 * (user-authored local skills are never touched). Returns the vault count.
 */
export async function syncVaultSkills(vaultPath?: string): Promise<number> {
  if (!isNative()) return 0
  const vault = await resolveVaultDir(vaultPath)
  const files = await listVaultTree(vault)
  const skillFiles = files.filter(isVaultSkillFile)
  const seen = new Set<string>()
  let next = [...state]
  for (const rel of skillFiles) {
    const raw = await readVaultFile(vault, rel)
    if (!raw) continue
    const parsed = parseVaultSkill(rel, raw)
    const key = parsed.name.trim().toLowerCase()
    seen.add(key)
    const existing = next.find((s) => s.name.trim().toLowerCase() === key)
    if (existing) {
      next = next.map((s) => (s.id === existing.id ? mergeVaultSkill(s, parsed, rel) : s))
    } else {
      next = [
        {
          id: `skill-vault-${key.replace(/[^a-z0-9]+/g, '-')}`,
          name: parsed.name.trim(),
          description: (parsed.description ?? '').trim(),
          whenToUse: (parsed.whenToUse ?? '').trim(),
          provenance: 'vault',
          agents: [],
          portable: true,
          body: parsed.body ?? '',
          usage: '',
          sourcePath: rel,
          ...(parsed.roles ? { roles: parsed.roles } : {}),
        },
        ...next,
      ]
    }
  }
  // Drop vault-sourced skills whose file disappeared.
  next = next.filter(
    (s) => s.provenance !== 'vault' || seen.has(s.name.trim().toLowerCase()),
  )
  // MIGRATION (2026-08-29 — mirrors syncVaultAgents): every store skill still
  // without a file gets one written on the first native load, stamped with
  // its sourcePath, so the library is portable markdown like the agents. The
  // disk is re-probed first: a hand-authored file at the path is never
  // clobbered — discovery adopts it on the next pass instead.
  for (const id of next.map((row) => row.id)) {
    const s0 = next.find((row) => row.id === id)
    if (!s0 || s0.sourcePath) continue
    const rel = skillWritePath(s0)
    const onDisk = await readVaultFile(vault, rel)
    if (onDisk !== null) continue
    const written = await writeVaultNote(vault, rel, serializeSkillMd(s0))
    if (written !== null) next = next.map((r) => (r.id === id ? { ...r, sourcePath: rel } : r))
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) commit(next)
  return seen.size
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/** Subscribe a component to the skills store; returns the current snapshot. */
export function useSkills(): StoredSkill[] {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}
