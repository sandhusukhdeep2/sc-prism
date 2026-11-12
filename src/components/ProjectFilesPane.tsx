// ProjectFilesPane — the project's folder, read beside the chat (2026-11-12).
//
// The Files tab of the room pane. The owner's reference was a files pane with
// a filterable list on one side and a reader on the other; this is that, for
// the folder the project really has. The list is the Rust walk the room has
// always used (capped, dotfiles skipped, symlinks never followed) and the
// reader shows what is on disk right now — read when a file is picked, never
// from memory of a run.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  expandUserPath,
  listProjectFiles,
  readTextFile,
  revealPath,
  type ProjectFileMeta,
} from '../lib/nativeEngine'
import './ProjectFilesPane.css'

const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

type Read = { state: 'none' } | { state: 'loading' } | { state: 'text'; text: string } | { state: 'unreadable' }

export default function ProjectFilesPane({
  path,
  refreshKey,
}: {
  /** The project's folder, as the project stores it (may start with `~`). */
  path: string
  /** Changes whenever the folder may have changed (a step finished, a run
   *  ended) — the list is read again. */
  refreshKey: string
}) {
  const [dir, setDir] = useState('')
  const [files, setFiles] = useState<ProjectFileMeta[] | null>(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState('')
  const [read, setRead] = useState<Read>({ state: 'none' })

  useEffect(() => {
    let live = true
    void (async () => {
      const abs = await expandUserPath(path)
      const list = await listProjectFiles(abs)
      if (!live) return
      setDir(abs)
      setFiles(list.filter((f) => !f.dir))
    })().catch(() => {
      if (live) setFiles([])
    })
    return () => {
      live = false
    }
  }, [path, refreshKey])

  // Read the picked file again whenever the folder may have changed, so the
  // reader never shows a version a run has since rewritten.
  useEffect(() => {
    if (!open || !dir) return
    let live = true
    setRead({ state: 'loading' })
    void readTextFile(`${dir}/${open}`).then((text) => {
      if (!live) return
      setRead(text === null ? { state: 'unreadable' } : { state: 'text', text })
    })
    return () => {
      live = false
    }
  }, [open, dir, refreshKey])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = files ?? []
    return q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list
  }, [files, filter])

  if (files === null) return <p className="files__note">Reading the folder…</p>
  if (files.length === 0) return <p className="files__note">This folder has no files yet.</p>

  return (
    <div className="files">
      <div className="files__reader" aria-live="polite">
        {open ? (
          <>
            <div className="files__readerhead">
              <span className="files__open mono" title={open}>
                {open}
              </span>
              <button type="button" className="files__act" onClick={() => void revealPath(`${dir}/${open}`)}>
                Reveal in Finder
              </button>
              <Link className="files__act" to={`/editor?file=${encodeURIComponent(open)}`}>
                Open in the editor
              </Link>
            </div>
            {read.state === 'loading' && <p className="files__note">Reading…</p>}
            {read.state === 'unreadable' && (
              <p className="files__note">This file could not be read as text.</p>
            )}
            {read.state === 'text' && <pre className="files__text mono">{read.text}</pre>}
          </>
        ) : (
          <p className="files__note">Pick a file to read it here.</p>
        )}
      </div>
      <div className="files__list">
        <input
          type="search"
          className="files__filter"
          placeholder="Filter"
          aria-label="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="files__count">
          {files.length} file{files.length === 1 ? '' : 's'}
        </div>
        <ul className="files__items">
          {shown.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={'files__item mono' + (f.path === open ? ' is-on' : '')}
                aria-label={f.path}
                aria-current={f.path === open ? 'true' : undefined}
                title={`${f.path} · ${size(f.size)}`}
                onClick={() => setOpen(f.path)}
              >
                <span className="files__dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}</span>
                <span className="files__name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="files__note">No file matches “{filter}”.</li>}
        </ul>
      </div>
    </div>
  )
}
