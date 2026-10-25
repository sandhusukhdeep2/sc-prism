// SC Prism — vault store.
//
// The vault is a flat map of `path -> markdown content`. Folders are implied by the
// `/` separators in paths. Every mutation runs a validated-write gate and, on success,
// notifies subscribers (see `subscribe` / `useVault`) so the UI re-renders.
//
// Two backends behind ONE synchronous interface:
//   • Browser  — localStorage (the in-memory `state` is the source of truth).
//   • Native (Tauri) — real files under `<appData>/vault`. The in-memory `state`
//     stays the synchronous source of truth; disk is hydrated on startup and
//     mirrored (write/remove) asynchronously. If disk is unavailable it silently
//     degrades to the in-memory/localStorage behaviour.

import { useSyncExternalStore } from 'react'
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove as fsRemove,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { isNative } from './nativeEngine'

const KEY = 'scprism.vault'

/** Root folder (under the OS app-data dir) holding the on-disk vault files. */
const VAULT_ROOT = 'vault'

/** Flat path -> markdown map. */
export type VaultStore = Record<string, string>

/** Result of the validated-write gate. */
export type WriteResult = { ok: true } | { ok: false; reason: string }

/** Nested tree node, derived from the flat store for the file browser. */
export type TreeNode =
  | { type: 'folder'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; path: string }

// ---------------------------------------------------------------------------
// Seed content
// ---------------------------------------------------------------------------

const SEED: VaultStore = {
  'index.md': `# Vault index

This is the single source of truth for SC Prism. Every file here is plain
markdown, and **every write passes a validation gate** before it lands.

## Contents

- \`notes/uploader.md\` — how the uploader service behaves
- \`policies/rate-limit.md\` — the enforced rate-limit policy
- \`decisions/2026-07-03-amber-theme.md\` — why the UI is cream + gold

Indexes are derived and regenerable from the files themselves.
`,
  'notes/uploader.md': `# Uploader

Notes on the client-facing uploader service.

- Accepts multipart uploads from pilot clients
- Rate-limited per client (see \`policies/rate-limit.md\`)
- Internal batch jobs are exempt from the limit

## Retry behaviour

When a client exceeds the window it receives a \`429\` with a \`Retry-After\`
header. Clients should back off rather than hammer the endpoint.

\`\`\`
POST /upload  ->  202 Accepted
POST /upload  ->  429 Too Many Requests   # over the window
\`\`\`
`,
  'policies/rate-limit.md': `# Rate-limit policy

Uploads are rate-limited per client to protect the pilot deployment. The window
applies to the uploader service only; internal batch jobs are exempt. Tightened
from 60 to 30 rpm after the June review.

\`\`\`
scope: uploader
max_rpm: 30
retry_after: 20s
exempt: ["batch"]
\`\`\`

Changes to this file always pass a confirmation gate.
`,
  'decisions/2026-07-03-amber-theme.md': `# Decision: Amber theme

We ship the primary UI as a warm **cream + gold** ("Amber") theme.

## Rationale

- Reads as calm and trustworthy rather than clinical
- Gold accents mark validated, high-signal state
- A darker "Prism" theme can arrive later via \`[data-theme]\`

## Status

Accepted — 2026-07-03.
`,
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

function persist(store: VaultStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // storage unavailable (private mode / quota) — keep the in-memory copy
  }
}

function load(): VaultStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as VaultStore
  } catch {
    // corrupt or unavailable — fall through to seed
  }
  const seeded: VaultStore = { ...SEED }
  persist(seeded)
  return seeded
}

// `state` is replaced (never mutated) on every change so `useSyncExternalStore`
// can compare snapshots by reference.
let state: VaultStore = load()

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

function emit(): void {
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// Native (Tauri-fs) backend — mirrors `state` to real files under <appData>/vault
// ---------------------------------------------------------------------------

const FS_OPTS = { baseDir: BaseDirectory.AppData } as const

/** Write one vault file to disk, creating parent folders as needed. */
async function nativeWriteFile(path: string, content: string): Promise<void> {
  const full = `${VAULT_ROOT}/${path}`
  const slash = full.lastIndexOf('/')
  if (slash > 0) {
    await mkdir(full.slice(0, slash), { ...FS_OPTS, recursive: true })
  }
  await writeTextFile(full, content, FS_OPTS)
}

/** Delete one vault file from disk (no-op if missing). */
async function nativeDeleteFile(path: string): Promise<void> {
  const full = `${VAULT_ROOT}/${path}`
  if (await exists(full, FS_OPTS)) {
    await fsRemove(full, FS_OPTS)
  }
}

/** Recursively collect `path -> content` for every `.md` file under `dir`. */
async function nativeWalk(dir: string, out: VaultStore): Promise<void> {
  const entries = await readDir(dir, FS_OPTS)
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory) {
      await nativeWalk(full, out)
    } else if (entry.isFile && entry.name.endsWith('.md')) {
      const content = await readTextFile(full, FS_OPTS)
      out[full.slice(VAULT_ROOT.length + 1)] = content
    }
  }
}

