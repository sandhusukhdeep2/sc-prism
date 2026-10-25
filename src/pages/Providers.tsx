import Stepper from '../components/Stepper'
import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CLI_MODEL_CHOICES,
  CLI_PROVIDERS,
  CUSTOM_PRESETS,
  brandViews,
  isCliProvider,
  isCustomProvider,
  listProviderModels,
  pingProvider,
  useSettings,
  type BrandView,
  type ProviderConfig,
} from '../lib/settings'
import { useOnboarding } from '../lib/onboarding'
import { openExternal } from '../lib/nativeEngine'
import './Providers.css'

// Where to get an API key for each cloud provider (opens in the browser).
export const KEY_URLS: Record<string, string> = {
  claude: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
}

// 'ok' | 'auth' | 'unreachable' mirror the ProviderStatus from pingProvider.
type TestStatus = 'idle' | 'testing' | 'ok' | 'auth' | 'unreachable'

// Enter/Space activation for span-based controls given a real role.
function onActivate(handler: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handler()
    }
  }
}


function ProviderIcon({ id }: { id: string }) {
  if (id === 'local') {
    return (
      <span className="provider__icon provider__icon--dark">
        <svg width="15" height="15" viewBox="0 0 24 24" className="provider__glyph">
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 9h6v6H9z" />
        </svg>
      </span>
    )
  }
  const cls = id.startsWith('claude')
    ? 'provider__icon--claude'
    : id.startsWith('openai') || id === 'codex-cli'
      ? 'provider__icon--openai'
      : 'provider__icon--gemini'
  const letter = id.startsWith('claude')
    ? 'A'
    : id === 'codex-cli'
      ? 'X'
      : id.startsWith('openai')
        ? 'O'
        : 'G'
  return <span className={`provider__icon ${cls}`}>{letter}</span>
}

// Local-server card (the brand cards render via BrandRow below).
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

/** The effort tokens are the ENGINE's vocabulary; people read words. The
 *  value sent is unchanged — only the label speaks plainly (Sukhdeep's
 *  wizard walk: "xhigh" is not a thing a normal user chooses between). */
function effortLabel(e: string): string {
  if (!e) return 'default'
  if (e === 'xhigh') return 'very deep'
  if (e === 'max') return 'deepest (slowest)'
  if (e === 'high') return 'deep'
  return e
}


/**
 * Model + thinking-effort choice, wizard edition (mirrors Settings'
 * ModelEffortRow): a real local/cloud server rejects placeholder ids, so the
 * wizard must let you pick a served model at connect time. '▾ load models'
 * fetches the provider's REAL list (nothing hardcoded); CLI providers expose
 * no listing API, so they keep a free-text field (aliases like opus work).
 */
