import { useEffect, useState } from 'react'
import {
  formatAdoptResult,
  formatLearnResult,
  isNative,
  readAdoptedRouter,
  readTrainingCount,
  resolveVaultDir,
  runNativeLearn,
  runNativeLearnApply,
  type AdoptedRouter,
  type LearnReport,
} from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import './LearningPanel.css'

// The honest "Run learning step" panel (originally P3-3, extracted for P4-1
// so both Stats and the first-class Training page share one implementation).
// Runs the engine's `train --dry-run` and shows the REAL PROMOTE/DISCARD
// decision from the golden lift-gate. This only ever changes ROUTE SELECTION
// (which model handles a task, local vs cloud); it never fine-tunes LLM
// weights and never auto-promotes past the gate (dry-run is hardcoded on the
// Rust side — see `runNativeLearn`). Self-contained: reads settings itself so
// it drops into any page without prop wiring.
//
// LF-2: after a dry run that says PROMOTE, a SECOND explicit button lets the
// human ADOPT the trained router (`runNativeLearnApply`, non-dry). The engine's
// golden gate still decides — Adopt is the human's apply, not a gate bypass. The
// currently-adopted router is shown honestly from `training/models/current.json`.
/** The adopted stamp, in the reader's own clock — the raw store value is an
 *  ISO instant with microseconds ("2026-08-12T13:32:01.227141+00:00"), which
 *  is provenance, not prose. An unparseable stored value passes through
 *  verbatim rather than pretending a date it cannot compute. */
function adoptedWhen(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t)
    ? new Date(t).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : iso
}

