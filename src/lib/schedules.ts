// SC Prism — standing/scheduled agent loops (persisted under `scprism.schedules`).
// A schedule is a saved task the co-founder re-runs on an interval while the
// app is open (a lightweight in-app scheduler — the deterministic timer fires,
// the engine runs the task, ADR-007 preserved). Runs are recorded so the user
// can see the standing agent working over time.

import { useCallback, useSyncExternalStore } from 'react'
import { isNative, storeGet, storeSet } from './nativeEngine'

export interface ScheduleRun {
  at: number // epoch ms
  ok: boolean
  summary: string
}

export type ScheduleKind = 'task' | 'build' | 'test'

export interface Schedule {
  id: string
  task: string
  everyMinutes: number
  agents: string // roster string for a team run, or '' for a single primary run
  enabled: boolean
  lastRun: number // epoch ms, 0 = never
  runs: ScheduleRun[] // most-recent-first, capped
  projectId?: string // '' / undefined = a free-standing task loop (today)
  kind?: ScheduleKind // default 'task'
}

const SCHEDULE_KINDS: ScheduleKind[] = ['task', 'build', 'test']

const STORAGE_KEY = 'scprism.schedules'
const MAX_RUNS = 20

let state: Schedule[] = load()
const listeners = new Set<() => void>()
let diskHydrated = !isNative()

function load(): Schedule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function sanitize(v: unknown): Schedule[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is Schedule => !!s && typeof s.id === 'string' && typeof s.task === 'string')
    .map((s) => ({
      id: s.id,
      task: s.task,
      everyMinutes: Math.max(1, Number(s.everyMinutes) || 60),
      agents: typeof s.agents === 'string' ? s.agents : '',
      enabled: Boolean(s.enabled),
      lastRun: Number(s.lastRun) || 0,
      runs: Array.isArray(s.runs) ? s.runs.slice(0, MAX_RUNS) : [],
      projectId: typeof s.projectId === 'string' ? s.projectId : '',
      kind: SCHEDULE_KINDS.includes(s.kind as ScheduleKind) ? (s.kind as ScheduleKind) : 'task',
    }))
}

function emit(): void {
  for (const l of listeners) l()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* non-fatal */
  }
  if (diskHydrated) void storeSet('schedules', JSON.stringify(state))
}

if (isNative()) {
  void storeGet('schedules').then((raw) => {
    if (raw) {
      try {
        state = sanitize(JSON.parse(raw))
        emit()
      } catch {
        /* keep localStorage copy */
      }
    }
    diskHydrated = true
  })
}

export function getSchedules(): Schedule[] {
  return state
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

let seq = 0
export function addSchedule(
  task: string,
  everyMinutes: number,
  agents: string,
  projectId = '',
  kind: ScheduleKind = 'task',
): void {
  const s: Schedule = {
    id: `sch-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    task: task.trim(),
    everyMinutes: Math.max(1, everyMinutes),
    agents: agents.trim(),
    enabled: true,
    lastRun: 0,
    runs: [],
    projectId,
    kind,
  }
  state = [s, ...state]
  persist()
  emit()
}

export function updateSchedule(id: string, patch: Partial<Schedule>): void {
  state = state.map((s) => (s.id === id ? { ...s, ...patch } : s))
  persist()
  emit()
}

export function removeSchedule(id: string): void {
  state = state.filter((s) => s.id !== id)
  persist()
  emit()
}

/** Record a run outcome (called by the driver when a scheduled task finishes). */
export function recordRun(id: string, at: number, ok: boolean, summary: string): void {
  state = state.map((s) =>
    s.id === id
      ? { ...s, lastRun: at, runs: [{ at, ok, summary }, ...s.runs].slice(0, MAX_RUNS) }
      : s,
  )
  persist()
  emit()
}

/** Schedules whose interval has elapsed relative to `now` (epoch ms). */
export function dueSchedules(now: number): Schedule[] {
  return state.filter((s) => s.enabled && now - s.lastRun >= s.everyMinutes * 60_000)
}

/** Schedules bound to a given project (build/test loops owned by that project). */
export function projectSchedules(projectId: string): Schedule[] {
  return state.filter((s) => s.projectId === projectId)
}

/** The schedule's kind, defaulting to 'task' for legacy/unset schedules. */
export function scheduleKind(s: Schedule): ScheduleKind {
  return s.kind ?? 'task'
}

export function useSchedules(): Schedule[] {
  return useSyncExternalStore(subscribe, getSchedules, getSchedules)
}

export function useScheduleActions() {
  return {
    add: useCallback(addSchedule, []),
    update: useCallback(updateSchedule, []),
    remove: useCallback(removeSchedule, []),
  }
}
