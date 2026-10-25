import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  CLI_MODEL_CHOICES,
  CLI_PROVIDERS,
  CUSTOM_PRESETS,
  brandViews,
  cachedCliProbe,
  cliStatusLabel,
  isCliProvider,
  listProviderModels,
  isCustomProvider,
  normalizeProviderBase,
  pingProvider,
  primaryDisplayName,
  useSettings,
  type BrandView,
  type ProviderConfig,
  type RouteBias,
  type RoutingMode as RoutingModeId,
  type ThemeId,
} from '../lib/settings'
import { useOnboarding } from '../lib/onboarding'
import { resetInterview } from '../lib/interview'
import {
  checkExtensions,
  isNative,
  openExternal,
  providerGetJson,
  readMcpApprovals,
  readMcpServers,
  readSpansTail,
  readTrainingCount,
  resolveVaultDir,
  runNativeMcpList,
  sendTelegram,
  withVaultGranted,
  writeMcpApprovals,
  writeMcpServers,
  type ExtensionAvailability,
  type McpApprovalPolicy,
  type McpServerConfig,
  type McpToolInfo,
} from '../lib/nativeEngine'
// The RISK CLASSIFICATION the engine enforces (mirror of
// engine/scprism_engine/toolrisk.py). Settings names what runs freely FROM this
// table, never from prose written alongside it, so the page cannot claim a
// capability the gate does not actually grant.
import { FIRST_PARTY_READ_ONLY, readsRunFree, withReadsFree } from '../lib/toolRisk'
import { mcpSaveArgv, mcpTestKeysToClear } from '../lib/mcpForm'
import { latencyFromSpans, slowLocalNotice, turnBudget } from '../lib/runBudget'
import {
  buildLocalModelReport,
  modelStatusUrl,
  parseModelStatus,
  rowFacts,
  type LocalModelReport,
  type LocalServerStatus,
} from '../lib/localModels'
import {
  crewModelPlan,
  persistAgentToVault,
  update as updateAgent,
  useAgents,
  type AgentModel,
  type CrewLean,
} from '../lib/agents'
import { DEFAULT_TOKEN_BUDGET, clampBudget, dailyUsage } from '../lib/budget'
import { brandBudgetStatus, brandOf, isEstimatedSpend, type Brand } from '../lib/providerBudget'
import { buildKindPicks } from '../lib/localModelPick'
import { persistedStats, persistedVerdicts } from '../store/AppStore'
import { KEY_URLS } from './Providers'
import './Settings.css'
import PageHead from '../components/PageHead'

// 'ok' | 'auth' | 'unreachable' mirror the ProviderStatus from pingProvider.
// 'saved' (audit fix 2026-08-30): a connection remembered from an earlier
// session. It is NOT 'ok' — 'working'/'connected' are reserved for a provider
// that answered THIS session; the pill says so and points at Test.
type TestStatus = 'idle' | 'testing' | 'ok' | 'auth' | 'unreachable' | 'saved'

// Enter/Space activation for span/div-based controls given a real role.
function onActivate(handler: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handler()
    }
  }
}

function SettingsLogo({ id }: { id: string }) {
  if (id === 'local') {
    return (
      <span className="settings__logo settings__logo--dark">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#83a2db" strokeWidth="1.8">
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 9h6v6H9z" />
        </svg>
      </span>
    )
  }
  const cls = id.startsWith('claude')
    ? 'settings__logo--claude'
    : id.startsWith('openai') || id === 'codex-cli'
      ? 'settings__logo--openai'
      : 'settings__logo--gemini'
  const letter = id.startsWith('claude')
    ? 'A'
    : id === 'codex-cli'
      ? 'X'
      : id.startsWith('openai')
        ? 'O'
        : 'G'
  return <span className={`settings__logo ${cls}`}>{letter}</span>
}

/**
 * Masked API-key input with a show/hide eye — the only way to verify a typed
 * key. `ariaLabel` also names the toggle ("Show <ariaLabel>").
 */
function KeyInput({
  value,
  placeholder,
  ariaLabel,
  onChange,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  onChange: (v: string) => void
}) {
  const [show, setShow] = useState(false)
  return (
    <span className="settings__keywrap">
      <input
        className="settings__input settings__input--key mono"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="settings__keyeye"
        aria-label={`${show ? 'Hide' : 'Show'} ${ariaLabel}`}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        👁
      </button>
    </span>
  )
}

/**
 * The connection state pill — and, for a subscription CLI, the THREE states
 * that were previously collapsed into "installed" (2026-08-12).
 *
 * A `gemini` binary can be present and current and still fail every call
 * because Google closed that account's login tier. The old card asked only
 * "is the binary there?" and showed green, so the agent on it kept its seat on
 * every team and contributed an offline stub. Now:
 *   'ok'          → working (it actually answered)
 *   'auth'        → installed, can't answer — with the CLI's OWN error line
 *   'unreachable' → not installed
 */
function StatusPill({
  status,
  cli,
  detail,
}: {
  status: TestStatus
  cli: boolean
  detail?: string
}) {
  if (status === 'testing') {
    return <span className="settings__status mono">{cli ? 'asking it to answer…' : 'testing…'}</span>
  }
  if (status === 'idle') return null
  if (status === 'saved') {
    return (
      <span className="settings__status mono" title="remembered from an earlier session — hit Test to confirm it still answers">
        <span className="settings__statusdot settings__statusdot--saved" />
        connected earlier · Test to confirm
      </span>
    )
  }
  if (status === 'ok') {
    return (
      <span className="settings__status settings__status--ok mono">
        <span className="settings__statusdot" />
        {cli ? cliStatusLabel('ok') : 'connected'}
      </span>
    )
  }
  if (status === 'auth') {
    return (
      <span className="settings__status settings__status--auth mono" title={detail || undefined}>
        <span className="settings__statusdot settings__statusdot--auth" />
        {cli ? `installed, ${cliStatusLabel('auth')}` : 'needs a key'}
      </span>
    )
  }
  return (
    <span className="settings__status settings__status--err mono">
      <span className="settings__statusdot settings__statusdot--err" />
      {cli ? cliStatusLabel('unreachable') : 'unreachable'}
    </span>
  )
}