export default function LearningPanel() {
  const { settings } = useSettings()
  const vaultPath = settings.vaultPath
  // When Bifrost routing is on, the Go daemon routes and the Gateway's
  // set_route_policy is never consulted — so an adopted router does NOT apply
  // (the adopted-router line says so honestly, LF-fix F).
  const bifrost = settings.engineFlags?.bifrost ?? false
  // R1: an adopted router only GOVERNS the default lane in Auto-route mode
  // (it hands SCPRISM_PRIMARY unset so the adopted-policy lane is reachable).
  // While a provider is pinned, the pinned primary answers and the adopted
  // router merely "applies in Auto-route mode" — the copy below says which.
  const autoRoute = settings.routingMode === 'auto'

  // `null` means "not loaded yet" (never rendered as "0 records" while still loading).
  const [learnRecords, setLearnRecords] = useState<number | null>(null)
  const [learnBusy, setLearnBusy] = useState(false)
  const [learnRan, setLearnRan] = useState(false)
  const [learnReport, setLearnReport] = useState<LearnReport | null>(null)

  // LF-2 adopt state. `adoptedLoaded` distinguishes "still reading current.json"
  // from "read it, none adopted" so the line never flashes a false empty state.
  const [adopted, setAdopted] = useState<AdoptedRouter | null>(null)
  const [adoptedLoaded, setAdoptedLoaded] = useState(false)
  const [adoptBusy, setAdoptBusy] = useState(false)
  const [adoptRan, setAdoptRan] = useState(false)
  const [adoptReport, setAdoptReport] = useState<LearnReport | null>(null)

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    void (async () => {
      const vault = await resolveVaultDir(vaultPath)
      const records = await readTrainingCount(vault)
      const router = await readAdoptedRouter(vault)
      if (!cancelled) {
        setLearnRecords(records)
        setAdopted(router)
        setAdoptedLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [vaultPath])

  const noLearnRecordsYet = learnRecords !== null && learnRecords <= 0

  const runLearnStep = async () => {
    setLearnBusy(true)
    try {
      const vault = await resolveVaultDir(vaultPath)
      const report = await runNativeLearn(vault)
      setLearnReport(report)
      setLearnRan(true)
      // A fresh dry run supersedes any prior adopt outcome shown below.
      setAdoptRan(false)
      setAdoptReport(null)
    } catch {
      // P8: a THROW (bridge error, vault-path failure) must read as a failure,
      // not hang on the default prompt. Mark the run done with a null report so
      // the result line surfaces the honest "Couldn't run…" message.
      setLearnReport(null)
      setLearnRan(true)
      setAdoptRan(false)
      setAdoptReport(null)
    } finally {
      setLearnBusy(false)
    }
  }

  const adoptRouter = async () => {
    setAdoptBusy(true)
    try {
      const vault = await resolveVaultDir(vaultPath)
      const report = await runNativeLearnApply(vault)
      setAdoptReport(report)
      setAdoptRan(true)
      // Refresh the adopted-router line from the real current.json the engine
      // just (maybe) rewrote — the source of truth for the live version.
      setAdopted(await readAdoptedRouter(vault))
    } catch {
      // P8: same as runLearnStep — a thrown adopt surfaces the honest
      // "Couldn't adopt…" outcome instead of hanging on the busy state.
      setAdoptReport(null)
      setAdoptRan(true)
    } finally {
      setAdoptBusy(false)
    }
  }

  // Offer Adopt only after a dry run whose gate said PROMOTE (there is a router
  // worth adopting). A DISCARD or a failed run shows no button.
  const canAdopt = learnRan && learnReport?.decision === 'PROMOTE'
  // Once this PROMOTE has been adopted, disable the button so a re-click can't
  // re-train + mint another identical version (LF-fix H). A fresh dry run clears
  // adoptRan (see runLearnStep), re-enabling Adopt for the new PROMOTE.
  const alreadyAdopted = adoptRan && adoptReport?.decision === 'PROMOTE'

  return (
    <div className="learnpanel">
      <div className="learnpanel__head">
        <span className="learnpanel__kicker">Run learning step</span>
        <span className="learnpanel__spacer" />
        <span className="learnpanel__note">
          improves route selection, local vs cloud · dry run, never auto-promotes
        </span>
      </div>
      {!isNative() ? (
        <div className="learnpanel__note">
          Training runs in the installed app — the local router learns from your real runs here.
        </div>
      ) : (
        <>
          <div className="learnpanel__big-row">
            <span className="learnpanel__big mono">{learnRecords ?? '…'}</span>
            <span className="learnpanel__unit">training records</span>
            {learnRan && learnReport && (
              <>
                <span className="learnpanel__unit">·</span>
                <span
                  className={
                    'learnpanel__big mono learnpanel__decision' +
                    (learnReport.decision === 'PROMOTE'
                      ? ' learnpanel__decision--promote'
                      : learnReport.decision === 'DISCARD'
                        ? ' learnpanel__decision--discard'
                        : '')
                  }
                >
                  {learnReport.decision}
                </span>
                {typeof learnReport.lift === 'number' && (
                  <span className="learnpanel__unit">lift {learnReport.lift}</span>
                )}
              </>
            )}
          </div>
          {adoptedLoaded && (
            <div className="learnpanel__note">
              {adopted && adopted.kind === 'route-policy'
                ? `adopted router: ${adopted.version}${adopted.updated ? ` · adopted ${adoptedWhen(adopted.updated)}` : ''}` +
                  // Honest live-vs-applies status (R1): Bifrost overrides both
                  // modes (the Go daemon routes); else Auto-route makes it live
                  // now; else it only applies once you switch to Auto-route.
                  (bifrost
                    ? ' · not applied to Bifrost routing (the Go daemon routes)'
                    : autoRoute
                      ? ' · live now (Auto-route is on)'
                      : ' · applies in Auto-route mode (a provider is pinned)')
                : adopted
                  ? `a trained router snapshot (${adopted.version}) exists but the runtime doesn't use it — routing uses the built-in rules`
                  : 'no learned router adopted yet — routing uses the built-in rules'}
            </div>
          )}
          <button
            type="button"
            className={'learnpanel__btn' + (learnRan ? ' learnpanel__btn--ghost' : '')}
            disabled={learnBusy || learnRecords === null || noLearnRecordsYet}
            onClick={() => void runLearnStep()}
          >
            {learnBusy ? 'Running…' : 'Run learning step'}
          </button>
          <div className="learnpanel__note learnpanel__result" role="status" aria-live="polite">
            {learnRan || noLearnRecordsYet
              ? formatLearnResult(learnReport, learnRecords ?? 0)
              : 'Checks whether a freshly trained router would beat the current one — dry run, nothing is applied.'}
          </div>
          {canAdopt && (
            <>
              <div className="learnpanel__note learnpanel__result">
                adopting changes route selection (local vs cloud) for the default lane only, and only
                takes effect in Auto-route mode — sensitive work always stays local; a pinned primary
                always wins.
              </div>
              <button
                type="button"
                className="learnpanel__btn"
                disabled={adoptBusy || alreadyAdopted}
                onClick={() => void adoptRouter()}
              >
                {adoptBusy ? 'Adopting…' : alreadyAdopted ? 'Adopted' : 'Adopt this router'}
              </button>
              {adoptRan && (
                <div className="learnpanel__note learnpanel__result" role="status" aria-live="polite">
                  {formatAdoptResult(adoptReport, autoRoute)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
