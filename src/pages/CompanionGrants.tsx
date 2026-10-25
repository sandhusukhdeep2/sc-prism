// Companion capability grants — onboarding step between Vault and Interview
// (spec: docs/superpowers/specs/2026-07-29-companion-grants-design.md).
// One ask per screen; every answer writes a REAL, revocable setting the moment
// it's given; Continue to Interview appears only after the last card. Nothing
// runs during onboarding and nothing is confirmed that didn't really happen.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Stepper from '../components/Stepper'
import { useOnboarding } from '../lib/onboarding'
import { useSettings } from '../lib/settings'
import {
  readMcpApprovals,
  readMcpServers,
  resolveVaultDir,
  runNativeMcpList,
  sendTelegram,
  withVaultGranted,
  writeMcpApprovals,
  writeMcpServers,
} from '../lib/nativeEngine'
import { withReadsFree } from '../lib/toolRisk'
import './CompanionGrants.css'

const CARDS = ['files', 'web', 'computer', 'terminal', 'tools', 'approvals', 'telegram', 'summary'] as const
type Card = (typeof CARDS)[number]

export default function CompanionGrants() {
  const { settings, setProjectWrites, setWebResearch, setComputerControl, setTerminalControl, setMcpApproval, setApprovalMode, setApprovalBlocking, setTelegramConfig, setTelegramReports } = useSettings()
  const { completeStep, completedSteps, nextRoute, pause } = useOnboarding()
  const navigate = useNavigate()
  const [card, setCard] = useState<Card>('files')
  const name = settings.companionName || 'Your Companion'
  const alreadyDone = completedSteps.includes('grants')

  // Audit C1: the vault path in settings may be tilde-form ('~/sc-vault') and
  // the Rust side does NOT expand it — every vault read/write below must use
  // the RESOLVED directory or the tool policy lands in a bogus path while the
  // engine reads the real one (a fabricated grant, the product's core sin).
  const [vaultDir, setVaultDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    resolveVaultDir(settings.vaultPath)
      .then((v) => {
        if (!cancelled) setVaultDir(v)
      })
      .catch(() => {
        if (!cancelled) setVaultDir('')
      })
    return () => {
      cancelled = true
    }
  }, [settings.vaultPath])

  // tools card state
  const [mcpName, setMcpName] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpStatus, setMcpStatus] = useState<string | null>(null)
  const [mcpTesting, setMcpTesting] = useState(false)

  // telegram card state
  const [tgToken, setTgToken] = useState('')
  const [tgChat, setTgChat] = useState('')
  const [tgStatus, setTgStatus] = useState<string | null>(null)
  const [tgSending, setTgSending] = useState(false)

  const next = () => setCard(CARDS[CARDS.indexOf(card) + 1] ?? 'summary')

  /** Posture write is engine-native: the vault's mcp-approvals.json `require`
   *  list (the same file the engine's ApprovalGate reads; 'all' sentinel).
   *  Read-modify-write so already-granted names survive. Advances ONLY when
   *  the write really landed (audit H2) — a failed save is said, not skipped. */
  const chooseMcp = async (mode: 'ask' | 'auto') => {
    if (!vaultDir) {
      setMcpStatus("vault isn't reachable yet — try again in a second")
      return
    }
    const policy = await readMcpApprovals(vaultDir)
    // 'ask' unions the 'all' sentinel in; 'auto' removes ONLY the sentinel —
    // per-server require names curated in Settings survive a wizard rerun.
    const require =
      mode === 'ask'
        ? Array.from(new Set(['all', ...policy.require]))
        : policy.require.filter((n) => n !== 'all')
    // Ask-first holds what ACTS, not what looks. A new install starts where the
    // migration puts an existing one: the read-only class runs free (vault and
    // web READS — see engine/scprism_engine/toolrisk.py, which enforces it),
    // while every acting tool and every third-party MCP tool still waits. Set
    // once here so a first session never burns its wakes on approval prompts for
    // reads; reversible in Settings ("Let reading run without asking").
    // The companion's own read-only, zero-egress eyes are pre-granted too, so
    // ask-first never blinds it on the user's own notes (see withVaultGranted).
    // Other granted names always survive.
    const base = { require, granted: withVaultGranted(policy.granted) }
    const posture = mode === 'ask' ? withReadsFree(base, true) : base
    const saved = await writeMcpApprovals(vaultDir, {
      require: [...posture.require],
      granted: [...posture.granted],
    })
    if (!saved) {
      setMcpStatus("couldn't save the tool posture to your vault — nothing was granted")
      return
    }
    setMcpApproval(mode)
    next()
  }

  /** Register the server, then prove it with a REAL tool listing. A failed
   *  test unregisters ONLY the name we added (audit L1) — no dead entries,
   *  no clobbering concurrent writers. Refuses name collisions (audit ML2). */
  const testAndAddMcp = async () => {
    if (mcpTesting) return
    const trimmedName = mcpName.trim()
    const command = mcpCommand.trim().split(/\s+/).filter(Boolean)
    if (!trimmedName || command.length === 0) {
      setMcpStatus('give it a name and a command first')
      return
    }
    if (!vaultDir) {
      setMcpStatus("vault isn't reachable yet — try again in a second")
      return
    }
    setMcpTesting(true)
    setMcpStatus(null)
    const existing = await readMcpServers(vaultDir)
    if (existing.some((s) => s.name === trimmedName)) {
      setMcpStatus(`a server named ${trimmedName} already exists — pick another name`)
      setMcpTesting(false)
      return
    }
    await writeMcpServers(vaultDir, [...existing, { name: trimmedName, command }])
    const result = await runNativeMcpList(vaultDir, trimmedName)
    if (result.ok) {
      setMcpStatus(`✓ ${trimmedName} answered with ${result.tools.length} real tool${result.tools.length === 1 ? '' : 's'}`)
    } else {
      // Targeted rollback: re-read and remove only what we added.
      const now = await readMcpServers(vaultDir)
      await writeMcpServers(vaultDir, now.filter((s) => s.name !== trimmedName))
      setMcpStatus(`couldn't reach it — ${result.error}`)
    }
    setMcpTesting(false)
  }

  /** The card only turns green on a REAL delivered message. */
  const sendTgTest = async () => {
    if (!tgToken.trim() || !tgChat.trim()) {
      setTgStatus('need both the bot token and the chat id')
      return
    }
    setTgSending(true)
    setTgStatus(null)
    const err = await sendTelegram(
      tgToken.trim(),
      tgChat.trim(),
      `${name} here — test message from SC Prism. Reports will arrive like this.`,
    )
    if (err === null) {
      setTelegramConfig(tgToken.trim(), tgChat.trim())
      setTelegramReports(true)
      setTgStatus('delivered')
    } else {
      setTgStatus(`not delivered — ${err}`)
    }
    setTgSending(false)
  }

  const dots = (
    <div className="grants__dots" aria-label={`grant ${CARDS.indexOf(card) + 1} of ${CARDS.length}`}>
      {CARDS.map((c) => (
        <span key={c} className={'grants__dot' + (CARDS.indexOf(c) <= CARDS.indexOf(card) ? ' grants__dot--on' : '')} />
      ))}
    </div>
  )

  return (
    <div className="grants">
      <button type="button" className="wizback" onClick={() => navigate('/vault-setup')}>
        ← Back
      </button>
      <div className="wizactions">
        {alreadyDone && (
          <button type="button" className="wizskip" onClick={() => navigate(nextRoute('grants'))}>
            Skip — already granted →
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
      <Stepper active={3} />
      {dots}

      {card === 'files' && (
        <section className="grants__card" aria-label="Files grant">
          <h1>Where {name} may touch files</h1>
          <p className="grants__ask">
            My memory lives in your vault — <span className="mono">{settings.vaultPath}</span> — plain
            Markdown you can open anytime. That one is required: it is how I remember at all.
          </p>
          <p className="grants__ask">
            Building real projects writes files under <span className="mono">~/SC Projects</span> (with
            git history). May I?
          </p>
          <div className="grants__actions">
            <button type="button" className="grants__grant" onClick={() => { setProjectWrites(true); next() }}>
              Grant — build real files
            </button>
            <button type="button" className="grants__deny" onClick={() => { setProjectWrites(false); next() }}>
              Deny — projects stay off
            </button>
          </div>
          <p className="grants__fine mono">writes setting: projectWrites · revocable in Settings</p>
        </section>
      )}

      {card === 'web' && (
        <section className="grants__card" aria-label="Web grant">
          <h1>May {name} research the web?</h1>
          <p className="grants__ask">
            Only when a task needs it — every fetch and search shows in the run stream with its real
            URL, hardened against internal-network tricks, and a blocked call is shown as blocked.
          </p>
          <div className="grants__actions">
            <button type="button" className="grants__grant" onClick={() => { setWebResearch(true); next() }}>
              Grant web access
            </button>
            <button type="button" className="grants__deny" onClick={() => { setWebResearch(false); next() }}>
              Deny — stay offline
            </button>
          </div>
          <p className="grants__fine mono">writes setting: webResearch · revocable in Settings</p>
        </section>
      )}

      {card === 'computer' && (
        <section className="grants__card" aria-label="Computer grant">
          <h1>May {name} control this computer?</h1>
          <p className="grants__ask">
            Screenshots, opening apps, clicks and typing — only for an agent whose own definition
            asks for it AND only after this grant: both doors must be open. Every action is one
            recorded span in the run stream; a screenshot stays a local file unless a later step
            explicitly reads it; macOS&rsquo;s own permission prompts still apply on top. This is
            the one grant that never defaults on.
          </p>
          <div className="grants__actions">
            <button type="button" className="grants__grant" onClick={() => { setComputerControl(true); next() }}>
              Grant computer control
            </button>
            <button type="button" className="grants__deny" onClick={() => { setComputerControl(false); next() }}>
              Deny — hands off the machine
            </button>
          </div>
          <p className="grants__fine mono">writes setting: computerControl · revocable in Settings</p>
        </section>
      )}
      {card === 'terminal' && (
        <section className="grants__card" aria-label="Terminal grant">
          <h1>May {name} run terminal commands?</h1>
          <p className="grants__ask">
            The full power for real jobs — builds, 3D pipelines, CAD scripts, anything a terminal
            can do. Only for an agent whose own definition asks for it AND after this grant, and
            EVERY command still stops at the approval gate for your yes before it runs. What ran is
            what is recorded: command, folder, and exit code land in the run stream. This grant
            never defaults on.
          </p>
          <div className="grants__actions">
            <button type="button" className="grants__grant" onClick={() => { setTerminalControl(true); next() }}>
              Grant terminal access
            </button>
            <button type="button" className="grants__deny" onClick={() => { setTerminalControl(false); next() }}>
              Deny — no commands
            </button>
          </div>
          <p className="grants__fine mono">writes setting: terminalControl · revocable in Settings</p>
        </section>
      )}
      {card === 'tools' && (
        <section className="grants__card" aria-label="Tools grant">
          <h1>How should {name} use tools?</h1>
          <p className="grants__ask">
            Tools are MCP servers you add (files, browsers, APIs). <b>Ask first</b> parks every held
            tool call on your Work desk until you approve it; <b>allow</b> lets tools run inside the
            engine&rsquo;s own allowlist and sensitivity gates.
          </p>
          <div className="grants__inline">
            <input className="grants__field mono" value={mcpName} placeholder="optional first server — name (e.g. files)"
              aria-label="MCP server name" onChange={(e) => setMcpName(e.target.value)} />
            <input className="grants__field mono" value={mcpCommand}
              placeholder="command (e.g. npx -y @modelcontextprotocol/server-filesystem /tmp)"
              aria-label="MCP server command" onChange={(e) => setMcpCommand(e.target.value)} />
            <button type="button" className="grants__test" disabled={mcpTesting} onClick={() => void testAndAddMcp()}>
              {mcpTesting ? 'testing…' : 'Test & add'}
            </button>
          </div>
          {mcpStatus && <p className="grants__status mono">{mcpStatus}</p>}
          <div className="grants__actions">
            <button
              type="button"
              className="grants__grant"
              disabled={vaultDir === null}
              onClick={() => void chooseMcp('ask')}
            >
              Ask me first (recommended)
            </button>
            <button
              type="button"
              className="grants__deny"
              disabled={vaultDir === null}
              onClick={() => void chooseMcp('auto')}
            >
              Allow within the gates
            </button>
          </div>
          <p className="grants__fine mono">writes: mcp-approvals.json in your vault + setting mcpApproval · more servers in Settings → Tools</p>
        </section>
      )}

      {card === 'approvals' && (
        <section className="grants__card" aria-label="Approvals grant">
          <h1>Before {name} builds</h1>
          <p className="grants__ask">
            Team builds can <b>propose first</b> — you see the real roster and click Approve &amp;
            build — or run automatically.
          </p>
          <div className="grants__actions">
            <button type="button" className="grants__grant" onClick={() => { setApprovalMode('approve'); next() }}>
              Propose first (recommended)
            </button>
            <button type="button" className="grants__deny" onClick={() => { setApprovalMode('auto'); next() }}>
              Run automatically
            </button>
          </div>
          <label className="grants__toggle">
            <input
              type="checkbox"
              checked={settings.approvalBlocking}
              onChange={(e) => setApprovalBlocking(e.target.checked)}
            />
            Also pause mid-run at held tool calls — the run waits for your Approve/Deny (bounded at
            5 minutes per call; silence means the tool honestly does not run). Holds only exist with
            &ldquo;Ask me first&rdquo; tools — with tools allowed, nothing is held, so nothing pauses.
          </label>
          <p className="grants__fine mono">writes settings: approvalMode, approvalBlocking · revocable in Settings</p>
        </section>
      )}

      {card === 'telegram' && (
        <section className="grants__card" aria-label="Telegram grant">
          <h1>Reports on your phone?</h1>
          <p className="grants__ask">
            {name} messages you when a run finishes, fails, or needs a decision — outcome lines only,
            never the work itself. The token is held like a provider key: never shown again, sent
            only through the native bridge.
          </p>
          <p className="grants__ask">
            While this is on you can also tap Approve or Deny on something already waiting — a
            paused run, a parked job — from this chat id and no other. That is the whole of what the
            phone can do: no chat, no new work, and nothing that is not already parked here.
          </p>
          <div className="grants__inline">
            <input className="grants__field mono" type="password" value={tgToken} placeholder="bot token (from @BotFather)"
              aria-label="Telegram bot token" onChange={(e) => setTgToken(e.target.value)} />
            <input className="grants__field mono" value={tgChat} placeholder="chat id (from @userinfobot)"
              aria-label="Telegram chat id" onChange={(e) => setTgChat(e.target.value)} />
            <button type="button" className="grants__test" disabled={tgSending} onClick={() => void sendTgTest()}>
              {tgSending ? 'sending…' : 'Send test message'}
            </button>
          </div>
          {tgStatus && (
            <p className={'grants__status mono' + (tgStatus === 'delivered' ? ' grants__status--ok' : '')}>
              {tgStatus === 'delivered' ? '✓ delivered — check your phone' : tgStatus}
            </p>
          )}
          <div className="grants__actions">
            {settings.telegramReports && tgStatus !== 'delivered' ? (
              // Rerun with reports already proven ON: keeping them must not
              // demand a fresh test message (audit M2).
              <button type="button" className="grants__grant" onClick={next}>
                Reports already on — keep
              </button>
            ) : (
              <button
                type="button"
                className="grants__grant"
                disabled={tgStatus !== 'delivered'}
                onClick={next}
              >
                {tgStatus === 'delivered' ? 'Reports on — continue' : 'Delivery not proven yet'}
              </button>
            )}
            <button
              type="button"
              className="grants__deny"
              onClick={() => {
                // Off means OFF: forget the credentials too (audit L3) — "no
                // reports" must not quietly retain a bot token.
                setTelegramReports(false)
                setTelegramConfig('', '')
                next()
              }}
            >
              {settings.telegramReports ? 'Turn reports off + forget token' : 'Skip — no reports'}
            </button>
          </div>
          <p className="grants__fine mono">writes settings: telegramBotToken, telegramChatId, telegramReports · revocable in Settings</p>
        </section>
      )}

      {card === 'summary' && (
        <section className="grants__card" aria-label="Grant summary">
          <h1>What you granted {name}</h1>
          <ul className="grants__summary mono">
            <li>vault memory · <span>{settings.vaultPath}</span></li>
            <li>project files · <span>{settings.projectWrites ? 'granted — ~/SC Projects' : 'denied — projects off'}</span></li>
            <li>web research · <span>{settings.webResearch ? 'granted' : 'denied'}</span></li>
            <li>tools · <span>{settings.mcpApproval === 'ask' ? 'reading runs free — anything that changes something waits on your desk' : 'allowed within the gates'}</span></li>
            <li>team builds · <span>{settings.approvalMode === 'approve' ? 'propose first' : 'run automatically'}</span></li>
            <li>mid-run pause · <span>{settings.approvalBlocking ? (settings.mcpApproval === 'ask' ? 'on — pauses held tool calls, bounded' : 'on — inactive until tools are ask-first') : 'off'}</span></li>
            <li>telegram reports · <span>{settings.telegramReports ? 'on — reports, plus Approve/Deny from that chat' : 'off'}</span></li>
          </ul>
          <p className="grants__ask">Every grant is a real setting you can change in Settings at any time.</p>
          <button
            type="button"
            className="grants__continue"
            onClick={() => {
              completeStep('grants')
              navigate(nextRoute('grants'))
            }}
          >
            Continue →
          </button>
        </section>
      )}
    </div>
  )
}