// Local-server card (cloud brands render via BrandCard below).
function ProviderCard({ p }: { p: ProviderConfig }) {
  const { updateProvider, setPrimary } = useSettings()
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'saved' : 'idle')
  // The CLI's own words when it is installed but cannot answer — shown, never
  // paraphrased into a cheerful "installed".
  const [cliDetail, setCliDetail] = useState('')

  const runTest = async () => {
    setStatus('testing')
    // `force`: an explicit Connect/Retry click always re-asks, cache or not —
    // that click IS the user saying "check it again now".
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id, { force: true })
    setStatus(res)
    setCliDetail(isCliProvider(p.id) ? (cachedCliProbe(p.id)?.detail ?? '') : '')
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
    updateProvider(p.id, { connected: false, apiKey: '' })
    setStatus('idle')
  }

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span
          className={'settings__toggle ' + (p.enabled ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={p.enabled}
          aria-label={`Enable ${p.name}`}
          tabIndex={0}
          onClick={() => updateProvider(p.id, { enabled: !p.enabled })}
          onKeyDown={onActivate(() => updateProvider(p.id, { enabled: !p.enabled }))}
        >
          <span className={'settings__knob' + (p.enabled ? '' : ' settings__knob--off')} />
        </span>
        <SettingsLogo id={p.id} />
        <span className="settings__pname">{p.name}</span>

        <StatusPill status={status} cli={isCliProvider(p.id)} detail={cliDetail} />

        <span className="settings__spacer" />

        {p.primary ? (
          <span
            className="settings__primary"
            role="radio"
            aria-checked={true}
            aria-label={`${p.name} is the primary provider`}
          >
            <span className="settings__radio settings__radio--on" />Primary
          </span>
        ) : (
          <span
            className="settings__setprimary"
            role="radio"
            aria-checked={false}
            aria-label={`Set ${p.name} as primary provider`}
            tabIndex={0}
            onClick={() => setPrimary(p.id)}
            onKeyDown={onActivate(() => setPrimary(p.id))}
          >
            <span className="settings__radio" />Set as primary
          </span>
        )}
      </div>
      {p.connected ? (
        <div className="settings__pfields">
          <span className="settings__clihint">
            ✓ connected to <span className="mono">{p.baseUrl}</span> — saved until you disconnect
          </span>
          <button type="button" className="settings__disconnect" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <div className="settings__pfields">
            <input
              className="settings__input mono"
              value={p.baseUrl}
              placeholder="http://localhost:1234"
              onChange={(e) =>
                updateProvider(p.id, { baseUrl: e.target.value, connected: false })
              }
            />
            <span
              className="settings__test"
              role="button"
              tabIndex={0}
              aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${p.name}`}
              onClick={runTest}
              onKeyDown={onActivate(runTest)}
            >
              {status === 'unreachable' ? 'Retry' : 'Connect'}
            </span>
          </div>
          <div className="settings__pfields">
            <KeyInput
              value={p.apiKey}
              placeholder="API key (if your server needs one)"
              ariaLabel={`API key for ${p.name}`}
              onChange={(val) => updateProvider(p.id, { apiKey: val, connected: false })}
            />
          </div>
        </>
      )}

      {/* which model + how hard it thinks — always your call */}
      <ModelEffortRow p={p} />
    </div>
  )
}

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
 * Model + thinking-effort controls. The model list is fetched LIVE from the
 * provider's own models endpoint — nothing hardcoded. CLI providers expose no
 * listing API, so they keep a free-text field (aliases like opus/fable work).
 */
function ModelEffortRow({ p }: { p: ProviderConfig }) {
  const { updateProvider } = useSettings()
  const [models, setModels] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [customCli, setCustomCli] = useState(false)
  const cli = isCliProvider(p.id)
  const cliChoices = cli ? CLI_MODEL_CHOICES[p.id] : undefined

  const loadModels = async () => {
    setLoadingModels(true)
    const list = await listProviderModels(p)
    setModels(list)
    setLoadingModels(false)
  }

  return (
    <div className="settings__pfields settings__modelrow">
      {cli && cliChoices && !customCli ? (
        <select
          className="settings__input mono"
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
          className="settings__input mono"
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
          className="settings__input mono"
          value={p.model ?? ''}
          placeholder={cli ? 'model — any id your CLI accepts' : 'model — provider default'}
          aria-label={`Model for ${p.name}`}
          onChange={(e) => updateProvider(p.id, { model: e.target.value })}
        />
      )}
      {!cli && (
        <button
          type="button"
          className="settings__loadmodels mono"
          disabled={loadingModels}
          onClick={() => void loadModels()}
        >
          {loadingModels ? 'loading…' : models === null ? '▾ load models' : models.length ? `↻ ${models.length}` : 'none found'}
        </button>
      )}
      <label className="settings__effort mono">
        thinking
        <select
          className="settings__effortsel"
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

/** One Settings card per cloud brand — mode switch: API key OR subscription. */
function BrandCard({ v }: { v: BrandView }) {
  const { updateProvider, setPrimary } = useSettings()
  const p = v.active
  // A saved connection survives restarts: start green when p.connected.
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'saved' : 'idle')
  // The CLI's own words when it is installed but cannot answer — shown, never
  // paraphrased into a cheerful "installed".
  const [cliDetail, setCliDetail] = useState('')

  const runTest = async () => {
    setStatus('testing')
    // `force`: an explicit Connect/Retry click always re-asks, cache or not —
    // that click IS the user saying "check it again now".
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id, { force: true })
    setStatus(res)
    setCliDetail(isCliProvider(p.id) ? (cachedCliProbe(p.id)?.detail ?? '') : '')
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
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

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span
          className={'settings__toggle ' + (v.enabled ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={v.enabled}
          aria-label={`Enable ${v.name}`}
          tabIndex={0}
          onClick={toggle}
          onKeyDown={onActivate(toggle)}
        >
          <span className={'settings__knob' + (v.enabled ? '' : ' settings__knob--off')} />
        </span>
        <SettingsLogo id={v.brand} />
        <span className="settings__pname">{v.name}</span>

        <StatusPill status={status} cli={v.mode === 'cli'} detail={cliDetail} />

        <span className="settings__spacer" />

        {v.enabled &&
          (p.primary ? (
            <span
              className="settings__primary"
              role="radio"
              aria-checked={true}
              aria-label={`${v.name} is the primary provider`}
            >
              <span className="settings__radio settings__radio--on" />Primary
            </span>
          ) : (
            <span
              className="settings__setprimary"
              role="radio"
              aria-checked={false}
              aria-label={`Set ${v.name} as primary provider`}
              tabIndex={0}
              onClick={() => setPrimary(p.id)}
              onKeyDown={onActivate(() => setPrimary(p.id))}
            >
              <span className="settings__radio" />Set as primary
            </span>
          ))}
      </div>

      {v.enabled && (
        <>
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
            <div className="settings__pfields">
              <span className="settings__clihint">
                {v.mode === 'api'
                  ? '✓ credential saved — held by the Gateway, never shown again'
                  : '✓ connected via your subscription sign-in on this Mac'}
              </span>
              <button type="button" className="settings__disconnect" onClick={disconnect}>
                Disconnect
              </button>
            </div>
          ) : (
            <>
              {/* Installed but refusing to answer is a DIFFERENT problem from
                  not installed, and only the CLI itself can say which — so its
                  own error line is shown verbatim. */}
              {v.mode === 'cli' && status === 'auth' && cliDetail && (
                <div className="settings__clierror mono">{cliDetail}</div>
              )}
              <div className="settings__pfields">
                {v.mode === 'cli' ? (
                  <span className="settings__clihint">{CLI_PROVIDERS[p.id].hint}</span>
                ) : (
                  <KeyInput
                    value={p.apiKey}
                    placeholder="API key"
                    ariaLabel={`API key for ${v.name}`}
                    onChange={(val) => updateProvider(p.id, { apiKey: val, connected: false })}
                  />
                )}
                <span
                  className="settings__test"
                  role="button"
                  tabIndex={0}
                  aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${v.name}`}
                  onClick={runTest}
                  onKeyDown={onActivate(runTest)}
                >
                  {status === 'unreachable' ? 'Retry' : 'Connect'}
                </span>
              </div>
              {v.mode === 'api' && KEY_URLS[p.id] && (
                <button
                  type="button"
                  className="settings__getkey"
                  onClick={() => openExternal(KEY_URLS[p.id])}
                >
                  Get a {v.name} API key ↗
                </button>
              )}
              {v.mode === 'cli' && (
                <button
                  type="button"
                  className="settings__getkey"
                  onClick={() => openExternal(CLI_PROVIDERS[p.id].install)}
                >
                  Install ↗
                </button>
              )}
            </>
          )}

          {/* which model + how hard it thinks — always your call */}
          <ModelEffortRow p={p} />
        </>
      )}
    </div>
  )
}

