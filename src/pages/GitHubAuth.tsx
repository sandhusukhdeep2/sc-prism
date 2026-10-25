import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '../lib/settings'
import {
  githubApiStatus,
  isNative,
  openExternal,
  resolveVaultDir,
  syncVaultToGithub,
} from '../lib/nativeEngine'
import './GitHubAuth.css'

// OPTIONAL GitHub sync (reached from Settings — deliberately NOT a setup
// step). REAL verification against api.github.com (token → /user, repo →
// /repos/{owner}/{name}) and a REAL push of the vault.

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=SC%20Prism%20vault%20sync'

type Check = 'idle' | 'checking' | 'ok' | 'fail'

export default function GitHubAuth() {
  const { settings, setGithub } = useSettings()
  const { githubRepo, githubToken, vaultPath } = settings

  const [tokenCheck, setTokenCheck] = useState<Check>('idle')
  const [repoCheck, setRepoCheck] = useState<Check>('idle')
  const [note, setNote] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState('')

  const verify = async () => {
    setNote('')
    // token → GET /user (200 = valid)
    if (githubToken.trim()) {
      setTokenCheck('checking')
      const s = await githubApiStatus('/user', githubToken.trim())
      setTokenCheck(s === 200 ? 'ok' : 'fail')
      if (s !== 200) {
        setNote(
          s === null
            ? 'Could not reach api.github.com — check your internet connection.'
            : 'Token rejected — generate a token with the “repo” scope and paste the full ghp_… value.',
        )
      }
    } else {
      setTokenCheck('fail')
      setNote('Paste a token first — the link below creates one with the right scope.')
    }
    // repo → GET /repos/{owner}/{name} (200 = visible with this token)
    if (githubRepo.trim()) {
      setRepoCheck('checking')
      const s = await githubApiStatus(`/repos/${githubRepo.trim()}`, githubToken.trim())
      setRepoCheck(s === 200 ? 'ok' : 'fail')
      if (s === 404) {
        setNote(
          'Repo not found — create it on GitHub first (empty repo is fine), or check the owner/repository spelling.',
        )
      }
    } else {
      setRepoCheck('fail')
    }
  }

  const pushNow = async () => {
    setSyncing(true)
    setSyncNote('')
    const vault = await resolveVaultDir(vaultPath)
    const res = await syncVaultToGithub(vault, githubRepo.trim(), githubToken.trim())
    setSyncNote(res.detail)
    setSyncing(false)
  }

  const verified = tokenCheck === 'ok' && repoCheck === 'ok'

  return (
    <div className="onb gh">
      <div className="gh__pagehead mono">GitHub sync — optional</div>

      <div className="gh__body">
        <div className="gh__ask">
          <span className="orb orb--40" />
          <div className="gh__bubble">
            Optional: connect GitHub and your vault gets a synced, versioned backup &mdash; I
            never push without you pressing the button. Skip it entirely and everything simply
            stays local.
          </div>
        </div>

        <div className="gh__card">
          <div className="gh__fieldrow">
            <input
              className="gh__input mono"
              value={githubRepo}
              placeholder="owner/repository"
              onChange={(e) => setGithub(e.target.value, githubToken)}
            />
          </div>
          <div className="gh__fieldrow">
            <input
              className="gh__input mono"
              type="password"
              value={githubToken}
              placeholder="Personal access token (ghp_…)"
              onChange={(e) => setGithub(githubRepo, e.target.value)}
            />
            <button type="button" className="gh__verify" onClick={() => void verify()}>
              {tokenCheck === 'checking' || repoCheck === 'checking' ? 'Verifying…' : 'Verify access'}
            </button>
          </div>
          <button type="button" className="gh__gettoken" onClick={() => void openExternal(TOKEN_URL)}>
            Get a GitHub token (repo scope) ↗
          </button>

          <div className="gh__checks">
            <CheckRow state={tokenCheck}>
              Token valid{tokenCheck === 'ok' ? ' — signed in to the GitHub API' : ''}
            </CheckRow>
            <CheckRow state={repoCheck}>
              Repo reachable: <span className="mono gh__strong">{githubRepo || 'owner/repository'}</span>
            </CheckRow>
          </div>
          {note && <div className="gh__note mono">{note}</div>}

          {verified && (
            <div className="gh__syncrow">
              <button
                type="button"
                className="gh__pushbtn"
                disabled={syncing || !isNative()}
                onClick={() => void pushNow()}
              >
                {syncing ? 'Pushing…' : 'Push vault to GitHub now'}
              </button>
              {!isNative() && <span className="gh__note mono">push needs the installed app</span>}
            </div>
          )}
          {syncNote && <div className="gh__note mono">{syncNote}</div>}

          <div className="gh__lock">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"
              fill="none" stroke="#a8a49a" strokeWidth="1.8" strokeLinecap="round">
              <rect x="4" y="10" width="16" height="10" rx="2.5" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            The token stays on this machine and is sent only to api.github.com / github.com.
          </div>
        </div>

        <div className="gh__guide">
          <div className="gh__guidebubble">
            {verified
              ? 'Connected — your vault can sync to GitHub.'
              : 'Optional — skip and your vault stays local-only.'}
          </div>
          <span className="orb orb--34" />
        </div>

        <div className="gh__footer">
          <Link to="/settings" className="btn-gold">
            Done &rarr;
          </Link>
        </div>
      </div>
    </div>
  )
}

function CheckRow({ state, children }: { state: Check; children: React.ReactNode }) {
  const mark = state === 'ok' ? '✓' : state === 'fail' ? '✕' : state === 'checking' ? '…' : '·'
  const cls =
    'gh__checkmark' +
    (state === 'ok' ? '' : state === 'fail' ? ' gh__checkmark--fail' : ' gh__checkmark--idle')
  return (
    <div className="gh__check">
      <span className={cls}>{mark}</span>
      <span className="gh__checktext">{children}</span>
    </div>
  )
}
