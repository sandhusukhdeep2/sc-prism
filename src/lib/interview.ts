// SC Prism — the business interview answers (persisted under `scprism.interview`).
// A provider-less store backed by localStorage: a module-level snapshot plus a
// `useSyncExternalStore` hook, so any component that calls `useInterview()`
// shares the same state without a React Provider (main.tsx stays untouched).

import { useCallback, useSyncExternalStore } from 'react'
import { isNative, storeGet, storeSet } from './nativeEngine'

// ---------- shape ----------

export type RoleHat = 'developer' | 'reviewer' | 'admin' | 'data-owner'
export type Priority = 'compliance' | 'speed' | 'cost'
export type SignoffId = 'push-main' | 'delete-audit' | 'change-perms' | 'spend'

/** One adaptive-phase Q&A (2026-07-29 spec): a question the live PRIMARY
 * generated, the user's typed answer, and the honest attribution captured at
 * generation time (`model` '' = the engine reported none; `local` = the
 * question was generated on-device). Scripted-fallback answers never land
 * here — they go to their own structured fields as always. */
export interface AdaptiveQA {
  q: string
  a: string
  model: string
  local: boolean
}

export interface InterviewState {
  /** Free-text description of what the business does. */
  business: string
  /** Company / trading name ('' = not given). */
  companyName: string
  /** Website or public links the user shared ('' = private/none). */
  website: string
  /** Departments the company has (free strings, chips + custom). */
  departments: string[]
  /** Team size bucket ('' = unanswered). */
  teamSize: string
  /** Monthly AI/tooling budget bucket ('' = unanswered). */
  budget: string
  /** Words/topics that must NEVER leave this machine (force-local routing). */
  sensitiveWords: string[]
  /** The user's own verify command (Tier-1 gate), e.g. "npm test". */
  verifyCommand: string
  /** Compliance regimes that apply (GDPR, HIPAA, …). */
  compliance: string[]
  /** Which role hats the operator wears (multi-select). */
  roles: RoleHat[]
  /** Priorities in ranked order (index 0 = most important). */
  priorities: Priority[]
  /** Actions that always need explicit sign-off (the checked gates). */
  signoffs: SignoffId[]
  /** The never-touch list — things no agent may ever modify. */
  neverTouch: string[]
  /** Adaptive-phase Q&A — questions the live primary generated + the answers
   * (stays local like every other answer; feeds the next generation prompt). */
  adaptive: AdaptiveQA[]
}

// ---------- catalog / labels ----------

export const ROLE_HATS: RoleHat[] = ['developer', 'reviewer', 'admin', 'data-owner']

export const PRIORITY_LABEL: Record<Priority, string> = {
  compliance: 'Compliance',
  speed: 'Speed',
  cost: 'Cost',
}

export interface SignoffMeta {
  id: SignoffId
  /** How it reads on the interview checklist. */
  label: string
  /** How it reads as a governance gate on review. */
  gate: string
}

export const SIGNOFFS: SignoffMeta[] = [
  { id: 'push-main', label: 'pushing to main', gate: 'push to main' },
  { id: 'delete-audit', label: 'deleting audit history', gate: 'delete audit' },
  { id: 'change-perms', label: 'changing permissions', gate: 'change permissions' },
  { id: 'spend', label: 'spending over $5', gate: 'spend > $5' },
]

// ---------- defaults ----------

// Seeded with the original mock answers so a fresh run still looks populated
// and the review has meaningful content to derive — all fully editable.
const DEFAULTS: InterviewState = {
  business:
    'Solo consultancy — I build data pipelines and internal tools for small logistics companies. One production client right now.',
  companyName: '',
  website: '',
  departments: [],
  teamSize: '',
  budget: '',
  sensitiveWords: [],
  verifyCommand: '',
  compliance: [],
  roles: ['developer', 'reviewer'],
  priorities: ['speed', 'cost', 'compliance'],
  signoffs: ['push-main', 'delete-audit', 'spend'],
  neverTouch: ['prod DB', '/secrets', 'billing'],
  adaptive: [],
}

const STORAGE_KEY = 'scprism.interview'

// ---------- persistence ----------

function sanitizeRoles(v: unknown): RoleHat[] {
  if (!Array.isArray(v)) return [...DEFAULTS.roles]
  return v.filter((r): r is RoleHat => ROLE_HATS.includes(r as RoleHat))
}

function sanitizePriorities(v: unknown): Priority[] {
  const all: Priority[] = ['compliance', 'speed', 'cost']
  if (!Array.isArray(v)) return [...DEFAULTS.priorities]
  const picked = v.filter((p): p is Priority => all.includes(p as Priority))
  // Ensure every priority appears exactly once, preserving the stored order.
  const seen = new Set<Priority>(picked)
  return [...picked.filter((p, i) => picked.indexOf(p) === i), ...all.filter((p) => !seen.has(p))]
}

function sanitizeSignoffs(v: unknown): SignoffId[] {
  const ids = SIGNOFFS.map((s) => s.id)
  if (!Array.isArray(v)) return [...DEFAULTS.signoffs]
  return v.filter((s): s is SignoffId => ids.includes(s as SignoffId))
}

function sanitizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULTS.neverTouch]
  return v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
}

function sanitizeStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
}

function sanitizeAdaptiveQA(v: unknown): AdaptiveQA[] {
  if (!Array.isArray(v)) return []
  const out: AdaptiveQA[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Partial<AdaptiveQA>
    if (typeof e.q !== 'string' || typeof e.a !== 'string') continue
    if (!e.q.trim() || !e.a.trim()) continue
    out.push({
      q: e.q,
      a: e.a,
      model: typeof e.model === 'string' ? e.model : '',
      local: e.local === true,
    })
  }
  return out
}

function normalize(parsed: Partial<InterviewState> | null | undefined): InterviewState {
  if (!parsed) return { ...DEFAULTS }
  return {
    business: typeof parsed.business === 'string' ? parsed.business : DEFAULTS.business,
    companyName: typeof parsed.companyName === 'string' ? parsed.companyName : '',
    website: typeof parsed.website === 'string' ? parsed.website : '',
    departments: sanitizeStrings(parsed.departments),
    teamSize: typeof parsed.teamSize === 'string' ? parsed.teamSize : '',
    budget: typeof parsed.budget === 'string' ? parsed.budget : '',
    sensitiveWords: sanitizeStrings(parsed.sensitiveWords),
    verifyCommand: typeof parsed.verifyCommand === 'string' ? parsed.verifyCommand : '',
    compliance: sanitizeStrings(parsed.compliance),
    roles: sanitizeRoles(parsed.roles),
    priorities: sanitizePriorities(parsed.priorities),
    signoffs: sanitizeSignoffs(parsed.signoffs),
    neverTouch: sanitizeTags(parsed.neverTouch),
    adaptive: sanitizeAdaptiveQA(parsed.adaptive),
  }
}

function load(): InterviewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalize(raw ? (JSON.parse(raw) as Partial<InterviewState>) : undefined)
  } catch {
    return { ...DEFAULTS }
  }
}

// ---------- external store ----------

let state: InterviewState = load()
const listeners = new Set<() => void>()
// Disk copy wins on startup; writes go through only after hydration so a
// stale localStorage snapshot never clobbers the durable file.
let diskHydrated = !isNative()

function emit(): void {
  for (const l of listeners) l()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage may be unavailable (private mode); non-fatal.
  }
  if (diskHydrated) void storeSet('interview', JSON.stringify(state))
}

if (isNative()) {
  void storeGet('interview').then((raw) => {
    if (raw) {
      try {
        state = normalize(JSON.parse(raw) as Partial<InterviewState>)
        emit()
      } catch {
        // corrupt disk copy: keep localStorage state
      }
    }
    diskHydrated = true
  })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getInterview(): InterviewState {
  return state
}

export function setInterview(patch: Partial<InterviewState>): void {
  state = { ...state, ...patch }
  persist()
  emit()
}

/** Clear all captured answers back to defaults and wipe the stored copy. */
export function resetInterview(): void {
  state = { ...DEFAULTS }
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // non-fatal
  }
  emit()
}

// ---------- hook ----------

export interface UseInterview {
  interview: InterviewState
  setBusiness: (business: string) => void
  toggleRole: (role: RoleHat) => void
  movePriority: (priority: Priority, dir: -1 | 1) => void
  toggleSignoff: (id: SignoffId) => void
  addTag: (tag: string) => void
  removeTag: (tag: string) => void
}

export function useInterview(): UseInterview {
  const interview = useSyncExternalStore(subscribe, getInterview, getInterview)

  const setBusiness = useCallback((business: string) => setInterview({ business }), [])

  const toggleRole = useCallback((role: RoleHat) => {
    const roles = getInterview().roles
    setInterview({
      roles: roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role],
    })
  }, [])

  const movePriority = useCallback((priority: Priority, dir: -1 | 1) => {
    const priorities = [...getInterview().priorities]
    const i = priorities.indexOf(priority)
    const j = i + dir
    if (i < 0 || j < 0 || j >= priorities.length) return
    ;[priorities[i], priorities[j]] = [priorities[j], priorities[i]]
    setInterview({ priorities })
  }, [])

  const toggleSignoff = useCallback((id: SignoffId) => {
    const signoffs = getInterview().signoffs
    setInterview({
      signoffs: signoffs.includes(id) ? signoffs.filter((s) => s !== id) : [...signoffs, id],
    })
  }, [])

  const addTag = useCallback((tag: string) => {
    const trimmed = tag.trim()
    if (!trimmed) return
    const neverTouch = getInterview().neverTouch
    if (neverTouch.includes(trimmed)) return
    setInterview({ neverTouch: [...neverTouch, trimmed] })
  }, [])

  const removeTag = useCallback((tag: string) => {
    setInterview({ neverTouch: getInterview().neverTouch.filter((t) => t !== tag) })
  }, [])

  return { interview, setBusiness, toggleRole, movePriority, toggleSignoff, addTag, removeTag }
}