/**
 * On native startup: if the on-disk vault exists, load it (disk wins over the
 * localStorage seed); otherwise seed disk from the current in-memory state.
 * Fire-and-forget — any failure leaves the in-memory backend untouched.
 */
async function nativeHydrate(): Promise<void> {
  try {
    if (!(await exists(VAULT_ROOT, FS_OPTS))) {
      for (const [path, content] of Object.entries(state)) {
        await nativeWriteFile(path, content)
      }
      return
    }
    const disk: VaultStore = {}
    await nativeWalk(VAULT_ROOT, disk)
    if (Object.keys(disk).length > 0) {
      state = disk
      emit()
    }
  } catch {
    // disk unavailable / permission denied — keep the in-memory state as-is.
  }
}

if (isNative()) {
  void nativeHydrate()
}

// ---------------------------------------------------------------------------
// Validated-write gate
// ---------------------------------------------------------------------------

/** Pure validation used by both `write` and `create`. */
export function validate(path: string, content: string): WriteResult {
  if (content.trim() === '') {
    return { ok: false, reason: 'Empty content is rejected — write at least one line.' }
  }
  if (path.startsWith('policies/') && !/\bmax_\w+/.test(content)) {
    return {
      ok: false,
      reason: 'Files under policies/ must define a `max_…` key (e.g. max_rpm: 30).',
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Sorted list of every path in the vault. */
export function list(): string[] {
  return Object.keys(state).sort((a, b) => a.localeCompare(b))
}

/** Nested folder/file tree derived from the flat store, folders before files, sorted. */
export function tree(): TreeNode[] {
  const root: TreeNode[] = []

  for (const path of list()) {
    const parts = path.split('/')
    let level = root
    let prefix = ''

    parts.forEach((name, i) => {
      prefix = prefix ? `${prefix}/${name}` : name
      if (i === parts.length - 1) {
        level.push({ type: 'file', name, path: prefix })
        return
      }
      let folder = level.find(
        (n): n is Extract<TreeNode, { type: 'folder' }> =>
          n.type === 'folder' && n.name === name,
      )
      if (!folder) {
        folder = { type: 'folder', name, path: prefix, children: [] }
        level.push(folder)
      }
      level = folder.children
    })
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) if (n.type === 'folder') sort(n.children)
    return nodes
  }

  return sort(root)
}

/** Read a file's content, or `null` if it does not exist. */
export function read(path: string): string | null {
  return Object.prototype.hasOwnProperty.call(state, path) ? state[path] : null
}

/** Overwrite (or create) a file. Runs the validated-write gate. */
export function write(path: string, content: string): WriteResult {
  const gate = validate(path, content)
  if (!gate.ok) return gate
  state = { ...state, [path]: content }
  persist(state)
  if (isNative()) void nativeWriteFile(path, content).catch(() => {})
  emit()
  return { ok: true }
}

/** Create a new file. Fails if the path already exists. Runs the validated-write gate. */
export function create(path: string, content = ''): WriteResult {
  const clean = path.trim().replace(/^\/+|\/+$/g, '')
  if (clean === '') return { ok: false, reason: 'A file path is required.' }
  if (Object.prototype.hasOwnProperty.call(state, clean)) {
    return { ok: false, reason: `A file already exists at ${clean}.` }
  }
  return write(clean, content)
}

/** Remove a file. No-op if it does not exist. */
export function remove(path: string): void {
  if (!Object.prototype.hasOwnProperty.call(state, path)) return
  const next = { ...state }
  delete next[path]
  state = next
  persist(next)
  if (isNative()) void nativeDeleteFile(path).catch(() => {})
  emit()
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/** Subscribe a component to the vault; returns the current snapshot. */
export function useVault(): VaultStore {
  return useSyncExternalStore(subscribe, () => state, () => state)
}
