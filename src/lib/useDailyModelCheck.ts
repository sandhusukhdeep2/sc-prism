// Runs the model check on the day's first launch — and, for an app left open
// overnight, the first time the window is come back to on a new day. It runs
// once per day and speaks only when there is something to say.

import { useEffect, useRef } from 'react'
import { checkDue, modelCheckLine, type ModelCheckResult } from './modelCheck'
import { loadModelCheck, type ModelCheckDeps } from './modelCheckRun'
import { probeCli } from './nativeEngine'
import { CLI_PROVIDERS, listProviderModels, type ProviderConfig, type Settings } from './settings'

/** The real world for `runModelCheck`: each AI's own models endpoint, the
 *  subscription CLI's own one-shot answer, and the Settings store. */
export function modelCheckDeps(
  settings: Pick<Settings, 'providers' | 'autoNewestModel'>,
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void,
  now: number,
): ModelCheckDeps {
  return {
    providers: settings.providers,
    auto: settings.autoNewestModel,
    now,
    list: listProviderModels,
    probe: async (providerId, model) => {
      const bin = CLI_PROVIDERS[providerId]?.bin
      if (!bin) return { ok: false, error: 'not a subscription CLI' }
      const res = await probeCli(bin, undefined, model)
      return { ok: res.ok, error: res.error }
    },
    apply: (providerId, model) => updateProvider(providerId, { model }),
  }
}

export function useDailyModelCheck(opts: {
  /** Native, and the settings have been read from disk. */
  ready: boolean
  check: (now: number) => Promise<ModelCheckResult>
  /** Called with the one-line summary — only when there is one. */
  notify: (line: string) => void
  now?: () => number
}): void {
  const running = useRef(false)
  const latest = useRef(opts)
  latest.current = opts

  useEffect(() => {
    if (!opts.ready) return
    const tryRun = () => {
      const { check, notify, now } = latest.current
      if (running.current) return
      const t = (now ?? Date.now)()
      if (!checkDue(loadModelCheck().last?.at ?? 0, t)) return
      running.current = true
      check(t)
        .then((result) => {
          const line = modelCheckLine(result)
          if (line) notify(line)
        })
        .catch(() => {
          // A check that could not run says nothing; the next launch tries again.
        })
        .finally(() => {
          running.current = false
        })
    }
    tryRun()
    window.addEventListener('focus', tryRun)
    return () => window.removeEventListener('focus', tryRun)
  }, [opts.ready])
}