/** Custom OpenAI-compatible service card (Settings). */
function CustomCard({ p }: { p: ProviderConfig }) {
  const { updateProvider, setPrimary, removeProvider } = useSettings()
  const [status, setStatus] = useState<TestStatus>(p.connected ? 'saved' : 'idle')

  const runTest = async () => {
    setStatus('testing')
    // `force`: an explicit Connect/Retry click always re-asks, cache or not —
    // that click IS the user saying "check it again now". (A custom service is
    // an HTTP endpoint, never a CLI bridge, so there is no probe cache here.)
    const res = await pingProvider(p.baseUrl, p.apiKey, p.id, { force: true })
    setStatus(res)
    if (res === 'ok') updateProvider(p.id, { connected: true })
  }

  const disconnect = () => {
    updateProvider(p.id, { connected: false, apiKey: '' })
    setStatus('idle')
  }

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span
          className={'settings__toggle ' + (p.enabled ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={p.enabled}
          aria-label={`Enable ${p.name}`}
          tabIndex={0}
          onClick={() => updateProvider(p.id, { enabled: !p.enabled })}
          onKeyDown={onActivate(() => updateProvider(p.id, { enabled: !p.enabled }))}
        >
          <span className={'settings__knob' + (p.enabled ? '' : ' settings__knob--off')} />
        </span>
        <SettingsLogo id="local" />
        <input
          className="settings__nameinput"
          value={p.name}
          aria-label="Custom service name"
          onChange={(e) => updateProvider(p.id, { name: e.target.value })}
        />

        {status === 'ok' && (
          <span className="settings__status settings__status--ok mono">
            <span className="settings__statusdot" />connected
          </span>
        )}
        {status === 'auth' && (
          <span className="settings__status settings__status--auth mono">
            <span className="settings__statusdot settings__statusdot--auth" />needs a key
          </span>
        )}
        {status === 'unreachable' && (
          <span className="settings__status settings__status--err mono">
            <span className="settings__statusdot settings__statusdot--err" />unreachable
          </span>
        )}
        {status === 'testing' && <span className="settings__status mono">testing…</span>}

        <span className="settings__spacer" />

        {p.enabled &&
          (p.primary ? (
            <span
              className="settings__primary"
              role="radio"
              aria-checked={true}
              aria-label={`${p.name} is the primary provider`}
            >
              <span className="settings__radio settings__radio--on" />Primary
            </span>
          ) : (
            <span
              className="settings__setprimary"
              role="radio"
              aria-checked={false}
              aria-label={`Set ${p.name} as primary provider`}
              tabIndex={0}
              onClick={() => setPrimary(p.id)}
              onKeyDown={onActivate(() => setPrimary(p.id))}
            >
              <span className="settings__radio" />Set as primary
            </span>
          ))}
        <button
          type="button"
          className="settings__remove"
          aria-label={`Remove ${p.name}`}
          onClick={() => removeProvider(p.id)}
        >
          ✕
        </button>
      </div>

      {p.enabled && p.connected && (
        <div className="settings__pfields">
          <span className="settings__clihint">
            ✓ connected to <span className="mono">{p.baseUrl}</span> — saved until you disconnect
          </span>
          <button type="button" className="settings__disconnect" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
      {p.enabled && !p.connected && (
        <>
          <div className="settings__pfields">
            <select
              className="settings__input mono"
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
          <div className="settings__pfields">
            <input
              className="settings__input mono"
              value={p.baseUrl}
              placeholder="https://your-server.example.com  (OpenAI-compatible)"
              onChange={(e) =>
                updateProvider(p.id, { baseUrl: e.target.value, connected: false })
              }
            />
            <span
              className="settings__test"
              role="button"
              tabIndex={0}
              aria-label={`${status === 'unreachable' ? 'Retry connecting' : 'Connect'} to ${p.name}`}
              onClick={runTest}
              onKeyDown={onActivate(runTest)}
            >
              {status === 'unreachable' ? 'Retry' : 'Connect'}
            </span>
          </div>
          <div className="settings__pfields">
            <KeyInput
              value={p.apiKey}
              placeholder="API key (if the service needs one)"
              ariaLabel={`API key for ${p.name}`}
              onChange={(val) => updateProvider(p.id, { apiKey: val, connected: false })}
            />
            <input
              className="settings__input mono"
              value={p.model ?? ''}
              placeholder="model id (e.g. deepseek-chat)"
              aria-label={`Model for ${p.name}`}
              onChange={(e) => updateProvider(p.id, { model: e.target.value })}
            />
          </div>
          <div className="provider__guide">
            <div className="provider__guidetitle">How to connect</div>
            <div className="provider__guidestep"><b>Easy way:</b> pick a service from the dropdown — URL and model fill in; paste the key, press <b>Connect</b>.</div>
            <div className="provider__guidestep"><b>Manual:</b> 1&nbsp;·&nbsp;base URL from the service&rsquo;s docs (no <span className="mono">/chat/completions</span>) &nbsp;2&nbsp;·&nbsp;API key if needed &nbsp;3&nbsp;·&nbsp;model id exactly as documented &nbsp;4&nbsp;·&nbsp;Connect.</div>
          </div>
        </>
      )}
    </div>
  )
}

/** Engine extensions: honest availability + opt-in toggles + GRPO status. */
function EngineExtensions() {
  const { settings, setEngineFlag } = useSettings()
  const [avail, setAvail] = useState<ExtensionAvailability | null>(null)
  const [records, setRecords] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void checkExtensions().then((a) => {
      if (!cancelled) setAvail(a)
    })
    // Guard the vault-path resolve (it calls the native path plugin) so the
    // browser/non-native context doesn't hit an unguarded homeDir()/appDataDir().
    if (isNative()) {
      void resolveVaultDir(settings.vaultPath)
        .then(readTrainingCount)
        .then((n) => {
          if (!cancelled) setRecords(n)
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows: {
    key: 'lightrag' | 'deepeval' | 'bifrost'
    name: string
    desc: string
  }[] = [
    {
      key: 'lightrag',
      name: 'LightRAG (graph retrieval)',
      desc: 'graph-RAG over your vault · runs on the py3.12 runtime',
    },
    {
      key: 'deepeval',
      name: 'DeepEval (LLM judge)',
      desc: 'Tier-2 judged evals via DeepEval · built-in judge otherwise',
    },
    {
      key: 'bifrost',
      // Naming honesty (decision 4, 2026-08-31): our own Go daemon carries
      // OUR name in every user-facing surface — we don't trade on the
      // upstream Bifrost project's. Internal identifiers migrate post-launch.
      name: 'Prism Gateway (Go daemon)',
      desc: 'routes model calls through the compiled Go daemon over a Unix socket',
    },
  ]

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span className="settings__kicker">Engine extensions</span>
        <span className="settings__spacer" />
        <span className="settings__instant">opt-in · applies to the next run</span>
      </div>
      {rows.map((r) => {
        const available = avail ? avail[r.key] : false
        const on = settings.engineFlags[r.key]
        return (
          <div className="settings__prow settings__extrow" key={r.key}>
            <span
              className={
                'settings__toggle ' +
                (on && available ? 'settings__toggle--on' : 'settings__toggle--off') +
                (available ? '' : ' settings__toggle--disabled')
              }
              role="switch"
              aria-checked={on && available}
              aria-label={`Enable ${r.name}`}
              aria-disabled={!available}
              tabIndex={0}
              onClick={() => available && setEngineFlag(r.key, !on)}
              onKeyDown={onActivate(() => available && setEngineFlag(r.key, !on))}
            >
              <span className={'settings__knob' + (on && available ? '' : ' settings__knob--off')} />
            </span>
            <div className="settings__extinfo">
              <span className="settings__pname">{r.name}</span>
              <span className="settings__clihint">{r.desc}</span>
            </div>
            <span className="settings__spacer" />
            {avail === null ? (
              <span className="settings__status mono">checking…</span>
            ) : available ? (
              <span className="settings__status settings__status--ok mono">
                <span className="settings__statusdot" />available on this Mac
              </span>
            ) : (
              <span className="settings__status settings__status--auth mono">
                <span className="settings__statusdot settings__statusdot--auth" />not installed here
              </span>
            )}
          </div>
        )
      })}
      <div className="settings__prow settings__extrow">
        <div className="settings__extinfo">
          <span className="settings__pname">GRPO learning</span>
          <span className="settings__clihint">
            training records collect automatically from PASSING verdicts; the actual fine-tune
            needs a GPU machine
          </span>
        </div>
        <span className="settings__spacer" />
        <span className="settings__status mono">
          {records === null ? '…' : `${records} record${records === 1 ? '' : 's'} collected`}
        </span>
      </div>
      {settings.engineFlags.lightrag && settings.engineFlags.deepeval && (
        <div className="settings__resethint">
          Note: LightRAG and DeepEval use different runtimes — with both on, LightRAG&rsquo;s
          runtime wins and DeepEval falls back to the built-in judge for that run.
        </div>
      )}
    </div>
  )
}

/**
 * Routing mode (R1). Two honest, mutually-exclusive lanes for the DEFAULT route
 * decision: pin your primary (current behavior — it always answers), or hand the
 * default lane to SC Prism's adopted router (Auto). Auto is the ONLY mode in
 * which an adopted route policy is live; sensitivity always forces local and a
 * reasoning intent still prefers cloud when one is configured.
 */
/**
 * Company hosting (phase A slice 1). Visible in host mode only: the REAL join
 * code (minted once when hosting was chosen) and this Mac's name. Honest
 * about the seam under construction — member joining ships next, and the
 * card says so in those words rather than faking a joinable endpoint.
 */
function HostingCard() {
  const { settings, setCompanyMode } = useSettings()
  const [confirming, setConfirming] = useState(false)
  if (settings.companyMode !== 'host') return null
  const code = settings.companyCode || '(minting…)'
  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span className="settings__kicker">Company hosting</span>
        <span className="settings__spacer" />
        <span className="settings__instant">this Mac is the company server</span>
      </div>

      {/* THE CREDENTIAL, given prominence — a join code the admin must be able
          to read and hand over is not a footnote (2026-08-31: it rendered as
          floating text and the only control silently switched hosting off). */}
      <div className="settings__joinbox">
        <span className="settings__joinlabel mono">JOIN CODE</span>
        <span className="settings__joincode mono">{code}</span>
        <span className="settings__spacer" />
        <button
          type="button"
          className="settings__joincopy mono"
          onClick={() => void navigator.clipboard?.writeText(code).catch(() => {})}
        >
          copy
        </button>
      </div>

      <div className="settings__hostwhat">
        <div className="settings__hoststep">
          <b>1.</b> Your teammate installs SC Prism and picks{' '}
          <b>&ldquo;My company&rdquo;</b> at the welcome screen.
        </div>
        <div className="settings__hoststep">
          <b>2.</b> They enter this join code and your gateway address. Your Mac
          must be reachable from their machine (same network, or a tunnel you
          run).
        </div>
        <div className="settings__hoststep">
          <b>3.</b> They land on <b>your</b> Needs-You desk as <b>pending</b>.
          Nothing of yours is readable until you approve them.
        </div>
        <div className="settings__hoststep">
          <b>4.</b> Approved, their runs go through your gateway, on your keys,
          under your governance, into one company vault. They never hold a key,
          and removing them cuts access immediately.
        </div>
      </div>

      <div className="settings__hostnote mono">
        Member joining is not in this build yet — steps 2–4 arrive in the next
        release. Your code is real and will be honored then; nothing listens on
        the network today.
      </div>

      {confirming ? (
        <div className="settings__hostconfirm">
          <span className="settings__hostconfirmtext mono">
            Turn hosting off? Your join code is kept, and the app goes back to
            solo mode.
          </span>
          <button
            type="button"
            className="settings__hostbtn settings__hostbtn--danger"
            onClick={() => {
              setCompanyMode('solo')
              setConfirming(false)
            }}
          >
            Yes, back to solo
          </button>
          <button type="button" className="settings__hostbtn" onClick={() => setConfirming(false)}>
            Keep hosting
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings__hostbtn"
          onClick={() => setConfirming(true)}
        >
          Stop hosting…
        </button>
      )}
    </div>
  )
}

function RoutingModeCard() {
  const { settings, setRoutingMode, setRouteBias } = useSettings()
  const mode = settings.routingMode
  const primaryName = primaryDisplayName(settings)

  const option = (id: RoutingModeId, title: string, desc: string) => {
    const on = mode === id
    return (
      <div
        className={'settings__routeopt' + (on ? ' settings__routeopt--on' : '')}
        role="radio"
        aria-checked={on}
        aria-label={title}
        tabIndex={0}
        onClick={() => setRoutingMode(id)}
        onKeyDown={onActivate(() => setRoutingMode(id))}
      >
        <span className={'settings__radio' + (on ? ' settings__radio--on' : '')} />
        <span className="settings__routetext">
          <span className="settings__routetitle">{title}</span>
          <span className="settings__clihint">{desc}</span>
        </span>
      </div>
    )
  }

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span className="settings__kicker">Routing</span>
        <span className="settings__spacer" />
        <span className="settings__instant">how the default lane is decided</span>
      </div>
      <div className="settings__routes" role="radiogroup" aria-label="Routing mode">
        {option(
          'pinned',
          'Pinned — always use your primary',
          `your chosen primary (${primaryName}) answers the default lane; sensitive work still stays local`,
        )}
        {option(
          'auto',
          'Auto — let SC Prism route local↔cloud',
          'uses your adopted router · sensitive work still stays local, reasoning still prefers a configured cloud',
        )}
      </div>
      <DependencyDial bias={settings.routeBias} onChange={setRouteBias} />
      <YourAIsRow />
      <BudgetRow />
    </div>
  )
}

/**
 * The token budget, made visible (Sukhdeep, 2026-09-03: "How many token I use?
 * What is the budget?").
 *
 * Built after a live three-agent board spent 110,873 tokens against the
 * invisible 100,000 default: the third agent never got a turn and the manager
 * returned an empty answer. The limit was working exactly as designed and was
 * impossible to see, which is indistinguishable from a bug.
 *
 * Shows the budget actually in force — including when the user has set none,
 * because the engine's default is enforced whether or not anyone chose it.
 */
function BudgetRow() {
  const { settings, setTokenBudget } = useSettings()
  // Settings renders OUTSIDE <AppProvider> (it is reachable from the setup
  // wizard), so it reads the same durable session the store restores from —
  // the established pattern beside `persistedVerdicts`. Same records as the
  // run history, so the two can never disagree.
  const stats = persistedStats()
  const verdicts = persistedVerdicts()
  const localSharePct = stats.localSharePct
  const [draft, setDraft] = useState(String(settings.tokenBudget || DEFAULT_TOKEN_BUDGET))

  // Today's TOTAL is its own fact, not a fraction of a PER-RUN budget. Showing
  // "3,570,818 of 100,000" pinned the bar red forever and claimed a run had
  // stopped when none had (found on the real screen, 2026-09-03).
  const today = dailyUsage(stats.tokensToday, verdicts.length)
  const cloudPct = Math.max(0, 100 - localSharePct)

  const commit = () => {
    const next = clampBudget(Number(draft))
    setTokenBudget(next)
    setDraft(String(next || DEFAULT_TOKEN_BUDGET))
  }

  return (
    <div className="settings__budget">
      <div className="settings__budgetrow">
        <label className="settings__leanlabel" htmlFor="tokbudget">
          Token budget
        </label>
        <input
          id="tokbudget"
          className="settings__budgetinput mono"
          type="number"
          min={10000}
          max={2000000}
          step={10000}
          aria-label="tokens per run"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
        <span className="settings__clihint">
          tokens per run{settings.tokenBudget ? '' : ` (default ${DEFAULT_TOKEN_BUDGET.toLocaleString()})`}
        </span>
      </div>

      <div className="settings__clihint settings__budgetnote">
        A run that reaches this stops and reports what it finished — it is a cap
        on ONE run, not a daily allowance.
      </div>
      <div className="settings__clihint">
        <strong>{today.label}</strong>
      </div>

      {/* Where the work actually ran — derived from the recorded runs, not an
          estimate, so it cannot disagree with the run history. */}
      <div className="settings__splitrow">
        <span className="settings__splitbar">
          <span className="settings__splitlocal" style={{ width: `${localSharePct}%` }} />
        </span>
        <span className="settings__clihint">
          <strong>{localSharePct}%</strong> on your Mac · <strong>{cloudPct}%</strong> in the cloud
        </span>
      </div>
    </div>
  )
}

/**
 * Sukhdeep, 2026-08-31: "If user want to run all the agent on local only… a
 * bit of Gemini and local… totally on a cloud". The dial above biases ONE
 * chat send; this row moves the whole CREW in a click, writing each seat's
 * model to its vault file (the source of truth) exactly like the Agents page
 * does. A lean whose brand is not connected is DISABLED, not silently
 * ignored — the app never points a seat at a dead provider.
 */
/**
 * YOUR AIs — one row per AI the user has actually connected.
 *
 * Replaces three overlapping controls (Sukhdeep, 2026-09-03: "I can see the
 * option all local / balanced / all Claude, but I have more than two AIs …
 * you just give me a token budget for all of them together, but I need token
 * budget for each and every AI … it's a bit confusing").
 *
 * Two things were actually broken, not just confusing:
 *   - "All cloud" picked the first cloud it found, so with Claude AND Gemini
 *     connected the button silently meant "all Claude" and Gemini could never
 *     be chosen. There is now one button per cloud the user has.
 *   - One token budget governed every AI at once, which cannot express "ten
 *     million on Claude, half a million on Gemini". Each AI has its own.
 */
function YourAIsRow() {
  const { settings, setBrandBudget } = useSettings()
  const agents = useAgents()
  const [applied, setApplied] = useState('')

  // A brand counts as connected when the user has an enabled, connected
  // provider for it — the same test the rest of Settings uses.
  const brands: { brand: Brand; label: string; estimated: boolean }[] = []
  for (const p of settings.providers) {
    if (!p.enabled || !p.connected) continue
    const b = brandOf(p.id)
    if (b === 'other' || brands.some((x) => x.brand === b)) continue
    brands.push({
      brand: b,
      label: b === 'local' ? 'Local model' : b === 'openai' ? 'OpenAI' : b === 'claude' ? 'Claude' : 'Gemini',
      estimated: isEstimatedSpend(p.id),
    })
  }

  const connected = brands.map((b) => b.brand)
  const clouds = brands.filter((b) => b.brand !== 'local')
  const hasLocal = connected.includes('local')
  const crew = agents.filter((a) => a.enabled)

  const apply = (lean: CrewLean, cloud: AgentModel | undefined, label: string) => {
    const plan = crewModelPlan(crew, lean, connected, cloud)
    if (!plan.length) return
    for (const row of plan) {
      const a = agents.find((x) => x.id === row.id)
      if (!a || a.model === row.model) continue
      updateAgent(a.id, { model: row.model })
      void persistAgentToVault({ ...a, model: row.model }, settings.vaultPath)
    }
    setApplied(`${label} — ${plan.length} seat${plan.length === 1 ? '' : 's'} moved`)
  }

  const seatsOn = (brand: Brand) =>
    crew.filter((a) => brandOf(String(a.model)) === brand).length

  return (
    <div className="settings__ais">
      <div className="settings__prow">
        <span className="settings__kicker">Your AIs</span>
        <span className="settings__spacer" />
        <span className="settings__instant">a token alert for each one</span>
      </div>

      {brands.length === 0 ? (
        <div className="settings__clihint">
          No AI connected yet — connect one above and it appears here.
        </div>
      ) : (
        <div className="settings__ailist">
          {brands.map(({ brand, label, estimated }) => {
            const budget = settings.brandBudgets?.[brand] ?? 0
            const st = brandBudgetStatus({ brand, spent: 0, budget, estimated })
            return (
              <div className="settings__airow" key={brand}>
                <span className="settings__ainame">{label}</span>
                <span className="settings__aiseats mono">
                  {seatsOn(brand)} of {crew.length} seats
                </span>
                <input
                  className="settings__budgetinput mono"
                  type="number"
                  min={0}
                  step={100000}
                  aria-label={`token alert for ${label}`}
                  defaultValue={budget}
                  onBlur={(e) => setBrandBudget(brand, Number(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <span className="settings__clihint settings__aihint">
                  {budget === 0 ? 'no alert — unlimited' : st.note}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="settings__clihint settings__ainote">
        0 means <strong>unlimited</strong> — no alert for that AI. An alert is
        your own number counting what we spent; it never blocks a run, it tells
        you. We cannot read any provider&rsquo;s real plan balance, so nothing
        here claims to.
        {brands.some((b) => b.estimated) && (
          <>
            {' '}A subscription CLI reports no usage, so its count is a floor —
            the real figure is higher by an unknown amount.
          </>
        )}
      </div>

      <div className="settings__leanrow">
        <span className="settings__leanlabel">Move the whole crew</span>
        <button
          type="button"
          className="settings__leanbtn"
          disabled={!hasLocal || !crew.length}
          onClick={() => apply('local', undefined, 'All local')}
        >
          All local
        </button>
        {clouds.map((c) => (
          <button
            key={`bal-${c.brand}`}
            type="button"
            className="settings__leanbtn"
            disabled={!hasLocal || !crew.length}
            onClick={() => apply('balanced', c.brand as AgentModel, `Balanced with ${c.label}`)}
          >
            Balanced · {c.label}
          </button>
        ))}
        {clouds.map((c) => (
          <button
            key={`all-${c.brand}`}
            type="button"
            className="settings__leanbtn"
            disabled={!crew.length}
            onClick={() => apply('cloud', c.brand as AgentModel, `All on ${c.label}`)}
          >
            All on {c.label}
          </button>
        ))}
      </div>
      <div className="settings__clihint settings__leanhint">
        {applied ? (
          <strong>{applied}</strong>
        ) : (
          <>
            <b>All local</b> — every seat on your machine, nothing leaves it.{' '}
            <b>Balanced</b> — seats that read your notes stay local, the rest use
            that AI. <b>All on …</b> — every seat on that AI, except anything the
            privacy floor pulls back.
          </>
        )}
      </div>
    </div>
  )
}

// Slider order is the dial's mental model: your own hardware on the left, the
// cloud on the right, today's untouched behavior in the middle.
const BIAS_STOPS: RouteBias[] = ['local', 'auto', 'cloud']
const BIAS_COPY: Record<RouteBias, { word: string; desc: string }> = {
  local: { word: 'Local first', desc: 'everyday sends run on your own hardware; cloud only when you ask' },
  auto: { word: 'Balanced', desc: 'each send decides normally' },
  cloud: { word: 'Online first', desc: 'everyday sends go to your primary cloud; local when you ask' },
}

function DependencyDial({ bias, onChange }: { bias: RouteBias; onChange: (b: RouteBias) => void }) {
  const idx = Math.max(0, BIAS_STOPS.indexOf(bias))
  const copy = BIAS_COPY[BIAS_STOPS[idx] ?? 'auto']
  return (
    <div className="settings__dial">
      <div className="settings__dialrow">
        <span className="settings__dialend">Local first</span>
        <input
          className="settings__dialrange"
          type="range"
          min={0}
          max={2}
          step={1}
          value={idx}
          aria-label="Dependency dial — local ↔ online"
          aria-valuetext={copy.word}
          onChange={(e) => onChange(BIAS_STOPS[Number(e.target.value)] ?? 'auto')}
        />
        <span className="settings__dialend">Online first</span>
      </div>
      <div className="settings__clihint settings__dialhint">
        <strong>{copy.word}</strong> — {copy.desc} · your message&rsquo;s own choice and the
        privacy floor always outrank the dial
      </div>
    </div>
  )
}

// Per-server test result (Test button). Never fabricated — 'ok' only holds
// tools the engine's live MCP handshake actually returned; 'error' only ever
// carries the real error string surfaced by the Rust bridge.
type McpTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; tools: McpToolInfo[] }
  | { status: 'error'; message: string }

/** Small honest summary of a server's live tool list for the Test result row. */
function summarizeTools(tools: McpToolInfo[]): string {
  // A reachable server that advertised nothing: say so plainly, not a dangling
  // "0 tools: " with an empty list after the colon.
  if (tools.length === 0) return 'no tools'
  const names = tools.map((t) => t.name)
  const shown = names.slice(0, 4)
  const more = names.length > shown.length
  const noun = tools.length === 1 ? 'tool' : 'tools'
  return `${tools.length} ${noun}: ${shown.join(', ')}${more ? ', …' : ''}`
}

/**
 * Register/edit/remove MCP servers (`<vault>/mcp-servers.json`) and test one
 * live via the engine's real `mcp --action list` handshake (ADR-009). Purely
 * presentation + the thin native bridge above — the engine already governs
 * every call (allow-list + sensitivity gate); this never fabricates a tool
 * list or a fake "connected" status.
 */
function McpServers() {
  const { settings, setMcpApproval } = useSettings()
  const [vault, setVault] = useState('')
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [approvals, setApprovals] = useState<McpApprovalPolicy>({ require: [], granted: [] })
  const [tests, setTests] = useState<Record<string, McpTestState>>({})
  const [editingName, setEditingName] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  // The server name whose Remove is armed (in-app two-step confirm) — replaces
  // the old native window.confirm so no destructive click ever hits an OS dialog.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  // S2: the ORIGINAL argv of the entry being edited. The command field flattens
  // argv with join(' '), which can't represent an argument that itself contains
  // a space — so on save we reuse this verbatim UNLESS the user actually changed
  // the field, keeping a hand-authored ["node","/My Servers/x.js"] non-lossy.
  const [editCommandOrig, setEditCommandOrig] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // Guard the vault-path resolve (it calls the native path plugin) so the
    // browser/non-native context doesn't hit an unguarded homeDir()/appDataDir()
    // — mirrors EngineExtensions' own resolveVaultDir guard above.
    if (isNative()) {
      void resolveVaultDir(settings.vaultPath).then(async (v) => {
        if (cancelled) return
        setVault(v)
        const list = await readMcpServers(v)
        if (!cancelled) setServers(list)
        const policy = await readMcpApprovals(v)
        if (!cancelled) setApprovals(policy)
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetForm = () => {
    setEditingName(null)
    setName('')
    setCommand('')
    setAllowedTools('')
    setFormError(null)
    setEditCommandOrig(null)
  }

  // Drop a stale handshake result for a server whose command is about to change
  // (S1) — a just-edited command must never keep the OLD green "N tools" result.
  const clearTest = (key: string) =>
    setTests((t) => {
      if (!(key in t)) return t
      const rest = { ...t }
      delete rest[key]
      return rest
    })

  const startEdit = (s: McpServerConfig) => {
    setEditingName(s.name)
    setName(s.name)
    setCommand(s.command.join(' '))
    setAllowedTools((s.allowed_tools ?? []).join(', '))
    setFormError(null)
    setEditCommandOrig(s.command)
    // The command may change while editing — its prior handshake result is now
    // provisional, so retire it until the user re-Tests (S1).
    clearTest(s.name)
  }

  const save = async () => {
    const trimmedName = name.trim()
    // S2: non-lossy argv — reuse the original verbatim when the command field is
    // unchanged (join(' ') can't represent a space-containing argument).
    const argv = mcpSaveArgv(command, editCommandOrig)
    if (!trimmedName || argv.length === 0) {
      setFormError('a name and a command are both required')
      return
    }
    if (servers.some((s) => s.name === trimmedName && s.name !== editingName)) {
      setFormError(`a server named "${trimmedName}" already exists`)
      return
    }
    // Minor: Save can fire before the vault path has resolved (vault==='') —
    // writing then lands OUTSIDE the vault. Resolve it first; bail honestly if
    // it still can't be determined.
    const dir = vault || (isNative() ? await resolveVaultDir(settings.vaultPath) : '')
    if (!dir) {
      setFormError('still resolving the vault path — try again in a moment')
      return
    }
    if (!vault) setVault(dir)
    const allowed = allowedTools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const entry: McpServerConfig = {
      name: trimmedName,
      command: argv,
      ...(allowed.length ? { allowed_tools: allowed } : {}),
    }
    const next = editingName
      ? servers.map((s) => (s.name === editingName ? entry : s))
      : [...servers, entry]
    const ok = await writeMcpServers(dir, next)
    if (!ok) {
      setFormError("couldn't save — try again")
      return
    }
    setServers(next)
    // S1: a saved (possibly renamed) entry's OLD handshake result is now stale —
    // clear the entry's key AND the renamed-from key so no untested command
    // shows a live-looking green result.
    for (const key of mcpTestKeysToClear(trimmedName, editingName)) clearTest(key)
    resetForm()
  }

  const remove = async (s: McpServerConfig) => {
    setConfirmRemove(null)
    const next = servers.filter((x) => x.name !== s.name)
    const ok = await writeMcpServers(vault, next)
    if (!ok) {
      setFormError(`couldn't remove "${s.name}" — try again`)
      return
    }
    setFormError(null)
    setServers(next)
    setTests((t) => {
      const rest = { ...t }
      delete rest[s.name]
      return rest
    })
    if (editingName === s.name) resetForm()
  }

  const test = async (s: McpServerConfig) => {
    setTests((t) => ({ ...t, [s.name]: { status: 'testing' } }))
    const res = await runNativeMcpList(vault, s.name)
    setTests((t) => ({
      ...t,
      [s.name]: res.ok ? { status: 'ok', tools: res.tools } : { status: 'error', message: res.error },
    }))
  }

  const header = (
    <div className="settings__prow">
      <span className="settings__kicker">Tools · MCP servers</span>
      <span className="settings__spacer" />
      <span className="settings__instant">
        external tools the engine may call · gated by allow-list + sensitivity
      </span>
    </div>
  )

  if (!isNative()) {
    return (
      <div className="settings__provider">
        {header}
        <div className="settings__prow settings__extrow">
          <span className="settings__clihint">register MCP servers in the installed app</span>
        </div>
      </div>
    )
  }

  // Tool posture (companion grant, revocable HERE — the wizard summary's
  // "change in Settings" claim depends on this control). Rewrites the vault's
  // require list ('all' sentinel union/removal, curated names preserved) and
  // mirrors settings.mcpApproval, which also threads `--require-approval all`.
  const askOn = approvals.require.includes('all') || settings.mcpApproval === 'ask'
  const setPosture = async (mode: 'ask' | 'auto') => {
    if (!vault) return
    const policy = await readMcpApprovals(vault)
    const require =
      mode === 'ask'
        ? Array.from(new Set(['all', ...policy.require]))
        : policy.require.filter((n) => n !== 'all')
    // The engine's own vault tools are read-only and zero-egress, so they are
    // pre-granted here too: ask-first must hold the user's MCP/web tools without
    // holding the companion's eyes on its own notes (see withVaultGranted).
    // Every other granted name the user curated is preserved.
    const granted = withVaultGranted(policy.granted)
    const saved = await writeMcpApprovals(vault, { require, granted })
    if (!saved) return
    setMcpApproval(mode)
    setApprovals({ require, granted })
  }

  // WHAT RUNS FREELY vs WHAT WAITS — the read-only class grant, shown in his
  // words and reversible here. `readsFree` is read from the POLICY FILE, the
  // same bytes the engine's gate reads, so this switch can never show a
  // capability that is not the one enforced (toolRisk.ts mirrors, and a parity
  // test pins it to the engine's classification).
  const readsFree = readsRunFree(approvals)
  const setReadsPosture = async (free: boolean) => {
    // Resolve the vault ON DEMAND rather than bailing when the mount effect has
    // not landed yet: the switch is clickable from first paint, and a click that
    // silently does nothing is the worst possible answer to "why does it keep
    // asking me?". `resolveVaultDir` is the same call the effect makes.
    const v = vault || (await resolveVaultDir(settings.vaultPath))
    if (!v) return
    if (v !== vault) setVault(v)
    const policy = await readMcpApprovals(v)
    // One transform for both directions (toolRisk.withReadsFree), so the switch
    // cannot drift from its own inverse. Tightening also marks the choice on the
    // `require` side, which is what makes it survive the next app launch —
    // otherwise the mount migration would quietly free reads again.
    const next = withReadsFree(policy, free)
    const require = [...next.require]
    const granted = [...next.granted]
    const saved = await writeMcpApprovals(v, { require, granted })
    if (!saved) return
    setApprovals({ require, granted })
  }

  return (
    <div className="settings__provider">
      {header}

      <div className="settings__prow settings__extrow">
        <span
          className={'settings__toggle ' + (askOn ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={askOn}
          aria-label="Ask before tool calls"
          tabIndex={0}
          onClick={() => void setPosture(askOn ? 'auto' : 'ask')}
          onKeyDown={onActivate(() => void setPosture(askOn ? 'auto' : 'ask'))}
        >
          <span className={'settings__knob' + (askOn ? '' : ' settings__knob--off')} />
        </span>
        <div className="settings__extinfo">
          <span className="settings__pname">
            {askOn ? 'Ask before tool calls' : 'Tools allowed within the gates'}
          </span>
          <span className="settings__clihint">
            Ask-first holds every tool call on the Work desk until you approve it (and is what the
            mid-run pause acts on). Writes the vault&rsquo;s mcp-approvals.json.
          </span>
        </div>
      </div>

      <div className="settings__prow settings__extrow">
        <span
          className={'settings__toggle ' + (readsFree ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={readsFree}
          aria-label="Let reading run without asking"
          tabIndex={0}
          onClick={() => void setReadsPosture(!readsFree)}
          onKeyDown={onActivate(() => void setReadsPosture(!readsFree))}
        >
          <span className={'settings__knob' + (readsFree ? '' : ' settings__knob--off')} />
        </span>
        <div className="settings__extinfo">
          <span className="settings__pname">
            {readsFree ? 'Let reading run without asking' : 'Hold everything — ask before every tool'}
          </span>
          <span className="settings__clihint">
            {readsFree ? (
              <>
                <b>Runs freely:</b> reading only — your vault ({FIRST_PARTY_READ_ONLY.vault.join(', ')})
                and reading a web page ({FIRST_PARTY_READ_ONLY.web.join(', ')}). These can look but
                cannot change anything.{' '}
                <b>Still waits for you:</b> anything that writes, sends, spends or changes something —
                and every tool from every MCP server you added, whatever its name says, because we
                cannot read their code to prove it only looks. Turn this off to be asked about
                everything again.
              </>
            ) : (
              <>
                Every tool call waits for you, including reading your own notes and web pages — this
                is why an unattended run can stall until it times out. Turn it on to let reading run
                while anything that could change something still waits.
              </>
            )}
          </span>
        </div>
      </div>

      {(approvals.require.length > 0 || approvals.granted.length > 0) && (
        <div className="settings__prow settings__extrow">
          <span className="settings__clihint mono">
            approval: {approvals.require.length} require · {approvals.granted.length} granted
            {readsFree ? ' (incl. read-only class)' : ''} (mcp-approvals.json)
          </span>
        </div>
      )}

      {servers.length === 0 && (
        <div className="settings__prow settings__extrow">
          <span className="settings__clihint">no servers yet — add one below</span>
        </div>
      )}

      {servers.map((s) => {
        const t = tests[s.name] ?? { status: 'idle' }
        return (
          <div className="settings__prow settings__extrow" key={s.name}>
            <div className="settings__extinfo">
              <span className="settings__pname mono">{s.name}</span>
              <span className="settings__clihint">{s.command.join(' ')}</span>
              <span className="settings__clihint">
                {s.allowed_tools && s.allowed_tools.length ? `${s.allowed_tools.length} allowed` : 'all tools'}
              </span>
              {t.status === 'testing' && <span className="settings__status mono">testing…</span>}
              {t.status === 'ok' && (
                <span className="settings__status settings__status--ok mono">
                  <span className="settings__statusdot" />
                  {summarizeTools(t.tools)}
                </span>
              )}
              {t.status === 'error' && (
                <span className="settings__status settings__status--auth mono">
                  <span className="settings__statusdot settings__statusdot--auth" />
                  {t.message}
                </span>
              )}
            </div>
            <span className="settings__spacer" />
            <span
              className="settings__test"
              role="button"
              tabIndex={0}
              aria-label={`Test ${s.name}`}
              onClick={() => void test(s)}
              onKeyDown={onActivate(() => void test(s))}
            >
              {t.status === 'testing' ? 'testing…' : 'Test'}
            </span>
            <span
              className="settings__resetcancel"
              role="button"
              tabIndex={0}
              aria-label={`Edit ${s.name}`}
              onClick={() => startEdit(s)}
              onKeyDown={onActivate(() => startEdit(s))}
            >
              Edit
            </span>
            {confirmRemove === s.name ? (
              <span className="settings__removeconfirm">
                <span className="settings__removeq mono">Remove &ldquo;{s.name}&rdquo;?</span>
                <button
                  type="button"
                  className="settings__removeyes"
                  aria-label={`Confirm remove ${s.name}`}
                  onClick={() => void remove(s)}
                >
                  confirm
                </button>
                <button
                  type="button"
                  className="settings__removeno"
                  aria-label={`Cancel removing ${s.name}`}
                  onClick={() => setConfirmRemove(null)}
                >
                  cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="settings__remove"
                aria-label={`Remove ${s.name}`}
                onClick={() => setConfirmRemove(s.name)}
              >
                ✕
              </button>
            )}
          </div>
        )
      })}

      <div className="settings__mcpform">
        {editingName && <span className="settings__clihint">editing &ldquo;{editingName}&rdquo;</span>}
        <div className="settings__pfields">
          <input
            className="settings__input mono"
            value={name}
            placeholder="server name (e.g. filesystem)"
            aria-label="MCP server name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="settings__pfields">
          <input
            className="settings__input mono"
            value={command}
            placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem /path"
            aria-label="MCP server command"
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
        <div className="settings__pfields">
          <span className="settings__clihint">
            {editCommandOrig && editCommandOrig.some((a) => /\s/.test(a))
              ? 'this command has a space-containing argument — kept as-is unless you change it here; edit multi-arg commands in mcp-servers.json'
              : 'arguments are split on spaces; quoting isn’t supported'}
          </span>
        </div>
        <div className="settings__pfields">
          <input
            className="settings__input mono"
            value={allowedTools}
            placeholder="allowed tools, comma separated (empty = all)"
            aria-label="MCP allowed tools"
            onChange={(e) => setAllowedTools(e.target.value)}
          />
          <span
            className="settings__test"
            role="button"
            tabIndex={0}
            aria-label="Save server"
            onClick={() => void save()}
            onKeyDown={onActivate(() => void save())}
          >
            Save server
          </span>
          {editingName && (
            <span
              className="settings__resetcancel"
              role="button"
              tabIndex={0}
              onClick={resetForm}
              onKeyDown={onActivate(resetForm)}
            >
              Cancel
            </span>
          )}
        </div>
        {formError && <div className="settings__formerror">{formError}</div>}
      </div>
    </div>
  )
}

const THEMES: { id: ThemeId; name: string; preview: string }[] = [
  { id: 'obsidian', name: 'Obsidian', preview: 'obsidian' },
  { id: 'prism', name: 'Prism (dark)', preview: 'prism' },
  { id: 'amber', name: 'Amber', preview: 'daylight' },
]

function ThemeSwatch({
  id,
  name,
  preview,
  active,
  onPick,
}: {
  id: ThemeId
  name: string
  preview: string
  active: boolean
  onPick: (t: ThemeId) => void
}) {
  return (
    <div
      className={'settings__theme' + (active ? ' settings__theme--active' : '')}
      role="radio"
      aria-checked={active}
      aria-label={`${name} theme`}
      tabIndex={0}
      onClick={() => onPick(id)}
      onKeyDown={onActivate(() => onPick(id))}
    >
      <div className={`settings__preview settings__preview--${preview}`}>
        <div className={`settings__pv-left settings__pv-left--${preview}`} />
        <div className={`settings__pv-right settings__pv-right--${preview}`} />
      </div>
      <div className="settings__themefoot">
        <span className={'settings__radio' + (active ? ' settings__radio--on' : '')} />
        <span className={'settings__themename' + (active ? ' settings__themename--active' : '')}>
          {name}
        </span>
        {active && (
          <>
            <span className="settings__spacer" />
            <span className="settings__activetag mono">active</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Web research (web design, 2026-07-23). An opt-in, default-OFF toggle: when on,
 * app-launched runs pass `--web` so the companion can fetch pages + search the
 * web mid-run through the governed v2b tool loop. Honest copy states the egress
 * + gating truthfully. The optional search API key is held by the bridge
 * (persisted, forwarded via env by Rust) and rendered ONLY through a masked
 * password field — never echoed back as plaintext, same discipline as a
 * provider key. Reuses the Engine-extensions toggle affordance + the provider
 * key-field markup; no new control style.
 */
/** Telegram reports (companion grant) — revoke/re-arm the phone link. The
 *  switch only arms after a REAL delivered test message; the token is held like
 *  a provider key (masked, never rendered back). Since the 2026-08-11 two-way
 *  spec this same switch is ALSO the inbound consent: while it is on, a tap
 *  from the configured chat can Approve/Deny something already parked; off
 *  stops the native poller and forgets the token. */
function TelegramCard() {
  const { settings, setTelegramConfig, setTelegramReports } = useSettings()
  const [token, setToken] = useState('')
  const [chat, setChat] = useState(settings.telegramChatId)
  const [status, setStatus] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const sendTest = async () => {
    // The saved token backs an empty field (its placeholder says so); the chat
    // id is VISIBLE in the field, so what you see is exactly what is used —
    // no silent fallback behind a deliberately cleared field (audit L2).
    const useToken = token.trim() || settings.telegramBotToken
    const useChat = chat.trim()
    if (!useToken || !useChat) {
      setStatus('need both the bot token and the chat id')
      return
    }
    setSending(true)
    setStatus(null)
    const err = await sendTelegram(useToken, useChat, 'SC Prism — test message. Reports will arrive like this.')
    if (err === null) {
      setTelegramConfig(useToken, useChat)
      setTelegramReports(true)
      setToken('')
      setStatus('delivered — reports are on')
    } else {
      setStatus(`not delivered — ${err}`)
    }
    setSending(false)
  }

  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span className="settings__kicker">Telegram reports</span>
        <span className="settings__spacer" />
        <span className="settings__instant">
          {settings.telegramReports ? 'on — proven by a real delivery' : 'off'}
        </span>
      </div>
      <div className="settings__pfields">
        <KeyInput
          value={token}
          placeholder={settings.telegramBotToken ? 'bot token saved — paste to replace' : 'bot token (from @BotFather)'}
          ariaLabel="Telegram bot token"
          onChange={setToken}
        />
        <input
          className="settings__input mono"
          value={chat}
          placeholder="chat id (from @userinfobot)"
          aria-label="Telegram chat id"
          onChange={(e) => setChat(e.target.value)}
        />
        <button type="button" className="settings__loadmodels mono" disabled={sending} onClick={() => void sendTest()}>
          {sending ? 'sending…' : 'Send test message'}
        </button>
      </div>
      {status && <div className="settings__prow"><span className="settings__clihint">{status}</span></div>}
      {/* What this switch REALLY does, since 2026-08-11: it is also the inbound
          consent. Off means the poller stops and the token is forgotten. */}
      <div className="settings__prow">
        <span className="settings__clihint">
          {settings.telegramReports
            ? 'on: outcome lines out, and Approve/Deny from that chat id on things already waiting — nothing else'
            : 'off: nothing is sent, and no phone tap can decide anything'}
        </span>
      </div>
      {settings.telegramReports && (
        <div className="settings__prow">
          <button
            type="button"
            className="settings__disconnect"
            onClick={() => {
              setTelegramReports(false)
              setTelegramConfig('', '')
              setChat('')
              setStatus('reports off — token forgotten')
            }}
          >
            Turn off + forget token
          </button>
        </div>
      )}
    </div>
  )
}

function WebResearchCard() {
  const { settings, setWebResearch, setSearchApiKey, setSearchEndpoint } = useSettings()
  const on = settings.webResearch
  return (
    <div className="settings__provider">
      <div className="settings__prow">
        <span className="settings__kicker">Tools · Web research</span>
        <span className="settings__spacer" />
        <span className="settings__instant">{on ? 'on · every call is gated + shown' : 'off by default'}</span>
      </div>
      <div className="settings__prow settings__extrow">
        <span
          className={'settings__toggle ' + (on ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={on}
          aria-label="Enable web research"
          tabIndex={0}
          onClick={() => setWebResearch(!on)}
          onKeyDown={onActivate(() => setWebResearch(!on))}
        >
          <span className={'settings__knob' + (on ? '' : ' settings__knob--off')} />
        </span>
        <div className="settings__extinfo">
          <span className="settings__pname">Let the companion fetch pages + search the web</span>
          <span className="settings__clihint">
            off by default · every call is gated + shown in the run stream · sensitive content is
            never sent to a cloud model
          </span>
        </div>
      </div>
      {on && (
        <div className="settings__pfields">
          <KeyInput
            value={settings.searchApiKey}
            placeholder="search API key — optional · better results · held by the bridge, never rendered"
            ariaLabel="Web search API key"
            onChange={(val) => setSearchApiKey(val)}
          />
          <input
            className="settings__input mono"
            type="text"
            value={settings.searchEndpoint}
            placeholder="search API endpoint — optional (else the keyless default)"
            aria-label="Web search API endpoint"
            onChange={(e) => setSearchEndpoint(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}

function ResetSetup() {
  const { reset } = useOnboarding()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)

  const doReset = () => {
    reset()
    resetInterview()
    navigate('/welcome')
  }

  return (
    <div className="settings__provider settings__danger">
      <div className="settings__prow">
        <span className="settings__kicker">Reset setup</span>
        <span className="settings__spacer" />
        {confirming ? (
          <span className="settings__resetrow">
            <span className="settings__resetwarn mono">This clears onboarding &amp; interview answers.</span>
            <span
              className="settings__resetcancel"
              role="button"
              tabIndex={0}
              onClick={() => setConfirming(false)}
              onKeyDown={onActivate(() => setConfirming(false))}
            >
              Cancel
            </span>
            <button type="button" className="settings__resetgo" onClick={doReset}>
              Reset &amp; restart
            </button>
          </span>
        ) : (
          <button type="button" className="settings__resetbtn" onClick={() => setConfirming(true)}>
            Reset setup
          </button>
        )}
      </div>
      <div className="settings__resethint">
        Reset clears onboarding &amp; interview answers and starts fresh. To walk the wizard
        again WITH your answers kept, use &ldquo;Rerun setup wizard&rdquo; in the left nav — every
        page has Skip when it&rsquo;s already set, and ✕ Close to exit anytime.
      </div>
    </div>
  )
}

/**
 * CHOOSING A LOCAL MODEL, ON EVIDENCE (2026-08-17) — and the measured
 * slow-local warning (2026-08-16) it now carries inside it.
 *
 * The picker was a bare list of ids. He has three local models with wildly
 * different behaviour and no way to tell them apart, so he ran the SLOWEST for
 * days (115s p50) while a faster, stronger one sat unused (9.8s p50); a fourth
 * failure mode (a model that cannot LOAD) reached him as "the provider is
 * unreachable" after he had already selected it.
 *
 * EVERY number below is traceable, and each line says to what:
 *   * speed  — his own `model_call` spans (`localModels.speedForModel`, which
 *     reuses the run budget's one span filter, sleep-outlier drop included);
 *   * quality— the Tier-2 judge's mean score on his own runs;
 *   * memory + load — the local server's OWN `/v1/models/status` report.
 * A model with no recorded runs shows "no runs recorded yet", carries NO speed
 * or quality figure, and is not ranked. There are no vendor claims here, no
 * parameter-count heuristics, and no invented ordering.
 *
 * The old `LocalSpeedNote` is ABSORBED, not duplicated: it reads the same span
 * tail this fetch already made, and still renders only when the configured
 * model is genuinely slow enough to threaten a budget.
 */
function LocalModelPicker({ p, vaultPath }: { p: ProviderConfig; vaultPath: string }) {
  const { updateProvider } = useSettings()
  const [report, setReport] = useState<LocalModelReport | null>(null)
  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [note, setNote] = useState('')
  const [budgetLine, setBudgetLine] = useState('')
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      if (!isNative()) return
      setLoading(true)
      try {
        const vault = await resolveVaultDir(vaultPath)
        const spans = await readSpansTail(vault, 200)
        // The slow-local warning, from the SAME spans — one measurement, two
        // readers (see runBudget's `modelCallSamples`).
        const stats = latencyFromSpans(spans, p.model ?? '')
        const warning = slowLocalNotice(stats)
        const models = await listProviderModels(p)
        // The server's own report. `null` when it doesn't answer — then the
        // rows say the sizes are unknown rather than guessing at them.
        const base = normalizeProviderBase(p.baseUrl)
        const raw = base ? await providerGetJson(modelStatusUrl(base), p.apiKey ?? '') : null
        const parsed = raw ? parseModelStatus(raw) : null
        if (!live) return
        setStatus(parsed)
        setReport(
          buildLocalModelReport({
            models,
            spans,
            verdicts: persistedVerdicts(),
            status: parsed,
            selected: p.model ?? '',
          }),
        )
        if (warning) {
          const b = turnBudget(stats)
          setNote(warning)
          setBudgetLine(
            `Runs are budgeted from this: ${Math.round(b.stallMs / 1000)}s with nothing finishing counts as stalled, ` +
              `${Math.round(b.ceilingMs / 1000)}s is the hard ceiling for one exchange.`,
          )
        } else {
          setNote('')
          setBudgetLine('')
        }
      } catch {
        /* no measurement, no claim */
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, p.baseUrl, p.apiKey, p.model, tick])

  const rows = report?.rows ?? []
  if (rows.length === 0 && !note) return null

  // WHAT EACH MODEL IS FOR (2026-08-29): one evidence-backed pick per kind of
  // work, derived from the SAME rows rendered below — speed-weighted for
  // retrieval/research, quality-weighted for implementer/reviewer, balanced
  // for chat. With nothing measured `picks` is empty and no block renders: no
  // evidence, no suggestion. When the picks would need two models the server's
  // own figures say cannot co-load (the 2026-08-28 refusal, pre-empted), the
  // helper collapses them to one compromise and `memoryNote` says why.
  const kindPicks = report ? buildKindPicks(report.rows, status) : { picks: [], memoryNote: '' }

  return (
    <div className="settings__provider" data-testid="local-model-picker">
      <div className="settings__prow">
        <span className="settings__kicker">Your local models — measured here</span>
        <span className="settings__spacer" />
        <button
          type="button"
          className="settings__loadmodels mono"
          disabled={loading}
          aria-label="Recheck your local models"
          onClick={() => setTick((n) => n + 1)}
        >
          {loading ? 'checking…' : '↻ recheck'}
        </button>
      </div>

      {note ? (
        <div className="settings__navnote" data-testid="local-speed-note">
          {note} {budgetLine}
        </div>
      ) : null}

      {kindPicks.picks.length > 0 ? (
        <div className="settings__kpicks" data-testid="local-kind-picks">
          <span className="settings__khead">best for each kind of work — from these measurements</span>
          {kindPicks.picks.map((pick) => {
            const picked = (p.model ?? '') === pick.id
            return (
              <div key={pick.kind} className="settings__krow" data-testid={`local-kind-${pick.kind}`}>
                <span className="mono settings__kkind">{pick.kind}</span>
                <span className="mono settings__kmodel">{pick.id}</span>
                <span className="settings__kreason">{pick.reason}</span>
                {picked ? (
                  <span className="settings__minuse">in use</span>
                ) : (
                  <button
                    type="button"
                    className="settings__kuse mono"
                    aria-label={`Use ${pick.id} for ${pick.kind}`}
                    onClick={() => updateProvider(p.id, { model: pick.id })}
                  >
                    use this
                  </button>
                )}
              </div>
            )
          })}
          {kindPicks.memoryNote ? (
            <div className="settings__navnote" data-testid="local-kind-memory">
              {kindPicks.memoryNote}
            </div>
          ) : null}
        </div>
      ) : null}

      {rows.map((row) => {
        const facts = rowFacts(row, status)
        const inUse = (p.model ?? '') === row.id
        return (
          <div
            key={row.id}
            className={`settings__mrow${row.fit === 'wont-load' ? ' settings__mrow--blocked' : ''}`}
            data-testid={`local-model-${row.id}`}
          >
            <div className="settings__mhead">
              <span className="mono settings__mname">{row.id}</span>
              {inUse ? <span className="settings__minuse">in use</span> : null}
              <span className="settings__spacer" />
              {inUse ? null : (
                <button
                  type="button"
                  className="settings__loadmodels mono"
                  aria-label={`Use ${row.id}`}
                  onClick={() => updateProvider(p.id, { model: row.id })}
                >
                  use this
                </button>
              )}
            </div>
            <div className="settings__mfacts mono">
              <span>speed · {facts.speed}</span>
              <span>quality · {facts.quality}</span>
              <span>memory · {facts.memory}</span>
              <span>load · {facts.load}</span>
            </div>
            <div className="settings__msuggest">{row.suggestion}</div>
          </div>
        )
      })}

      {report?.recommendation ? (
        <div className="settings__navnote" data-testid="local-model-recommendation">
          {report.recommendation}
        </div>
      ) : null}
      {report?.note ? <div className="settings__navnote">{report.note}</div> : null}
    </div>
  )
}

export default function Settings() {
  const { settings, setTheme, setYourName, setApprovalMode, setApprovalBlocking, setProjectWrites, addCustomProvider } = useSettings()

  const local = settings.providers.filter((p) => p.id === 'local')

  const pickTheme = (t: ThemeId) => {
    setTheme(t)
    document.documentElement.dataset.theme = t
  }

  // The sub-nav really navigates the scroll page now (no dead clickable items):
  // Providers scrolls to the top, Appearance to its section, and the active
  // highlight follows what's actually in view via a scroll listener.
  const contentRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState<'providers' | 'appearance'>('providers')

  const scrollToProviders = () =>
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  const scrollToAppearance = () =>
    contentRef.current
      ?.querySelector('#sec-appearance')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const onScroll = () => {
      const appearance = root.querySelector('#sec-appearance')
      if (!appearance) return
      const rootTop = root.getBoundingClientRect().top
      const appTop = appearance.getBoundingClientRect().top
      // "Appearance" wins once its heading rises into the top third of the pane.
      setActiveSection(appTop - rootTop <= root.clientHeight / 3 ? 'appearance' : 'providers')
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="settings">
      {/* header */}
      <PageHead title="Settings" hint="keys are held by the Gateway · never rendered" />

      <div className="settings__body">
        {/* sub-nav */}
        <div className="settings__nav">
          <button
            type="button"
            className={`settings__navitem${activeSection === 'providers' ? ' is-active' : ''}`}
            onClick={scrollToProviders}
          >
            Providers
          </button>
          <Link to="/github" className="settings__navitem">GitHub (optional)</Link>
          {/* Work's "Your setup" panel used to summarise the governance rules
              (gates · never-touch · force-local). That panel is gone from Work
              — it was page furniture on a page that has to fit the window —
              so the rules need a door in the nav rather than a URL only the
              onboarding flow knew. This is that door; the page itself is
              unchanged. */}
          <Link to="/governance-review" className="settings__navitem">Your rules</Link>
          <button
            type="button"
            className={`settings__navitem${activeSection === 'appearance' ? ' is-active' : ''}`}
            onClick={scrollToAppearance}
          >
            Appearance
          </button>
          <Link to="/welcome" className="settings__navitem settings__navitem--gold">
            Rerun setup wizard ↺
          </Link>
          <div className="settings__spacer" />
        </div>

        {/* content */}
        <div className="settings__content" ref={contentRef}>
          {local.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
          {local[0] ? <LocalModelPicker p={local[0]} vaultPath={settings.vaultPath} /> : null}
          {brandViews(settings).map((v) => (
            <BrandCard key={v.brand} v={v} />
          ))}
          {settings.providers
            .filter((p) => isCustomProvider(p.id))
            .map((p) => (
              <CustomCard key={p.id} p={p} />
            ))}
          <button type="button" className="settings__addcustom" onClick={addCustomProvider}>
            + Add custom service — any OpenAI-compatible endpoint
          </button>

          <HostingCard />
          <RoutingModeCard />

          <EngineExtensions />

          <McpServers />

          <WebResearchCard />

          {/* appearance preview */}
          <div className="settings__provider" id="sec-appearance">
            <div className="settings__prow">
              <span className="settings__kicker">Appearance</span>
              <span className="settings__spacer" />
              <span className="settings__instant">theme applies instantly</span>
            </div>
            <div className="settings__themes" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <ThemeSwatch
                  key={t.id}
                  id={t.id}
                  name={t.name}
                  preview={t.preview}
                  active={settings.theme === t.id}
                  onPick={pickTheme}
                />
              ))}
            </div>
          </div>

          {/* your name — what the app calls you */}
          <div className="settings__provider">
            <div className="settings__prow">
              <span className="settings__kicker">Your name</span>
              <span className="settings__spacer" />
              <span className="settings__instant">optional</span>
            </div>
            <div className="settings__pfields">
              <input
                className="settings__input"
                value={settings.yourName}
                placeholder="what SC Prism calls you"
                aria-label="Your name"
                onChange={(e) => setYourName(e.target.value)}
              />
            </div>
          </div>

          {/* MV5 (Manager View §5): approve-each-team (default) vs auto. Same
              toggle affordance as Engine extensions above — reused classes,
              no new control style. */}
          <div className="settings__provider">
            <div className="settings__prow">
              <span className="settings__kicker">Approvals</span>
              <span className="settings__spacer" />
              <span className="settings__instant">
                {settings.approvalMode === 'approve' ? 'safe default' : 'runs without asking'}
              </span>
            </div>
            <div className="settings__prow settings__extrow">
              <span
                className={
                  'settings__toggle ' +
                  (settings.approvalMode === 'approve'
                    ? 'settings__toggle--on'
                    : 'settings__toggle--off')
                }
                role="switch"
                aria-checked={settings.approvalMode === 'approve'}
                aria-label="Approve each team before it runs"
                tabIndex={0}
                onClick={() =>
                  setApprovalMode(settings.approvalMode === 'approve' ? 'auto' : 'approve')
                }
                onKeyDown={onActivate(() =>
                  setApprovalMode(settings.approvalMode === 'approve' ? 'auto' : 'approve'),
                )}
              >
                <span
                  className={
                    'settings__knob' + (settings.approvalMode === 'approve' ? '' : ' settings__knob--off')
                  }
                />
              </span>
              <div className="settings__extinfo">
                <span className="settings__pname">
                  {settings.approvalMode === 'approve'
                    ? 'Approve each team before it runs'
                    : 'Run automatically'}
                </span>
                <span className="settings__clihint">
                  In approve mode, the Manager shows you the team and routing before any build
                  runs. In auto mode, builds start the moment you click Start build.
                </span>
              </div>
            </div>
            {/* Companion grants (2026-07-29 spec) — the wizard's answers live
                here for revocation; same toggle affordance, no new controls. */}
            <div className="settings__prow settings__extrow">
              <span
                className={
                  'settings__toggle ' +
                  (settings.approvalBlocking ? 'settings__toggle--on' : 'settings__toggle--off')
                }
                role="switch"
                aria-checked={settings.approvalBlocking}
                aria-label="Pause mid-run for risky tool calls"
                tabIndex={0}
                onClick={() => setApprovalBlocking(!settings.approvalBlocking)}
                onKeyDown={onActivate(() => setApprovalBlocking(!settings.approvalBlocking))}
              >
                <span className={'settings__knob' + (settings.approvalBlocking ? '' : ' settings__knob--off')} />
              </span>
              <div className="settings__extinfo">
                <span className="settings__pname">Pause mid-run at held tool calls</span>
                <span className="settings__clihint">
                  The run waits for your Approve/Deny on the Work desk, bounded at 5 minutes per
                  call — silence means the tool honestly does not run. Holds only exist with
                  ask-first tools (Settings → Tools); with tools allowed, nothing pauses.
                </span>
              </div>
            </div>
            <div className="settings__prow settings__extrow">
              <span
                className={
                  'settings__toggle ' +
                  (settings.projectWrites ? 'settings__toggle--on' : 'settings__toggle--off')
                }
                role="switch"
                aria-checked={settings.projectWrites}
                aria-label="Allow project file writes"
                tabIndex={0}
                onClick={() => setProjectWrites(!settings.projectWrites)}
                onKeyDown={onActivate(() => setProjectWrites(!settings.projectWrites))}
              >
                <span className={'settings__knob' + (settings.projectWrites ? '' : ' settings__knob--off')} />
              </span>
              <div className="settings__extinfo">
                <span className="settings__pname">
                  {settings.projectWrites ? 'Project builds may write real files' : 'Project writes denied'}
                </span>
                <span className="settings__clihint">
                  Under <span className="mono">~/SC Projects</span> only, with git history. Denied ⇒
                  project builds stay off.
                </span>
              </div>
            </div>
          </div>

          <TelegramCard />

          <ResetSetup />
        </div>
      </div>
    </div>
  )
}
