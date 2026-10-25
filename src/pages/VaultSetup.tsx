import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { primaryDisplayName, useSettings, type VaultMode } from '../lib/settings'
import { useOnboarding } from '../lib/onboarding'
import {
  detectObsidianVaults,
  isNative,
  pickFolder,
  resolveVaultDir,
  runNativeTask,
} from '../lib/nativeEngine'
import { buildEngineProviders, isRealCompletion } from '../store/AppStore'
import Stepper from '../components/Stepper'
import './VaultSetup.css'

const CTA_LABEL: Record<string, string> = {
  local: 'Use local folder & continue →',
  github: 'Use GitHub repo & continue →',
  both: 'Use both & continue →',
}

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// One message in the setup chat with the co-founder.
interface SetupMsg {
  role: 'user' | 'ai' | 'note'
  text: string
}

// The model proposes setup changes as a trailing machine-readable line;
// CODE applies them (deterministic execution — the model never flips state).
interface SetupAction {
  vaultPath?: string
  vaultMode?: VaultMode
  githubRepo?: string
}

const VAULT_MODES: VaultMode[] = ['local', 'github', 'both']

/** Split a model reply into display text + a validated trailing ACTION. */
function parseAction(raw: string): { display: string; action: SetupAction } {
  const lines = raw.trimEnd().split('\n')
  let actionLine = ''
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    if (t.startsWith('ACTION:')) {
      actionLine = t.slice('ACTION:'.length).trim()
      cut = i
    }
    break
  }
  const display = lines.slice(0, cut).join('\n').trim()
  const action: SetupAction = {}
  if (actionLine) {
    try {
      const parsed = JSON.parse(actionLine) as Record<string, unknown>
      if (typeof parsed.vaultPath === 'string' && parsed.vaultPath.trim().startsWith('/')) {
        action.vaultPath = parsed.vaultPath.trim()
      } else if (typeof parsed.vaultPath === 'string' && parsed.vaultPath.trim().startsWith('~/')) {
        action.vaultPath = parsed.vaultPath.trim()
      }
      if (
        typeof parsed.vaultMode === 'string' &&
        (VAULT_MODES as string[]).includes(parsed.vaultMode)
      ) {
        action.vaultMode = parsed.vaultMode as VaultMode
      }
      if (
        typeof parsed.githubRepo === 'string' &&
        /^[\w.-]+\/[\w.-]+$/.test(parsed.githubRepo.trim())
      ) {
        action.githubRepo = parsed.githubRepo.trim()
      }
    } catch {
      // malformed ACTION → chat text only, nothing applied
    }
  }
  return { display: display || raw.trim(), action }
}