function ModelPickRow({ p }: { p: ProviderConfig }) {
  const { updateProvider } = useSettings()
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [customCli, setCustomCli] = useState(false)
  const cli = isCliProvider(p.id)
  const cliChoices = cli ? CLI_MODEL_CHOICES[p.id] : undefined

  const load = async () => {
    setLoading(true)
    setModels(await listProviderModels(p))
    setLoading(false)
  }

  return (
    <div className="provider__row">
      {cli && cliChoices && !customCli ? (
        <select
          className="field mono"
          value={p.model ?? ''}
          aria-label={`Model for ${p.name}`}
          onChange={(e) => {
            if (e.target.value === '__custom__') setCustomCli(true)
            else updateProvider(p.id, { model: e.target.value })
          }}
        >
          <option value="">CLI default</option>
          <optgroup label="Recommended — newest">
            {cliChoices.filter((c) => c.recommended).map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="More">
            {cliChoices.filter((c) => !c.recommended).map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
          {p.model && !cliChoices.some((c) => c.value === p.model) ? (
            <option value={p.model}>{p.model} (current)</option>
          ) : null}
          <option value="__custom__">custom…</option>
        </select>
      ) : models && models.length > 0 ? (
        <select
          className="field mono"
          value={p.model ?? ''}
          aria-label={`Model for ${p.name}`}
          onChange={(e) => updateProvider(p.id, { model: e.target.value })}
        >
          <option value="">provider default</option>
          {!models.includes(p.model ?? '') && p.model ? (
            <option value={p.model}>{p.model} (current)</option>
          ) : null}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field mono"
          value={p.model ?? ''}
          placeholder={cli ? 'model — any id your CLI accepts' : 'model — pick one your server actually serves'}
          aria-label={`Model for ${p.name}`}
          onChange={(e) => updateProvider(p.id, { model: e.target.value })}
        />
      )}
      {!cli && (
        <button
          type="button"
          className="provider__loadmodels mono"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'loading…' : models === null ? '▾ load models' : models.length ? `↻ ${models.length}` : 'none found'}
        </button>
      )}
      <label className="provider__effort mono">
        thinking
        <select
          className="provider__effortsel"
          value={p.effort ?? ''}
          aria-label={`Thinking effort for ${p.name}`}
          onChange={(e) => updateProvider(p.id, { effort: e.target.value })}
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {effortLabel(e)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function ProviderRow({ p }: { p: ProviderConfig }) {
  const { updateProvider, setPrimary } = useSettings()
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'ok' : 'idle')

  const runTest = async () => {
    setStatus('testing')
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id)
    setStatus(res)
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
    updateProvider(p.id, { connected: false, apiKey: '' })
    setStatus('idle')
  }

  const rowClass =
    'provider' +
    (p.primary ? ' provider--primary' : '') +
    (status === 'unreachable' ? ' provider--error' : '') +
    (status === 'auth' ? ' provider--auth' : '') +
    (!p.enabled ? ' provider--off' : '')

  return (
    <div className={rowClass}>
      <div className="provider__head">
        <span
          className={'toggle' + (p.enabled ? ' is-on' : '')}
          role="switch"
          aria-checked={p.enabled}
          aria-label={`Enable ${p.name}`}
          tabIndex={0}
          onClick={() => updateProvider(p.id, { enabled: !p.enabled })}
          onKeyDown={onActivate(() => updateProvider(p.id, { enabled: !p.enabled }))}
        >
          <span className="toggle__knob" />
        </span>
        <ProviderIcon id={p.id} />
        <span className={'provider__name' + (p.enabled ? '' : ' provider__name--dim')}>{p.name}</span>

        {status === 'ok' && (
          <span className="status status--ok mono">
            <span className="status__dot status__dot--ok" />
            {isCliProvider(p.id) ? 'installed' : 'connected'}
          </span>
        )}
        {status === 'auth' && (
          <span className="status status--auth mono">
            <span className="status__dot status__dot--auth" />needs a key — paste it below
          </span>
        )}
        {status === 'unreachable' && (
          <span className="status status--err mono">
            <span className="status__dot status__dot--err" />
            {isCliProvider(p.id) ? 'not installed — see the link below' : 'unreachable — check the URL'}
          </span>
        )}
        {status === 'testing' && <span className="status mono">testing…</span>}

        <span className="provider__spacer" />

        {p.enabled ? (
          <span
            className={'primary' + (p.primary ? ' primary--on' : '')}
            role="radio"
            aria-checked={p.primary}
            aria-label={`Set ${p.name} as primary provider`}
            tabIndex={0}
            onClick={() => setPrimary(p.id)}
            onKeyDown={onActivate(() => setPrimary(p.id))}
          >
            <span className={'primary__radio' + (p.primary ? ' primary__radio--on' : '')} />
            {p.primary ? 'Primary' : 'Set as primary'}
          </span>
        ) : (
          <span className="provider__off">off</span>
        )}
      </div>

      {p.enabled && p.connected && (
        <div className="provider__row provider__row--cli">
          <span className="provider__saved mono">
            ✓ connected to <span className="mono">{p.baseUrl}</span> — saved until you disconnect
          </span>
          <button type="button" className="provider__disconnect" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
      {p.enabled && !p.connected && (
        <>
          <div className="provider__row">
            <input
              className="field mono"
              value={p.baseUrl}
              placeholder="http://localhost:1234"
              onChange={(e) =>
                updateProvider(p.id, { baseUrl: e.target.value, connected: false })
              }
            />
            <span
              className="btn-dark"
              role="button"
              tabIndex={0}
              aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${p.name}`}
              onClick={runTest}
              onKeyDown={onActivate(runTest)}
            >
              {status === 'unreachable' ? 'Retry' : 'Connect'}
            </span>
          </div>
          <div className="provider__row">
            <input
              className="field field--key mono"
              type="password"
              value={p.apiKey}
              placeholder="API key (if your server needs one)"
              aria-label={`API key for ${p.name}`}
              onChange={(e) =>
                updateProvider(p.id, { apiKey: e.target.value, connected: false })
              }
            />
          </div>
          <div className="provider__hint">
            any OpenAI-compatible endpoint (LM Studio, Ollama, MLX…)
          </div>
          {KEY_URLS[p.id] && (
            <div className="provider__hint">
              <button
                type="button"
                className="provider__getkey"
                onClick={() => openExternal(KEY_URLS[p.id])}
              >
                Get a {p.name} API key ↗
              </button>
            </div>
          )}
        </>
      )}
      {p.enabled && <ModelPickRow p={p} />}
    </div>
  )
}

/** User-added custom service: any OpenAI-compatible endpoint (name editable). */
function CustomRow({ p }: { p: ProviderConfig }) {
  const { updateProvider, setPrimary, removeProvider } = useSettings()
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'ok' : 'idle')

  const runTest = async () => {
    setStatus('testing')
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id)
    setStatus(res)
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
    updateProvider(p.id, { connected: false, apiKey: '' })
    setStatus('idle')
  }

  const rowClass =
    'provider' +
    (p.primary ? ' provider--primary' : '') +
    (status === 'unreachable' ? ' provider--error' : '') +
    (status === 'auth' ? ' provider--auth' : '') +
    (!p.enabled ? ' provider--off' : '')

  return (
    <div className={rowClass}>
      <div className="provider__head">
        <span
          className={'toggle' + (p.enabled ? ' is-on' : '')}
          role="switch"
          aria-checked={p.enabled}
          aria-label={`Enable ${p.name}`}
          tabIndex={0}
          onClick={() => updateProvider(p.id, { enabled: !p.enabled })}
          onKeyDown={onActivate(() => updateProvider(p.id, { enabled: !p.enabled }))}
        >
          <span className="toggle__knob" />
        </span>
        <ProviderIcon id="local" />
        <input
          className="provider__nameinput"
          value={p.name}
          aria-label="Custom service name"
          onChange={(e) => updateProvider(p.id, { name: e.target.value })}
        />

        {status === 'ok' && (
          <span className="status status--ok mono">
            <span className="status__dot status__dot--ok" />connected
          </span>
        )}
        {status === 'auth' && (
          <span className="status status--auth mono">
            <span className="status__dot status__dot--auth" />needs a key
          </span>
        )}
        {status === 'unreachable' && (
          <span className="status status--err mono">
            <span className="status__dot status__dot--err" />unreachable — check the URL
          </span>
        )}
        {status === 'testing' && <span className="status mono">testing…</span>}

        <span className="provider__spacer" />

        {p.enabled ? (
          <span
            className={'primary' + (p.primary ? ' primary--on' : '')}
            role="radio"
            aria-checked={p.primary}
            aria-label={`Set ${p.name} as primary provider`}
            tabIndex={0}
            onClick={() => setPrimary(p.id)}
            onKeyDown={onActivate(() => setPrimary(p.id))}
          >
            <span className={'primary__radio' + (p.primary ? ' primary__radio--on' : '')} />
            {p.primary ? 'Primary' : 'Set as primary'}
          </span>
        ) : (
          <span className="provider__off">off</span>
        )}
        <button
          type="button"
          className="provider__remove"
          aria-label={`Remove ${p.name}`}
          onClick={() => removeProvider(p.id)}
        >
          ✕
        </button>
      </div>

      {p.enabled && p.connected && (
        <div className="provider__row provider__row--cli">
          <span className="provider__saved mono">
            ✓ connected to <span className="mono">{p.baseUrl}</span> — saved until you disconnect
          </span>
          <button type="button" className="provider__disconnect" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
      {p.enabled && !p.connected && (
        <>
          <div className="provider__row">
            <select
              className="field mono"
              value=""
              aria-label="Pick a known service"
              onChange={(e) => {
                const preset = CUSTOM_PRESETS[Number(e.target.value)]
                if (preset)
                  updateProvider(p.id, {
                    name: preset.name,
                    baseUrl: preset.baseUrl,
                    model: preset.model,
                    connected: false,
                  })
              }}
            >
              <option value="">Pick a known service… (DeepSeek, Kimi, Grok, Mistral…)</option>
              {CUSTOM_PRESETS.map((preset, i) => (
                <option key={preset.name} value={i}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>
          <div className="provider__row">
            <input
              className="field mono"
              value={p.baseUrl}
              placeholder="https://your-server.example.com  (OpenAI-compatible)"
              onChange={(e) =>
                updateProvider(p.id, { baseUrl: e.target.value, connected: false })
              }
            />
            <span
              className="btn-dark"
              role="button"
              tabIndex={0}
              aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${p.name}`}
              onClick={runTest}
              onKeyDown={onActivate(runTest)}
            >
              {status === 'unreachable' ? 'Retry' : 'Connect'}
            </span>
          </div>
          <div className="provider__row">
            <input
              className="field field--key mono"
              type="password"
              value={p.apiKey}
              placeholder="API key (if the service needs one)"
              aria-label={`API key for ${p.name}`}
              onChange={(e) =>
                updateProvider(p.id, { apiKey: e.target.value, connected: false })
              }
            />
            <input
              className="field mono"
              value={p.model ?? ''}
              placeholder="model id (e.g. deepseek-chat)"
              aria-label={`Model for ${p.name}`}
              onChange={(e) => updateProvider(p.id, { model: e.target.value })}
            />
          </div>
          <div className="provider__guide">
            <div className="provider__guidetitle">How to connect</div>
            <div className="provider__guidestep"><b>Easy way:</b> pick a service from the dropdown above — the URL and model fill in for you. Then just paste that service&rsquo;s API key and press <b>Connect</b>.</div>
            <div className="provider__guidestep"><b>Manual way</b> (service not in the list): ignore the dropdown and fill the boxes yourself —</div>
            <div className="provider__guidestep">1&nbsp;·&nbsp;<b>URL</b>: the service&rsquo;s base address from its docs, e.g. <span className="mono">https://api.example.com</span> — don&rsquo;t add <span className="mono">/chat/completions</span>, the app does that.</div>
            <div className="provider__guidestep">2&nbsp;·&nbsp;<b>API key</b>: paste it if the service needs one (local servers often don&rsquo;t).</div>
            <div className="provider__guidestep">3&nbsp;·&nbsp;<b>Model id</b>: exactly as the service&rsquo;s docs write it, e.g. <span className="mono">deepseek-chat</span>.</div>
            <div className="provider__guidestep">4&nbsp;·&nbsp;Press <b>Connect</b> — green means saved permanently; red means check the URL; amber means the key is wrong or missing.</div>
            <div className="provider__guidestep">Works with anything that says &ldquo;OpenAI-compatible&rdquo;: DeepSeek, Kimi, Grok, Mistral, Groq, OpenRouter, a remote Ollama/LM Studio, your company gateway…</div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * One card per cloud brand with a mode switch: API key OR subscription
 * (CLI). Exactly one of the pair is enabled; switching modes carries the
 * enabled + primary state across to the other half.
 */
function BrandRow({ v }: { v: BrandView }) {
  const { updateProvider, setPrimary } = useSettings()
  const p = v.active
  // A saved connection survives restarts: start green when p.connected.
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'ok' : 'idle')

  const runTest = async () => {
    setStatus('testing')
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id)
    setStatus(res)
    // A successful Connect is persisted — stays connected until Disconnect.
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
    // Remove the connection AND the saved credential (CLI mode holds none).
    updateProvider(p.id, { connected: false, apiKey: '' })
    setStatus('idle')
  }

  const switchMode = (mode: 'api' | 'cli') => {
    if (mode === v.mode) return
    const on = mode === 'cli' ? v.cli : v.api
    const off = mode === 'cli' ? v.api : v.cli
    const wasPrimary = off.primary || on.primary
    updateProvider(off.id, { enabled: false, primary: false })
    if (wasPrimary) setPrimary(on.id)
    else if (v.enabled) updateProvider(on.id, { enabled: true })
    setStatus(on.connected ? 'ok' : 'idle')
  }

  const toggle = () => {
    if (v.enabled) {
      updateProvider(v.api.id, { enabled: false })
      updateProvider(v.cli.id, { enabled: false })
    } else {
      updateProvider(p.id, { enabled: true })
    }
    setStatus('idle')
  }

  const rowClass =
    'provider' +
    (p.primary ? ' provider--primary' : '') +
    (status === 'unreachable' ? ' provider--error' : '') +
    (status === 'auth' ? ' provider--auth' : '') +
    (!v.enabled ? ' provider--off' : '')

  return (
    <div className={rowClass}>
      <div className="provider__head">
        <span
          className={'toggle' + (v.enabled ? ' is-on' : '')}
          role="switch"
          aria-checked={v.enabled}
          aria-label={`Enable ${v.name}`}
          tabIndex={0}
          onClick={toggle}
          onKeyDown={onActivate(toggle)}
        >
          <span className="toggle__knob" />
        </span>
        <ProviderIcon id={v.brand} />
        <span className={'provider__name' + (v.enabled ? '' : ' provider__name--dim')}>{v.name}</span>

        {status === 'ok' && (
          <span className="status status--ok mono">
            <span className="status__dot status__dot--ok" />
            {v.mode === 'cli' ? 'installed' : 'connected'}
          </span>
        )}
        {status === 'auth' && (
          <span className="status status--auth mono">
            <span className="status__dot status__dot--auth" />needs a key — paste it below
          </span>
        )}
        {status === 'unreachable' && (
          <span className="status status--err mono">
            <span className="status__dot status__dot--err" />
            {v.mode === 'cli' ? 'not installed — see the link below' : 'unreachable'}
          </span>
        )}
        {status === 'testing' && <span className="status mono">testing…</span>}

        <span className="provider__spacer" />

        {v.enabled ? (
          <span
            className={'primary' + (p.primary ? ' primary--on' : '')}
            role="radio"
            aria-checked={p.primary}
            aria-label={`Set ${v.name} as primary provider`}
            tabIndex={0}
            onClick={() => setPrimary(p.id)}
            onKeyDown={onActivate(() => setPrimary(p.id))}
          >
            <span className={'primary__radio' + (p.primary ? ' primary__radio--on' : '')} />
            {p.primary ? 'Primary' : 'Set as primary'}
          </span>
        ) : (
          <span className="provider__off">off</span>
        )}
      </div>

      {v.enabled && (
        <>
          {/* connection-mode switch: one connection per brand */}
          <div className="modeseg" role="radiogroup" aria-label={`${v.name} connection type`}>
            <span
              className={'modeseg__btn' + (v.mode === 'api' ? ' modeseg__btn--on' : '')}
              role="radio"
              aria-checked={v.mode === 'api'}
              tabIndex={0}
              onClick={() => switchMode('api')}
              onKeyDown={onActivate(() => switchMode('api'))}
            >
              API key
            </span>
            <span
              className={'modeseg__btn' + (v.mode === 'cli' ? ' modeseg__btn--on' : '')}
              role="radio"
              aria-checked={v.mode === 'cli'}
              tabIndex={0}
              onClick={() => switchMode('cli')}
              onKeyDown={onActivate(() => switchMode('cli'))}
            >
              {v.cliLabel}
            </span>
          </div>

          {p.connected ? (
            <div className="provider__row provider__row--cli">
              <span className="provider__saved mono">
                {v.mode === 'api'
                  ? '✓ credential saved — held by the Gateway, never shown again'
                  : '✓ connected via your subscription sign-in on this Mac'}
              </span>
              <button type="button" className="provider__disconnect" onClick={disconnect}>
                Disconnect
              </button>
            </div>
          ) : v.mode === 'api' ? (
            <>
              <div className="provider__row">
                <input
                  className="field field--key mono"
                  type="password"
                  value={p.apiKey}
                  placeholder="API key"
                  onChange={(e) =>
                    updateProvider(p.id, { apiKey: e.target.value, connected: false })
                  }
                />
                <span
                  className="btn-dark"
                  role="button"
                  tabIndex={0}
                  aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${v.name}`}
                  onClick={runTest}
                  onKeyDown={onActivate(runTest)}
                >
                  {status === 'unreachable' ? 'Retry' : 'Connect'}
                </span>
              </div>
              {KEY_URLS[p.id] && (
                <div className="provider__hint">
                  <button
                    type="button"
                    className="provider__getkey"
                    onClick={() => openExternal(KEY_URLS[p.id])}
                  >
                    Get a {v.name} API key ↗
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="provider__hint">{CLI_PROVIDERS[p.id].hint}</div>
              <div className="provider__row provider__row--cli">
                <span
                  className="btn-dark"
                  role="button"
                  tabIndex={0}
                  aria-label={`Connect ${v.name} via its CLI`}
                  onClick={runTest}
                  onKeyDown={onActivate(runTest)}
                >
                  {status === 'unreachable' ? 'Retry' : 'Connect'}
                </span>
                <button
                  type="button"
                  className="provider__getkey"
                  onClick={() => openExternal(CLI_PROVIDERS[p.id].install)}
                >
                  Install ↗
                </button>
              </div>
            </>
          )}
          <ModelPickRow p={p} />
        </>
      )}
    </div>
  )
}

type GateState = 'idle' | 'testing' | 'warn' | 'blocked'

export default function Providers() {
  const { settings, updateProvider, addCustomProvider } = useSettings()
  const { completeStep, nextRoute, completedSteps, pause } = useOnboarding()
  const navigate = useNavigate()
  const alreadyDone = completedSteps.includes('providers')
  const [gate, setGate] = useState<GateState>('idle')

  // At least ONE connected service (green ✓) is required to leave this page.
  const anyConnected = settings.providers.some((p) => p.enabled && p.connected)
  // Once any CLOUD service is connected, "skip cloud" is meaningless.
  const anyCloudConnected = settings.providers.some(
    (p) => p.id !== 'local' && p.enabled && p.connected,
  )

  const proceed = () => {
    completeStep('providers')
    navigate(nextRoute('providers'))
  }

  // Test the primary provider before advancing. 'ok' and 'auth' both let you
  // continue (the server is reachable — a key can be pasted later); only
  // 'unreachable' warns, and a second click proceeds anyway. With NO connected
  // service at all the page hard-blocks — connect something first.
  const testPrimaryAndContinue = async () => {
    if (!anyConnected) {
      setGate('blocked')
      return
    }
    if (gate === 'warn') {
      proceed()
      return
    }
    const primary = settings.providers.find((p) => p.primary)
    if (!primary) {
      proceed()
      return
    }
    setGate('testing')
    const res = await pingProvider(primary.baseUrl, primary.apiKey, primary.id)
    if (res === 'unreachable') {
      setGate('warn')
      return
    }
    // Verified primary: persist the connection (survives restarts).
    if (res === 'ok') updateProvider(primary.id, { connected: true })
    proceed()
  }

  const continueLabel =
    gate === 'testing'
      ? 'Testing…'
      : gate === 'warn'
        ? 'Continue anyway →'
        : 'Test primary & continue →'

  return (
    <div className="prov">
      <button type="button" className="wizback" onClick={() => navigate('/welcome')}>
        ← Back
      </button>
      <div className="wizactions">
        {alreadyDone && (
          <button
            type="button"
            className="wizskip"
            onClick={() => navigate(nextRoute('providers'))}
          >
            Skip — already connected →
          </button>
        )}
        <button
          type="button"
          className="wizclose"
          aria-label="Close setup"
          onClick={() => {
            // Close means close — it must not record setup as finished for
            // someone who connected nothing (pre-launch audit, 2026-09-03).
            pause()
            navigate('/')
          }}
        >
          ✕ Close
        </button>
      </div>
      <Stepper active={0} />

      <div className="prov__card">
        <div className="prov__title">Connect your AI providers</div>
        <div className="prov__sub">Pick the models SC Prism can route to. One is your primary.</div>

        {settings.providers
          .filter((p) => p.id === 'local')
          .map((p) => (
            <ProviderRow key={p.id} p={p} />
          ))}
        {brandViews(settings).map((v) => (
          <BrandRow key={v.brand} v={v} />
        ))}
        {settings.providers
          .filter((p) => isCustomProvider(p.id))
          .map((p) => (
            <CustomRow key={p.id} p={p} />
          ))}

        {/* add custom */}
        <div
          className="provider__add"
          role="button"
          tabIndex={0}
          onClick={addCustomProvider}
          onKeyDown={onActivate(addCustomProvider)}
        >
          <span className="provider__add-icon">+</span> Add custom service
          <span className="provider__addhint">any OpenAI-compatible endpoint</span>
        </div>

        {/* footer */}
        <div className="prov__footer">
          {gate === 'blocked' ? (
            <span className="prov__gatewarn mono">
              Connect at least one service above (green ✓) — or continue without
              one; nothing can run until you connect an AI.
            </span>
          ) : gate === 'warn' ? (
            <span className="prov__gatewarn mono">
              Primary looks unreachable — check the URL, or continue anyway.
            </span>
          ) : (
            <span className="prov__footnote">keys are held by the Gateway · never rendered</span>
          )}
          <span className="provider__spacer" />
          {/* "Skip cloud" only makes sense while NO cloud service is connected —
              and never as a way past the connect-something requirement. */}
          {anyConnected && !anyCloudConnected && (
            <span
              className="prov__skip"
              role="button"
              tabIndex={0}
              onClick={proceed}
              onKeyDown={onActivate(proceed)}
            >
              Skip cloud for now
            </span>
          )}
          {/* THE FIRST-RUN WAY OUT. A stranger with no key, no local server and
              no subscription CLI could not turn anything green, and the skip
              above only appears once something already is — so the only control
              left was ✕ Close. This is the honest alternative: it lets them in,
              and says plainly what does not work until they connect something.
              Deliberately a button, not a quiet link: it is the primary action
              for this user, even though it is the secondary one for everybody
              else. */}
          {!anyConnected && (
            <>
              {/* Stated up front, not only after they try and are refused: the
                  app does nothing without an AI, and a user who continues here
                  deserves to know that before they click, not after. */}
              <span className="prov__latercost">
                nothing can run until you connect an AI
              </span>
              <button
                type="button"
                className="prov__laterbtn"
                onClick={proceed}
              >
                Continue without an AI — connect one later
              </button>
            </>
          )}
          <span
            className={'prov__continue' + (anyConnected ? '' : ' prov__continue--disabled')}
            role="button"
            tabIndex={0}
            aria-disabled={!anyConnected}
            aria-label="Test primary provider and continue"
            onClick={testPrimaryAndContinue}
            onKeyDown={onActivate(testPrimaryAndContinue)}
          >
            {continueLabel}
          </span>
        </div>
      </div>
    </div>
  )
}
