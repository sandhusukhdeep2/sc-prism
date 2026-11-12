import { describe, expect, it } from 'vitest'
import { normalizeSettings, withWorkload } from './settings'

// The workload slider's stored state (lib/workload.ts). Three fields:
//   workload              — what the user chose ('measured' until he moves it);
//   workloadMeasured      — the stop the app's own measurement points to, cached
//                           so a roster can be resolved without reading runs;
//   workloadSecondOpinion — "a different AI double-checks".
describe('the workload slider — stored state', () => {
  it('a fresh install follows the measurement, and there is none yet', () => {
    const s = normalizeSettings({})
    expect(s.workload).toBe('measured')
    expect(s.workloadMeasured).toBe('')
    expect(s.workloadSecondOpinion).toBe(false)
  })

  it('garbage loads as the defaults', () => {
    const s = normalizeSettings({
      workload: 'turbo',
      workloadMeasured: 'measured',
      workloadSecondOpinion: 'yes',
    } as never)
    expect(s.workload).toBe('measured')
    // 'measured' is not itself a stop a measurement can point to.
    expect(s.workloadMeasured).toBe('')
    expect(s.workloadSecondOpinion).toBe(false)
  })

  it('a chosen stop and a cached measurement are kept', () => {
    const s = normalizeSettings({
      workload: 'primary-checks',
      workloadMeasured: 'primary-leads',
      workloadSecondOpinion: true,
    })
    expect(s.workload).toBe('primary-checks')
    expect(s.workloadMeasured).toBe('primary-leads')
    expect(s.workloadSecondOpinion).toBe(true)
  })

  it('the old dial’s "Local first" becomes All local — the same promise, kept', () => {
    const s = normalizeSettings({ routeBias: 'local' })
    expect(s.workload).toBe('local-all')
    expect(s.routeBias).toBe('local')
  })

  it('…but a slider already chosen is not overwritten by the old dial', () => {
    expect(normalizeSettings({ routeBias: 'local', workload: 'agents' }).workload).toBe('agents')
  })
})

describe('withWorkload — moving the slider', () => {
  const base = normalizeSettings({})

  it('All local also keeps single messages on this Mac', () => {
    const s = withWorkload(base, 'local-all')
    expect(s.workload).toBe('local-all')
    expect(s.routeBias).toBe('local')
  })

  it('any other stop hands single messages back to the normal rules', () => {
    const local = withWorkload(base, 'local-all')
    for (const stop of ['measured', 'agents', 'primary-all', 'primary-leads', 'primary-checks'] as const) {
      const s = withWorkload(local, stop)
      expect(s.workload, stop).toBe(stop)
      expect(s.routeBias, stop).toBe('auto')
    }
  })
})