// Onboarding 04 — where the knowledge vault lives. The primary AI chats here
// as the co-founder and its proposed changes are applied by code.
export default function VaultSetup() {
  const { settings, setVault, setGithub } = useSettings()
  const { completeStep, nextRoute, completedSteps, pause } = useOnboarding()
  const navigate = useNavigate()
  const alreadyDone = completedSteps.includes('vault')
  const { vaultPath, vaultMode, githubRepo, githubToken } = settings

  // REAL detection: Obsidian's own registry on this Mac (native only).
  const [obsidianVaults, setObsidianVaults] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    void detectObsidianVaults().then((v) => {
      if (!cancelled) setObsidianVaults(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Setup chat with the co-founder.
  const [freeText, setFreeText] = useState('')
  const [thread, setThread] = useState<SetupMsg[]>([])
  const [asking, setAsking] = useState(false)
  // Messages sent while a reply is pending are QUEUED, never dropped.
  const queueRef = useRef<string[]>([])
  const primaryName = primaryDisplayName(settings)
  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread, asking])

  const say = (msg: SetupMsg) => setThread((t) => [...t, msg])

  // Native folder picker — pointing this at an existing Obsidian vault means
  // SC Prism reads/writes its markdown right where Obsidian sees it.
  const chooseFolder = async () => {
    const picked = await pickFolder('Choose your vault folder (an Obsidian vault works)')
    if (picked) setVault(picked, vaultMode === 'github' ? 'both' : vaultMode)
  }

  const useObsidianVault = (path: string) => {
    setVault(path, vaultMode === 'github' ? 'both' : vaultMode)
  }

  // Apply a validated model-proposed action via the SAME setters the UI uses.
  const applyAction = (a: SetupAction) => {
    const applied: string[] = []
    const nextPath = a.vaultPath ?? vaultPath
    const nextMode = a.vaultMode ?? vaultMode
    if (a.vaultPath || a.vaultMode) {
      setVault(nextPath, nextMode)
      if (a.vaultPath) applied.push(`vault → ${a.vaultPath}`)
      if (a.vaultMode) applied.push(`mode → ${a.vaultMode}`)
    }
    if (a.githubRepo) {
      setGithub(a.githubRepo, githubToken)
      applied.push(`repo → ${a.githubRepo}`)
    }
    if (applied.length) say({ role: 'note', text: `✓ applied: ${applied.join(' · ')}` })
  }

  // Full conversation turn with the REAL primary: transcript + current state +
  // an ACTION protocol so the co-founder can change the setup by proposing it.
  const askPrimary = async (text: string) => {
    if (!isNative()) {
      say({ role: 'ai', text: 'Real AI chat needs the installed app — meanwhile: a folder path, “use my Obsidian vault”, or local / github / both.' })
      return
    }
    const { providers, primaryReal } = buildEngineProviders(settings)
    if (!primaryReal) {
      say({ role: 'ai', text: 'No primary AI is connected yet — finish the Providers step first, or give me a vault instruction.' })
      return
    }
    setAsking(true)
    try {
      const transcript = thread
        .filter((m) => m.role !== 'note')
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'user' : 'you'}: ${m.text}`)
        .join('\n')
      const prompt = [
        '[SETUP CHAT — VAULT STEP] You are chatting live as the user’s co-founder while they set up SC Prism.',
        'Current vault setup:',
        `- vault path: ${vaultPath}`,
        `- vault mode: ${vaultMode} (local | github | both)`,
        `- github repo: ${githubRepo || '(not set)'}`,
        `- Obsidian vaults detected on this Mac: ${obsidianVaults.join(', ') || '(none)'}`,
        '',
        'Reply conversationally in 2-4 short sentences. If (and only if) the user’s message implies changing the vault setup, END your reply with ONE final line exactly of the form:',
        'ACTION: {"vaultPath": "/abs/path", "vaultMode": "local|github|both", "githubRepo": "owner/repo"}',
        'Include only the keys you want to change. No text after the ACTION line.',
        '',
        transcript ? `Conversation so far:\n${transcript}` : 'Conversation so far: (none)',
        `user: ${text}`,
      ].join('\n')

      const vault = await resolveVaultDir(settings.vaultPath)
      const verdict = await Promise.race([
        runNativeTask(prompt, vault, providers),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
      ])
      if (verdict && isRealCompletion(verdict.response)) {
        const { display, action } = parseAction(verdict.response)
        say({ role: 'ai', text: display })
        applyAction(action)
      } else {
        say({ role: 'ai', text: `I couldn't reach ${primaryName} just now — try again, or use a vault instruction (a path, “use my Obsidian vault”, local / github / both).` })
      }
    } finally {
      setAsking(false)
      // Work through anything the user sent while this reply was pending.
      const next = queueRef.current.shift()
      if (next !== undefined) void askPrimary(next)
    }
  }

  const interpret = () => {
    const text = freeText.trim()
    if (!text) return
    const low = text.toLowerCase()
    setFreeText('')
    say({ role: 'user', text })

    // Instant lanes (0 tokens): explicit path, obsidian, mode words.
    const pathMatch = text.match(/(~\/[^\s"']+|\/[^\s"']+)/)
    if (pathMatch && low.split(' ').length <= 6) {
      setVault(pathMatch[1], vaultMode === 'github' ? 'both' : vaultMode)
      say({ role: 'note', text: `✓ applied: vault → ${pathMatch[1]}` })
      return
    }
    if (low.includes('obsidian') && low.split(' ').length <= 8) {
      if (obsidianVaults.length === 0) {
        say({ role: 'ai', text: 'I could not find an Obsidian vault registered on this Mac — use “Choose…” to pick the folder by hand.' })
        return
      }
      const named =
        obsidianVaults.find((v) => low.includes(baseName(v).toLowerCase())) ?? obsidianVaults[0]
      useObsidianVault(named)
      say({ role: 'note', text: `✓ applied: vault → ${named} (Obsidian “${baseName(named)}”)` })
      return
    }
    if (low === 'both' || low === 'github' || low === 'local') {
      const mode: VaultMode = low as VaultMode
      setVault(vaultPath, mode)
      say({ role: 'note', text: `✓ applied: mode → ${mode}` })
      return
    }

    // Everything else is a real conversation with the co-founder. If a reply
    // is already in flight, queue this one — it is answered next, never lost.
    if (asking) {
      queueRef.current.push(text)
      say({ role: 'note', text: '⏳ queued — I’ll answer this right after the current reply' })
      return
    }
    void askPrimary(text)
  }

  const onFreeKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      interpret()
    }
  }

  // Roving-radio keyboard nav for the three storage-mode option cards. Only acts
  // when the card itself holds focus (e.target === currentTarget) so arrow keys
  // typed in a card's inner path input are never hijacked.
  const optRefs = useRef<(HTMLDivElement | null)[]>([])
  const onOptKey = (e: KeyboardEvent<HTMLDivElement>, idx: number) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setVault(vaultPath, VAULT_MODES[idx])
      return
    }
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % VAULT_MODES.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = (idx - 1 + VAULT_MODES.length) % VAULT_MODES.length
    if (next >= 0) {
      e.preventDefault()
      setVault(vaultPath, VAULT_MODES[next])
      optRefs.current[next]?.focus()
    }
  }

  return (
    <div className="onb vs">
      <button type="button" className="wizback" onClick={() => navigate('/companion-wakes')}>
        ← Back
      </button>
      <div className="wizactions">
        {alreadyDone && (
          <button type="button" className="wizskip" onClick={() => navigate(nextRoute('vault'))}>
            Skip — already set →
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
      <Stepper active={2} />

      <div className="vs__body">
        {/* companion message — the ACTUAL primary's name + real detection */}
        <div className="vs__ask">
          <span className="orb orb--40" />
          <div className="vs__bubble">
            <b>{primaryName}</b> here — your co-founder from now on: I plan with you, draft
            the work, you approve. First decision together: where should your knowledge vault
            live? It&rsquo;s our single source of truth &mdash; markdown files I read and write.
            {obsidianVaults.length > 0 && (
              <>
                {' '}
                I found {obsidianVaults.length === 1 ? 'an Obsidian vault' : `${obsidianVaults.length} Obsidian vaults`}{' '}
                on this Mac — tap one below, or just talk to me in the box at the bottom.
              </>
            )}
          </div>
        </div>

        {/* REAL detected Obsidian vaults — one-tap choices */}
        {obsidianVaults.length > 0 && (
          <div className="vs__chips">
            {obsidianVaults.map((v) => (
              <button
                key={v}
                type="button"
                className={'vs__chip' + (vaultPath === v ? ' vs__chip--on' : '')}
                onClick={() => useObsidianVault(v)}
              >
                <span className="vs__chipmark">⟡</span> {baseName(v)}
                <span className="vs__chippath mono">{v}</span>
                {vaultPath === v && <span className="vs__chipsel mono">✓ selected</span>}
              </button>
            ))}
          </div>
        )}

        {/* option cards */}
        <div className="vs__options" role="radiogroup" aria-label="Vault storage location">
          <div
            className="opt opt--reco"
            role="radio"
            aria-checked={vaultMode === 'local'}
            aria-label="Local folder"
            tabIndex={vaultMode === 'local' ? 0 : -1}
            ref={(el) => {
              optRefs.current[0] = el
            }}
            onClick={() => setVault(vaultPath, 'local')}
            onKeyDown={(e) => onOptKey(e, 0)}
          >
            <span className="opt__badge">RECOMMENDED</span>
            <div className="opt__head">
              <span className={'radio' + (vaultMode === 'local' ? ' radio--on' : '')} />
              <span className="opt__title">Local folder</span>
            </div>
            <div className="opt__pathrow">
              <input
                className="opt__path mono"
                value={vaultPath}
                placeholder="~/sc-vault"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setVault(e.target.value, vaultMode)}
              />
              <span
                className="opt__choose"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  void chooseFolder()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void chooseFolder()
                  }
                }}
              >
                Choose&hellip;
              </span>
            </div>
            <div className="opt__desc">
              Fastest reads. Stays on this machine. Pick your Obsidian vault folder and your
              notes, verdicts and spans live right inside Obsidian.
            </div>
          </div>

          <div
            className="opt"
            role="radio"
            aria-checked={vaultMode === 'github'}
            aria-label="GitHub repo"
            tabIndex={vaultMode === 'github' ? 0 : -1}
            ref={(el) => {
              optRefs.current[1] = el
            }}
            onClick={() => setVault(vaultPath, 'github')}
            onKeyDown={(e) => onOptKey(e, 1)}
          >
            <div className="opt__head">
              <span className={'radio' + (vaultMode === 'github' ? ' radio--on' : '')} />
              <span className="opt__title">GitHub repo</span>
            </div>
            <div className="opt__pathrow">
              <input
                className="opt__path mono"
                value={githubRepo}
                placeholder="owner/repository"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setGithub(e.target.value, githubToken)}
              />
            </div>
            <div className="opt__desc">
              Optional — versioned backup, works across machines. Connect it anytime later in
              Settings &rarr; GitHub.
            </div>
          </div>

          <div
            className="opt"
            role="radio"
            aria-checked={vaultMode === 'both'}
            aria-label="Both"
            tabIndex={vaultMode === 'both' ? 0 : -1}
            ref={(el) => {
              optRefs.current[2] = el
            }}
            onClick={() => setVault(vaultPath, 'both')}
            onKeyDown={(e) => onOptKey(e, 2)}
          >
            <div className="opt__head">
              <span className={'radio' + (vaultMode === 'both' ? ' radio--on' : '')} />
              <span className="opt__title">Both</span>
            </div>
            <div className="opt__recodesc">
              Local folder (<span className="mono">{vaultPath || '~/sc-vault'}</span>), git-synced
              to <span className="mono">{githubRepo || 'your GitHub repo (optional — connect later in Settings)'}</span>.
            </div>
            <div className="opt__note mono">
              <span className="opt__notedot" />local speed + backup history
            </div>
          </div>
        </div>

        {/* live setup chat with the co-founder */}
        {(thread.length > 0 || asking) && (
          <div className="vs__thread" ref={threadRef}>
            {thread.map((m, i) =>
              m.role === 'note' ? (
                <div key={i} className="vs__notemsg mono">{m.text}</div>
              ) : m.role === 'user' ? (
                <div key={i} className="vs__umsg">{m.text}</div>
              ) : (
                <div key={i} className="vs__amsg">
                  <span className="orb orb--24" />
                  <div className="vs__abubble">{m.text}</div>
                </div>
              ),
            )}
            {asking && (
              <div className="vs__amsg">
                <span className="orb orb--24" />
                <div className="vs__abubble mono">
                  {primaryName} is thinking… (subscription replies take 15–45s)
                </div>
              </div>
            )}
          </div>
        )}

        {/* chat input — instructions apply instantly, everything else is a
            real conversation; you can keep typing while it thinks */}
        <div className="vs__free">
          <input
            className="vs__freeinput"
            value={freeText}
            placeholder={
              asking
                ? `${primaryName} is thinking — type your next message meanwhile…`
                : `chat with ${primaryName} — e.g. "let's keep everything in my Obsidian vault" or ask anything`
            }
            aria-label="Chat with your co-founder about the vault"
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={onFreeKey}
          />
          <button type="button" className="vs__send" aria-label="Send" onClick={interpret}>
            &uarr;
          </button>
        </div>

        <div className="vs__cta">
          <Link to={nextRoute('vault')} className="btn-gold" onClick={() => completeStep('vault')}>
            {CTA_LABEL[vaultMode] ?? 'Continue →'}
          </Link>
        </div>
      </div>
    </div>
  )
}
