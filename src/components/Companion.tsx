import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { guardAnswerText } from '../lib/answerText'
import { pages } from '../lib/nav'
import { primaryDisplayName, useSettings } from '../lib/settings'
import { isNative, resolveVaultDir, runNativeTask } from '../lib/nativeEngine'
import { buildEngineProviders, isRealCompletion, useApp, type Notice } from '../store/AppStore'
import './Companion.css'
import Icon from './Icon'

// Kind → glyph shown next to each notice, in both the panel list and toast.
const NOTICE_ICON: Record<Notice['kind'], string> = {
  done: '✓',
  attention: '⚠',
  request: '?',
}

// How long a transient toast stays up before auto-hiding.
const TOAST_MS = 6000

// Route-specific copy: a short display name + a relevant tip for the current page.
const contexts: Record<string, { name: string; tip: string }> = {
  '/console': { name: 'Console', tip: 'I can explain any metric' },
  '/automations': { name: 'Automations', tip: 'I show every piece of work that repeats on a timer' },
  '/vault': { name: 'Vault', tip: 'ask about any file' },
}

const DEFAULT_TIP = 'ask me anything about this task'

type Message = { id: number; from: 'ai' | 'user'; text: string }

// Page-relevant quick prompts — each one is a REAL question sent to the
// primary (no canned replies).
const promptsByRoute: Record<string, string[]> = {
  '/console': ['Explain what the Console metrics mean', 'What should I watch for on this dashboard?'],
  '/automations': ['Explain how standing jobs and loops work here', 'When should I use a standing loop?'],
  '/vault': ['How should I organize my vault?', 'What does the engine write into the vault?'],
  '/agents': ['How do teams of agents work here?', 'Which model should each agent run on?'],
  '/stats': ['How do I read these cost charts?'],
  '/memory': ['Explain the three memory tiers'],
}

const DEFAULT_PROMPTS = ['What can you do for me?', 'Explain the last verdict in plain words']

function contextName(pathname: string): string {
  const ctx = contexts[pathname]
  if (ctx) return ctx.name
  const page = pages.find((p) => p.to === pathname)
  if (page) return page.title.split('·')[0].trim()
  return 'this page'
}

