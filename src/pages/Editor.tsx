import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, UIEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import AgentCard from '../components/AgentCard'
import { useApp } from '../store/AppStore'
import { activeRuns } from '../lib/liveRuns'
import { useSettings } from '../lib/settings'
import {
  expandUserPath,
  isNative,
  listProjectFiles,
  listVaultTree,
  openPath,
  readTextFile,
  readVaultFile,
  resolveVaultDir,
  revealPath,
  writeProjectFile,
  writeVaultNote,
} from '../lib/nativeEngine'
import { getProjects } from '../lib/projects'
import { useVault, list as simList, read as simRead, write as simWrite } from '../lib/vault'
import './Editor.css'

// The Editor tab of the Workspace — edits the REAL vault on disk when native
// (same folder the engine reads/writes and Obsidian sees); the browser demo
// keeps the sim store. Diff gutter marks changed lines against the saved copy.

type Status = { type: 'idle' } | { type: 'saved' } | { type: 'error'; reason: string }

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export default function Editor() {
  const native = isNative()
  const { state } = useApp()
  const { settings } = useSettings()
  const simStore = useVault() // browser fallback only
  const [params, setParams] = useSearchParams()

  const [vaultDir, setVaultDir] = useState('')
  const [files, setFiles] = useState<string[]>([])
  // PROJECT MODE (2026-08-31, his ask: "open up a project like Visual Studio
  // — all files, and I can edit"). When a project room is active, the Editor
  // shows THAT project's whole tree (all types, not just .md) in a real file
  // column; reads are absolute; saves go through write_project_file, whose
  // Rust side enforces containment. The Vault mode stays one click away.
  const activeProject = getProjects().projects.find((p) => p.id === state.activeProjectId)
  const [mode, setMode] = useState<'project' | 'vault'>(activeProject ? 'project' : 'vault')
  const [projDir, setProjDir] = useState('')
  const projectMode = mode === 'project' && !!activeProject && native
  const [selected, setSelected] = useState('')
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<Status>({ type: 'idle' })
  const gutterRef = useRef<HTMLDivElement>(null)

  // ---- load the real file list (native) or the sim store (browser) ----
  const refresh = useCallback(async () => {
    if (!native) {
      setFiles(simList())
      return
    }
    if (projectMode && activeProject) {
      const dir = await expandUserPath(activeProject.path)
      setProjDir(dir)
      const metas = await listProjectFiles(dir)
      setFiles(metas.filter((f) => !f.dir).map((f) => f.path))
      return
    }
    const dir = await resolveVaultDir(settings.vaultPath)
    setVaultDir(dir)
    setFiles(await listVaultTree(dir))
  }, [native, settings.vaultPath, projectMode, activeProject])

  useEffect(() => {
    void refresh()
  }, [refresh, simStore])

  // Switching mode (or room) invalidates the selection — the same rel path
  // means a different file in the other tree.
  useEffect(() => {
    setSelected('')
    setSaved('')
    setDraft('')
  }, [mode, activeProject?.id])

  // Initial selection: ?file= param (from Vault/Workspace links) else first.
  useEffect(() => {
    if (selected || files.length === 0) return
    const want = params.get('file')
    setSelected(want && files.includes(want) ? want : files[0])
  }, [files, selected, params])

  // Load the selected file's saved content.
  useEffect(() => {
    if (!selected) {
      setSaved('')
      setDraft('')
      return
    }
    let cancelled = false
    void (async () => {
      const text = !native
        ? simRead(selected)
        : projectMode
          ? await readTextFile(`${projDir}/${selected}`)
          : await readVaultFile(vaultDir, selected)
      if (cancelled) return
      setSaved(text ?? '')
      setDraft(text ?? '')
      setStatus({ type: 'idle' })
    })()
    return () => {
      cancelled = true
    }
  }, [selected, native, vaultDir])

  const dirty = draft !== saved
  const draftLines = useMemo(() => (draft.length === 0 ? [''] : draft.split('\n')), [draft])
  const savedLines = useMemo(() => saved.split('\n'), [saved])
  // Real diff stats vs the saved copy.
  const changedCount = useMemo(
    () => draftLines.filter((l, i) => l !== (savedLines[i] ?? null)).length,
    [draftLines, savedLines],
  )
  const addedLines = Math.max(0, draftLines.length - savedLines.length)
  const removedLines = Math.max(0, savedLines.length - draftLines.length)

  function selectFile(e: ChangeEvent<HTMLSelectElement>) {
    const path = e.target.value
    setSelected(path)
    setParams(path ? { file: path } : {}, { replace: true })
  }

  function editDraft(e: ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value)
    setStatus({ type: 'idle' })
  }

  function revert() {
    setDraft(saved)
    setStatus({ type: 'idle' })
  }

  async function save() {
    if (selected === '') return
    if (native) {
      const path = projectMode
        ? await writeProjectFile(projDir, selected, draft)
        : await writeVaultNote(vaultDir, selected, draft)
      if (path) {
        setSaved(draft)
        setStatus({ type: 'saved' })
      } else {
        setStatus({
          type: 'error',
          reason: projectMode
            ? 'write failed (path escapes the project?)'
            : 'write failed (path outside the vault?)',
        })
      }
      return
    }
    const result = simWrite(selected, draft)
    setStatus(result.ok ? { type: 'saved' } : { type: 'error', reason: result.reason })
    if (result.ok) setSaved(draft)
  }

  // Keep the line-number gutter aligned with the textarea when it scrolls.
  function syncScroll(e: UIEvent<HTMLTextAreaElement>) {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
  }

  // Live agent card: only when something is actually running. This used to read
  // the store's old live-agent slice — only the SIMULATOR ever wrote it, so on a
  // native install the card was unreachable and this column claimed "idle"
  // through every real run (2026-08-16 Finding 1). It now reads the store's ONE
  // live-run truth, minus runs parked on a human answer. The Editor keeps no
  // span tail, so it passes NO orbs: the card then names the run's kind rather
  // than guessing a role, and says no model call has been reported to it.
  const liveRun = activeRuns(state.liveRuns)[0]

  const crumb =
    selected === ''
      ? basename(vaultDir) || 'vault'
      : `${basename(vaultDir) || 'vault'} ▸ ${selected.split('/').join(' ▸ ')}`

  return (
    <div className="ed">
      {/* editor card */}
      <div className="ed__main">
        <div className="ed__tabs">
          <Link to="/" className="ed__tab">Chat</Link>
          <span className="ed__tab is-active">
            Editor: <span className="mono ed__tabfile">{basename(selected) || 'untitled'}</span>
          </span>
          <span className="ed__spacer" />
          <span className="mono ed__crumb">{crumb}</span>
        </div>

        {/* action row */}
        <div className="ed__actions">
          {activeProject && native && (
            <div className="ed__modes" role="tablist" aria-label="Editor scope">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'project'}
                className={'ed__modebtn mono' + (mode === 'project' ? ' is-active' : '')}
                onClick={() => setMode('project')}
              >
                {activeProject.name || 'project'}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'vault'}
                className={'ed__modebtn mono' + (mode === 'vault' ? ' is-active' : '')}
                onClick={() => setMode('vault')}
              >
                vault
              </button>
            </div>
          )}
          <label className="ed__picker">
            <span className="ed__pickerlabel">File</span>
            <select
              className="ed__select mono"
              value={selected}
              onChange={selectFile}
              disabled={files.length === 0}
            >
              {files.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ed__btn ed__btn--accept"
            onClick={() => void save()}
            disabled={!dirty || selected === ''}
          >
            Save
          </button>
          <button
            type="button"
            className="ed__btn ed__btn--revert"
            onClick={revert}
            disabled={!dirty}
          >
            Revert
          </button>
          {/* His ask (2026-08-31): whatever the system can open, one click
              opens it there — html in the browser, images/logos in Preview.
              Works in both scopes; disabled with no selection. */}
          <button
            type="button"
            className="ed__btn ed__btn--ghost ed__btn--quiet"
            disabled={selected === ''}
            title="open in the default app — browser for html, Preview for images"
            onClick={() => {
              const abs = `${projectMode ? projDir : vaultDir}/${selected}`
              void openPath(abs)
            }}
          >
            Preview
          </button>
          <button
            type="button"
            className="ed__btn ed__btn--ghost ed__btn--quiet"
            disabled={selected === ''}
            aria-label="Reveal in Finder"
            title="reveal in Finder"
            onClick={() => {
              const abs = `${projectMode ? projDir : vaultDir}/${selected}`
              void revealPath(abs)
            }}
          >
            ↗
          </button>
          <Link to="/vault" className="ed__btn ed__btn--ghost">Open in Vault</Link>
          <span className="ed__spacer" />
          {status.type === 'saved' ? (
            <span className="mono ed__status ed__status--ok">
              <i className="ed__statusdot" />✓ saved to disk
            </span>
          ) : status.type === 'error' ? (
            <span className="mono ed__status ed__status--err">✕ rejected — {status.reason}</span>
          ) : dirty ? (
            <span className="mono ed__status ed__status--dirty">● unsaved changes</span>
          ) : (
            <span className="mono ed__status ed__status--ok">
              <i className="ed__statusdot" />in sync with vault
            </span>
          )}
        </div>

        {/* code — editable, with a synced line-number + diff gutter. In
            project mode a real file column sits beside it (his ask: "like
            Visual Studio — all files, and I can edit"). */}
        <div className={'ed__work' + (projectMode ? ' ed__work--tree' : '')}>
          {projectMode && (
            <nav className="ed__tree mono" aria-label="Project files">
              {files.length === 0 && <div className="ed__treeempty">no files yet</div>}
              {files.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={'ed__treefile' + (selected === f ? ' is-active' : '')}
                  onClick={() => {
                    setSelected(f)
                    setParams({ file: f }, { replace: true })
                  }}
                >
                  {f}
                </button>
              ))}
            </nav>
          )}
        <div className="ed__code mono">
          <div className="ed__gutter" ref={gutterRef} aria-hidden="true">
            {draftLines.map((l, i) => {
              const changed = l !== (savedLines[i] ?? null)
              return (
                <div key={i} className={'code__ln' + (changed ? ' code__ln--diff' : '')}>
                  {i + 1}
                </div>
              )
            })}
          </div>
          <textarea
            className="ed__textarea code__txt mono"
            value={draft}
            onChange={editDraft}
            onScroll={syncScroll}
            spellCheck={false}
            placeholder={selected === '' ? 'The vault is empty.' : '# Write here…'}
            disabled={selected === ''}
          />
        </div>
        </div>
      </div>

      {/* right column */}
      <aside className="ed__side">
        {liveRun ? (
          <AgentCard run={liveRun} orbs={[]} />
        ) : (
          <div className="change">
            <div className="change__kicker">Agents</div>
            <div className="change__rows mono">
              <div className="change__row">
                <span className="change__v">idle — nothing running right now</span>
              </div>
            </div>
          </div>
        )}

        <div className="change">
          <div className="change__kicker">This change</div>
          <div className="change__rows mono">
            <div className="change__row">
              <span className="change__k">file</span>
              <span className="change__v">{basename(selected) || '—'}</span>
            </div>
            <div className="change__row">
              <span className="change__k">changed</span>
              <span className="change__v">
                {dirty
                  ? `${changedCount} line${changedCount === 1 ? '' : 's'}${addedLines ? ` · +${addedLines}` : ''}${removedLines ? ` · −${removedLines}` : ''}`
                  : 'none'}
              </span>
            </div>
            <div className="change__row">
              <span className="change__k">size</span>
              <span className="change__v">{draftLines.length} lines · {draft.length} chars</span>
            </div>
            <div className="change__row">
              <span className="change__k">state</span>
              {status.type === 'error' ? (
                <span className="change__err">rejected</span>
              ) : status.type === 'saved' ? (
                <span className="change__ok">✓ saved</span>
              ) : dirty ? (
                <span className="change__v">unsaved</span>
              ) : (
                <span className="change__v">in sync</span>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}
