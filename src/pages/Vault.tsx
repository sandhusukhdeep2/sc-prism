import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '../lib/settings'
import {
  deleteVaultFile,
  findBacklinks,
  isNative,
  listVaultTree,
  readVaultFile,
  resolveVaultDir,
  writeVaultNote,
} from '../lib/nativeEngine'
import {
  useVault,
  list as simList,
  read as simRead,
  write as simWrite,
  create as simCreate,
  remove as simRemove,
} from '../lib/vault'
import './Vault.css'
import Icon from '../components/Icon'
import PageHead from '../components/PageHead'

// ---------------------------------------------------------------------------
// Minimal inline markdown renderer (no npm dependency).
// ---------------------------------------------------------------------------

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /`([^`]+)`/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <code key={`c${key++}`} className="md__icode mono">
        {m[1]}
      </code>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  const isList = (s: string): boolean => /^\s*-\s+/.test(s)
  const isHeading = (s: string): boolean => /^#{1,3}\s+/.test(s)
  const isFence = (s: string): boolean => s.trimStart().startsWith('```')

  while (i < lines.length) {
    const line = lines[i]

    if (isFence(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++
      blocks.push(
        <pre key={`b${key++}`} className="md__code mono">
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const inner = renderInline(h[2])
      if (level === 1) blocks.push(<h1 key={`b${key++}`} className="md__h1">{inner}</h1>)
      else if (level === 2) blocks.push(<h2 key={`b${key++}`} className="md__h2">{inner}</h2>)
      else blocks.push(<h3 key={`b${key++}`} className="md__h3">{inner}</h3>)
      i++
      continue
    }

    if (isList(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && isList(lines[i])) {
        const t = lines[i].replace(/^\s*-\s+/, '')
        items.push(
          <li key={`li${items.length}`} className="md__li">
            {renderInline(t)}
          </li>,
        )
        i++
      }
      blocks.push(
        <ul key={`b${key++}`} className="md__ul">
          {items}
        </ul>,
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isList(lines[i]) &&
      !isHeading(lines[i]) &&
      !isFence(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`b${key++}`} className="md__p">
        {renderInline(buf.join(' '))}
      </p>,
    )
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Tree built from flat relative paths
// ---------------------------------------------------------------------------

interface Node {
  name: string
  path: string
  type: 'file' | 'folder'
  children: Node[]
}

function buildTree(paths: string[]): Node[] {
  const root: Node[] = []
  for (const p of paths) {
    const parts = p.split('/')
    let level = root
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      const isFile = i === parts.length - 1
      let node = level.find((n) => n.name === parts[i] && (n.type === 'file') === isFile)
      if (!node) {
        node = { name: parts[i], path: acc, type: isFile ? 'file' : 'folder', children: [] }
        level.push(node)
      }
      level = node.children
    }
  }
  const sortRec = (nodes: Node[]) => {
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name),
    )
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(root)
  return root
}

// Resolve an outgoing link token (a [[wiki]] name or a (path.md) target) to a
// real vault path, or null when nothing matches (an honest dangling link).
// Tries an exact path, then the `.md`-suffixed path, then a filename-stem match
// so `[[uploader]]` finds `notes/uploader.md`.
function resolveOutgoing(token: string, paths: string[]): string | null {
  const t = token.trim()
  if (!t) return null
  if (paths.includes(t)) return t
  const withMd = t.endsWith('.md') ? t : `${t}.md`
  if (paths.includes(withMd)) return withMd
  const stem = (t.endsWith('.md') ? t.slice(0, -3) : t).toLowerCase()
  return (
    paths.find((p) => {
      const file = p.split('/').pop() ?? p
      return file.toLowerCase().replace(/\.md$/, '') === stem
    }) ?? null
  )
}

type TreeProps = {
  nodes: Node[]
  depth: number
  active: string
  collapsed: Set<string>
  onSelect: (path: string) => void
  onToggle: (path: string) => void
}

function Tree({ nodes, depth, active, collapsed, onSelect, onToggle }: TreeProps) {
  return (
    <>
      {nodes.map((node) => {
        const pad = { paddingLeft: 10 + depth * 16 }
        if (node.type === 'folder') {
          const open = !collapsed.has(node.path)
          return (
            <div key={node.path}>
              <button
                type="button"
                className="vault__folder"
                style={pad}
                aria-expanded={open}
                onClick={() => onToggle(node.path)}
              >
                <span className="vault__caret">{open ? '▾' : '▸'}</span> {node.name}
              </button>
              {open && (
                <Tree
                  nodes={node.children}
                  depth={depth + 1}
                  active={active}
                  collapsed={collapsed}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              )}
            </div>
          )
        }
        const isActive = node.path === active
        return (
          <button
            key={node.path}
            type="button"
            className={`vault__file${isActive ? ' vault__file--active' : ''}`}
            style={pad}
            onClick={() => onSelect(node.path)}
          >
            {node.name}
          </button>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Page — REAL vault on disk when native; the browser demo keeps the sim store.
// ---------------------------------------------------------------------------

type Status = { type: 'idle' } | { type: 'saved' } | { type: 'error'; reason: string }

export default function Vault() {
  const native = isNative()
  const { settings } = useSettings()
  const simStore = useVault() // browser fallback only

  const [vaultDir, setVaultDir] = useState('')
  const [paths, setPaths] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState<string | null>(null)
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [isNew, setIsNew] = useState(false)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<Status>({ type: 'idle' })
  const [loading, setLoading] = useState(native)
  // Inline "new note" row (replaces the old window.prompt) + two-step delete
  // confirm (replaces the old window.confirm) — both are in-app affordances.
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // ---- load the real tree (native) or the sim store (browser) ----
  const refresh = useCallback(async () => {
    if (!native) {
      setPaths(simList())
      return
    }
    const dir = await resolveVaultDir(settings.vaultPath)
    setVaultDir(dir)
    setPaths(await listVaultTree(dir))
    setLoading(false)
  }, [native, settings.vaultPath])

  useEffect(() => {
    void refresh()
  }, [refresh, simStore])

  // First file auto-selected once the tree lands.
  useEffect(() => {
    if (!selected && paths.length > 0) setSelected(paths[0])
  }, [paths, selected])

  // ---- load the selected file + its REAL backlinks ----
  useEffect(() => {
    if (!selected) {
      setContent(null)
      setBacklinks([])
      return
    }
    let cancelled = false
    if (!native) {
      setContent(simRead(selected))
      setBacklinks([])
      return
    }
    void (async () => {
      const [text, links] = await Promise.all([
        readVaultFile(vaultDir, selected),
        findBacklinks(vaultDir, selected),
      ])
      if (cancelled) return
      setContent(text)
      setBacklinks(links)
    })()
    return () => {
      cancelled = true
    }
  }, [selected, native, vaultDir])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths
  }, [paths, query])
  const nodes = useMemo(() => buildTree(filtered), [filtered])

  // Outgoing [[wiki]] + (path.md) links parsed from the OPEN file — real graph.
  // Keep the FULL set so the "{n} out — scanned live" label counts every link;
  // the render list is capped separately (with a "+N more") so the count can't
  // silently undercount a note that links to more than the cap.
  const outgoing = useMemo(() => {
    if (!content) return []
    const found = new Set<string>()
    for (const m of content.matchAll(/\[\[([^\]|#]+)/g)) found.add(m[1].trim())
    for (const m of content.matchAll(/\(([^)\s]+\.md)\)/g)) found.add(m[1].trim())
    return [...found]
  }, [content])
  const OUTGOING_RENDER_CAP = 6
  const outgoingShown = outgoing.slice(0, OUTGOING_RENDER_CAP)
  const outgoingMore = outgoing.length - outgoingShown.length

  const exists = content !== null

  function selectFile(path: string) {
    setSelected(path)
    setEditing(false)
    setIsNew(false)
    setConfirmDelete(false)
    setStatus({ type: 'idle' })
  }

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function startEdit() {
    setDraft(content ?? '')
    setEditing(true)
    setStatus({ type: 'idle' })
  }

  function cancelEdit() {
    setEditing(false)
    setStatus({ type: 'idle' })
    if (isNew) {
      setIsNew(false)
      setSelected(paths[0] ?? '')
    }
  }

  async function save() {
    if (native) {
      if (!selected.endsWith('.md')) {
        setStatus({ type: 'error', reason: 'vault files must end in .md' })
        return
      }
      const path = await writeVaultNote(vaultDir, selected, draft)
      if (path) {
        setContent(draft)
        setEditing(false)
        setIsNew(false)
        setStatus({ type: 'saved' })
        void refresh()
      } else {
        setStatus({ type: 'error', reason: 'write failed (path outside the vault?)' })
      }
      return
    }
    const result = isNew ? simCreate(selected, draft) : simWrite(selected, draft)
    if (result.ok) {
      setEditing(false)
      setIsNew(false)
      setStatus({ type: 'saved' })
    } else {
      setStatus({ type: 'error', reason: result.reason })
    }
  }

  // Open the inline new-note row, pre-filled with the CURRENT folder so a new
  // note lands beside the one you're reading (type just the filename).
  function openNewFile() {
    const folder = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/') + 1) : ''
    setNewFileName(folder)
    setNewFileOpen(true)
  }

  function submitNewFile() {
    const clean = newFileName.trim()
    if (clean === '' || clean.endsWith('/')) return // needs an actual filename
    const path = clean.endsWith('.md') ? clean : `${clean}.md`
    setSelected(path)
    setIsNew(true)
    setEditing(true)
    setDraft('')
    setContent(null)
    setStatus({ type: 'idle' })
    setNewFileOpen(false)
    setNewFileName('')
  }

  function cancelNewFile() {
    setNewFileOpen(false)
    setNewFileName('')
  }

  async function deleteFile() {
    if (!exists) return
    if (native) {
      const err = await deleteVaultFile(vaultDir, selected)
      if (err) {
        setStatus({ type: 'error', reason: err })
        return
      }
      await refresh()
      setSelected('')
    } else {
      simRemove(selected)
      setSelected(simList()[0] ?? '')
    }
    setEditing(false)
    setConfirmDelete(false)
    setStatus({ type: 'idle' })
  }

  const crumb = selected || '—'
  const fileCount = paths.length

  return (
    <div className="vault">
      {/* header */}
      <PageHead
        title="Your"
        em="vault"
        hint={
          native ? (
            <>
              {vaultDir || '…'} · {fileCount} markdown {fileCount === 1 ? 'file' : 'files'} ·
              every write validated
            </>
          ) : (
            <>browser demo store · {fileCount} files</>
          )
        }
        actions={
          <>
            <button type="button" className="vault__new" onClick={openNewFile}>
              <Icon name="plus" size={14} />
              New file
            </button>
            <span className="vault__search">
              {/* Was a hand-rolled SVG with a hardcoded #8a877e — an amber-era
                  colour the v2 system retired, which meant it could not invert
                  on the dark themes. It takes currentColor from the set now. */}
              <Icon name="search" size={13} />
              <input
                className="vault__searchinput mono"
                value={query}
                placeholder="Filter files…"
                aria-label="Filter files"
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
          </>
        }
      />

      {/* three regions */}
      <div className="vault__regions">
        {/* LEFT tree */}
        <div className="vault__tree mono">
          {newFileOpen && (
            <form
              className="vault__newrow"
              onSubmit={(e) => {
                e.preventDefault()
                submitNewFile()
              }}
            >
              <input
                className="vault__newinput mono"
                value={newFileName}
                autoFocus
                placeholder="folder/name.md"
                aria-label="New note path"
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelNewFile()
                }}
              />
            </form>
          )}
          {loading ? (
            <div className="vault__treenote">reading your vault…</div>
          ) : nodes.length === 0 ? (
            <div className="vault__treenote">
              {query ? 'no files match the filter' : 'vault is empty — create the first note'}
            </div>
          ) : (
            <Tree
              nodes={nodes}
              depth={0}
              active={selected}
              collapsed={collapsed}
              onSelect={selectFile}
              onToggle={toggleFolder}
            />
          )}
          <div className="vault__treenote">
            indexes are derived &amp; regenerable · L3 of{' '}
            <Link to="/memory" className="vault__treelink">
              memory ›
            </Link>
          </div>
        </div>

        {/* CENTER rendered md / editor */}
        <div className="vault__doc">
          <div className="vault__docbar">
            <span className="vault__crumb mono">{crumb}</span>
            {!editing && exists && <span className="vault__validated">on disk ✓</span>}
            {isNew && <span className="vault__draft mono">new file · unsaved</span>}
            <span className="vault__spacer" />
            {editing ? (
              <>
                <button type="button" className="vault__edit" onClick={() => void save()}>
                  Save
                </button>
                <button type="button" className="vault__ghost" onClick={cancelEdit}>
                  Cancel
                </button>
              </>
            ) : confirmDelete ? (
              <>
                <span className="vault__delq mono">Delete “{selected}”?</span>
                <button
                  type="button"
                  className="vault__edit vault__edit--danger"
                  onClick={() => void deleteFile()}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="vault__ghost"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="vault__edit" onClick={startEdit} disabled={!exists}>
                  Edit
                </button>
                <button
                  type="button"
                  className="vault__ghost"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!exists}
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {status.type === 'error' && (
            <div className="vault__error">✕ rejected — {status.reason}</div>
          )}

          <div className="vault__docbody">
            {editing ? (
              <textarea
                className="vault__editor mono"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                placeholder="# Title&#10;&#10;Write markdown here…"
              />
            ) : exists ? (
              <div className="md">{renderMarkdown(content ?? '')}</div>
            ) : (
              <p className="vault__p">
                {selected ? 'Could not read this file.' : 'No file selected.'}
              </p>
            )}
          </div>
        </div>

        {/* RIGHT — REAL backlinks + link graph of the open note */}
        <div className="vault__side">
          <div className="vault__panel">
            <div className="vault__kicker">Backlinks</div>
            <div className="vault__links mono">
              {backlinks.length === 0 ? (
                <div className="vault__link vault__link--dim">no files link here yet</div>
              ) : (
                backlinks.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className="vault__link vault__link--btn"
                    onClick={() => selectFile(b)}
                  >
                    <span className="vault__dot" />
                    {b}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="vault__panel vault__panel--grow">
            <div className="vault__kicker">Links from this note</div>
            <div className="vault__links mono">
              {outgoing.length === 0 ? (
                <div className="vault__link vault__link--dim">no outgoing links</div>
              ) : (
                <>
                  {outgoingShown.map((o) => {
                    const target = resolveOutgoing(o, paths)
                    return target ? (
                      <button
                        key={o}
                        type="button"
                        className="vault__link vault__link--btn"
                        onClick={() => selectFile(target)}
                      >
                        <span className="vault__dot" />
                        {o}
                      </button>
                    ) : (
                      <div
                        key={o}
                        className="vault__link vault__link--dim"
                        title="no matching note in your vault (dangling link)"
                      >
                        <span className="vault__dot" />º {o}
                      </div>
                    )
                  })}
                  {outgoingMore > 0 && (
                    <div className="vault__link vault__link--dim">+{outgoingMore} more</div>
                  )}
                </>
              )}
            </div>
            <div className="vault__graphnote">
              {backlinks.length} in · {outgoing.length} out — scanned live from your vault
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