// The persistent, context-aware Companion dock — bottom-right on every page.
// The panel is a REAL mini-chat with your primary: questions run through the
// engine (charter + governance included); it narrates, it never acts (ADR-007).
export default function Companion({ label }: { label?: string }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const { state, clearNotice } = useApp()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const nextId = useRef(0)
  const closeRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Transient toast for the newest project notice — shown near the orb on
  // ANY page regardless of whether the panel is open. Purely a local "have I
  // shown this one yet" affordance: dismissing/auto-hiding the toast never
  // touches the underlying notice (the badge count + panel list still own
  // that until the user explicitly jumps or the driver clears it).
  const [toast, setToast] = useState<Notice | null>(null)
  // EVERY id ever toasted, not just the last one — tracking only the newest
  // id would re-toast an older notice when clearing the newest makes the
  // older one the last array element again.
  const toastedIds = useRef<Set<string>>(new Set())
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const newest = state.notices[state.notices.length - 1]
    if (!newest || toastedIds.current.has(newest.id)) return
    toastedIds.current.add(newest.id)
    setToast(newest)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [state.notices])

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // Jump to where the notice's subject actually is, and acknowledge it in one
  // action. A project notice deep-links straight to its OWN project (not just
  // the list); a notice that carries its own destination (`to` — a finished
  // manager job points at Automations, where that job's real run record and
  // next due time are) goes there instead, so "View" never lands on a page
  // that has nothing to do with the line the user just read.
  function jumpToNotice(n: Notice): void {
    clearNotice(n.id)
    navigate(n.to ?? `/projects?open=${encodeURIComponent(n.projectId)}`)
  }

  // Toast click: same deep link as the panel's View action, but the toast is
  // a purely transient "have I shown this yet" affordance (see the comment on
  // `toast` above) — clicking it dismisses the toast ONLY, it never clears
  // the underlying notice (the panel action owns that).
  function jumpToToast(n: Notice): void {
    setToast(null)
    navigate(`/projects?open=${encodeURIComponent(n.projectId)}`)
  }

  const ctx = contexts[pathname]
  const page = pages.find((p) => p.to === pathname)
  const name = contextName(pathname)
  const prompts = promptsByRoute[pathname] ?? DEFAULT_PROMPTS
  const companion = primaryDisplayName(settings)

  const derived = ctx
    ? `On ${ctx.name} — ${ctx.tip}`
    : page
      ? `On ${page.title.split('·')[0].trim()} — ${DEFAULT_TIP}`
      : label ?? 'Ask me anything about this task'

  // Fresh greeting whenever the panel opens on a new route.
  useEffect(() => {
    if (!open) return
    nextId.current = 1
    setMessages([{ id: 0, from: 'ai', text: `${derived}.` }])
  }, [open, pathname, derived])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  function append(from: Message['from'], text: string) {
    const id = nextId.current
    nextId.current += 1
    setMessages((prev) => [...prev, { id, from, text }])
  }

  // REAL ask: the question runs through the engine to the primary.
  async function ask(text: string) {
    append('user', text)
    if (!isNative()) {
      append('ai', 'Real answers need the installed app — in the browser demo I can only point you around.')
      return
    }
    const { providers, primaryReal } = buildEngineProviders(settings)
    if (!primaryReal) {
      append('ai', 'No primary AI is connected — set one up in Settings → Providers and I can answer for real.')
      return
    }
    setThinking(true)
    try {
      const vault = await resolveVaultDir(settings.vaultPath)
      const verdict = await Promise.race([
        runNativeTask(
          `[COMPANION DOCK] The user is on the "${name}" page of SC Prism and asked: ${text}\nAnswer helpfully in under 120 words, plain text.`,
          vault,
          providers,
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
      ])
      if (verdict && isRealCompletion(verdict.response)) {
        // CHAT TURN (companion dock): the same tool_call guard the Work chat
        // applies — a dock reply is a chat message like any other.
        append('ai', guardAnswerText(verdict.response))
      } else {
        append('ai', `Couldn't reach ${companion} just now — try again in a moment.`)
      }
    } finally {
      setThinking(false)
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || thinking) return
    setDraft('')
    void ask(text)
  }

  return (
    <div className="companion">
      {open && (
        <div className="companion__panel" role="dialog" aria-label="Companion assist panel">
          <div className="companion__phead">
            <span className="companion__avatar" aria-hidden="true" />
            <span className="companion__name">{companion}</span>
            <span className="companion__spacer" />
            <button
              ref={closeRef}
              type="button"
              className="companion__x"
              aria-label="Close Companion panel"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={15} />
            </button>
          </div>

          <span className="companion__ctx mono">Context: {name}</span>

          {state.notices.length > 0 && (
            <div className="companion__notices">
              <span className="companion__noticeshead mono">Notices</span>
              {state.notices
                .slice()
                .reverse()
                .map((n) => (
                  <div key={n.id} className={`companion__notice companion__notice--${n.kind}`}>
                    <span className="companion__noticeicon" aria-hidden="true">
                      {NOTICE_ICON[n.kind]}
                    </span>
                    <span className="companion__noticetext">{n.text}</span>
                    <button
                      type="button"
                      className="companion__noticejump"
                      onClick={() => jumpToNotice(n)}
                    >
                      View →
                    </button>
                  </div>
                ))}
            </div>
          )}

          <div className="companion__transcript" ref={scrollRef}>
            {messages.map((m) => (
              <div key={m.id} className={`companion__bubble companion__bubble--${m.from}`}>
                {m.text}
              </div>
            ))}
            {thinking && (
              <div className="companion__bubble companion__bubble--ai mono">
                {companion} is thinking…
              </div>
            )}
          </div>

          <div className="companion__chips">
            {prompts.map((p) => (
              <button
                key={p}
                type="button"
                className="companion__chip"
                disabled={thinking}
                onClick={() => void ask(p)}
              >
                {p}
              </button>
            ))}
          </div>

          <form className="companion__ask" onSubmit={onSubmit}>
            <input
              className="companion__input"
              placeholder={thinking ? `${companion} is thinking…` : 'Ask about this page…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Ask about this page"
            />
            <button type="submit" className="companion__send" aria-label="Send" disabled={thinking}>
              <Icon name="chevron" size={16} className="companion__sendicon" />
            </button>
          </form>

          <div className="companion__foot">I draft; you confirm — nothing runs on its own.</div>
        </div>
      )}

      {toast && !open && (
        <button
          type="button"
          className={`companion__toast companion__toast--${toast.kind}`}
          onClick={() => jumpToToast(toast)}
          aria-label={`Go to ${toast.text}`}
        >
          <span className="companion__toasticon" aria-hidden="true">
            {NOTICE_ICON[toast.kind]}
          </span>
          {toast.text}
        </button>
      )}

      {!open && <div className="companion__label">{derived}</div>}

      <button
        type="button"
        className="companion__orb"
        aria-label={
          state.notices.length > 0
            ? `${open ? 'Close' : 'Open'} Companion — ${state.notices.length} notice${state.notices.length === 1 ? '' : 's'}`
            : open
              ? 'Close Companion'
              : 'Open Companion'
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {state.notices.length > 0 && (
          <span className="companion__badge" aria-hidden="true">
            {state.notices.length}
          </span>
        )}
      </button>
    </div>
  )
}
