import { describe, expect, it } from 'vitest'
import {
  buildEngineProviders,
  buildProjectProviders,
  buildStartRefusal,
  isUsableProjectDir,
  otherRunningProject,
  tier1CwdFor,
} from './AppStore'
import { setInterview } from '../lib/interview'
import { attachProject } from '../lib/projects'
import type { Settings } from '../lib/settings'
import type { Project } from '../lib/projects'

// Same minimal fixture shape as AppStore.managers.test.ts — buildEngineProviders
// touches settings.companionName + settings.engineFlags.* via buildCompanionContext.
const settings = {
  providers: [
    {
      id: 'local',
      name: 'Local model',
      baseUrl: 'http://localhost:1234',
      apiKey: '',
      enabled: true,
      primary: true,
      connected: true,
    },
  ],
  companionName: '',
  engineFlags: { deepeval: false, lightrag: false, bifrost: false },
} as unknown as Settings

// Regression test for C1: a project's own verify command never reached
// Tier-1 because buildEngineProviders always set tier1 from the ONBOARDING
// interview's verifyCommand — the project run driver passed that straight
// through. buildProjectProviders must override tier1 with the PROJECT's own
// command (even empty, meaning "skip"), never leaking the interview's.
describe('buildProjectProviders', () => {
  it('uses the PROJECT verify command for tier1, not the onboarding interview command', () => {
    setInterview({ verifyCommand: 'npm run onboarding-verify' })
    const { providers } = buildProjectProviders(settings, 'pytest -q')
    expect(providers.tier1).toBe('pytest -q')
  })

  it('an empty project verify command means skip — never falls back to the interview command', () => {
    setInterview({ verifyCommand: 'npm run onboarding-verify' })
    const { providers } = buildProjectProviders(settings, '')
    expect(providers.tier1).toBe('')
  })

  it('leaves every other buildEngineProviders field untouched', () => {
    setInterview({ verifyCommand: '' })
    const base = buildEngineProviders(settings).providers
    const { providers } = buildProjectProviders(settings, 'go test ./...', '/repo')
    expect({ ...providers, tier1: undefined, tier1Cwd: undefined }).toEqual({
      ...base,
      tier1: undefined,
      tier1Cwd: undefined,
    })
  })

  it('runs the project verify command in the PROJECT directory', () => {
    setInterview({ verifyCommand: 'npm test' })
    const { providers } = buildProjectProviders(settings, 'pytest -q', '/Users/me/repo')
    expect(providers.tier1Cwd).toBe('/Users/me/repo')
  })

  it('trims the verify command — a whitespace-only edit must mean skip, not a shell no-op', () => {
    // The rail's verify slot stores keystrokes raw (a controlled input cannot
    // trim while the user types a space). The engine boundary is where the
    // whitespace goes: '  ' as --tier1 would run `sh -c '  '` → exit 0 → a
    // false green over a gate that checked nothing.
    setInterview({ verifyCommand: '' })
    expect(buildProjectProviders(settings, '  npm test  ').providers.tier1).toBe('npm test')
    expect(buildProjectProviders(settings, '   ').providers.tier1).toBe('')
  })
})

// Finding 1a — the half of the Tier-1 failure that survived the first fix.
// `run_engine_task` pushed `--tier1 <cmd>` but never `--tier1-cwd`, so the
// verify command inherited the ENGINE process's directory. Inside the installed
// app that is the bundle's engine folder, which has no package.json in it or in
// any ancestor, so every `npm test` died with `npm error ENOENT` — and the dev
// repo hid it completely, because npm walks up to the repo's own package.json.
describe('tier1CwdFor — where the interview verify command actually runs', () => {
  it('with no project bound there is NO honest directory, so it says so', () => {
    expect(tier1CwdFor(undefined)).toBe('')
    expect(tier1CwdFor('')).toBe('')
  })

  it('an unknown project id resolves to nothing rather than a guess', () => {
    expect(tier1CwdFor('does-not-exist')).toBe('')
  })

  it('a bound project resolves to that project’s own folder', () => {
    const p = attachProject('Cwd One', '/Users/me/one', 'goal', 'npm test')
    expect(tier1CwdFor(p.id)).toBe('/Users/me/one')
  })

  it('buildEngineProviders threads it through to the engine providers', () => {
    setInterview({ verifyCommand: 'npm test' })
    const p = attachProject('Cwd Two', '/Users/me/two', 'goal', '')
    expect(buildEngineProviders(settings, p.id).providers.tier1Cwd).toBe('/Users/me/two')
    // …and an unbound chat gets '', which the engine fails honestly on rather
    // than running the user's tests inside the app bundle.
    expect(buildEngineProviders(settings).providers.tier1Cwd).toBe('')
  })
})

// R1 — Auto-route mode. In 'pinned' (the default) the chosen primary is
// forwarded so it ALWAYS wins; in 'auto' the primary is left UNSET so the Rust
// bridge omits SCPRISM_PRIMARY and the gateway's adopted-policy lane is actually
// reachable (has_explicit_primary=False). Without this, the adopted router is
// unreachable in-app and the "adopted router" claim is false.
describe('buildEngineProviders — routing mode (R1)', () => {
  it('pinned mode forwards the pinned primary (it always wins)', () => {
    setInterview({ verifyCommand: '' })
    const { providers } = buildEngineProviders({ ...settings, routingMode: 'pinned' } as Settings)
    expect(providers.primary).toBe('local')
  })

  it('auto mode leaves the primary UNSET so the adopted route policy governs the default lane', () => {
    setInterview({ verifyCommand: '' })
    const { providers } = buildEngineProviders({ ...settings, routingMode: 'auto' } as Settings)
    expect(providers.primary).toBe('')
  })
})

// Minimal-but-valid Project fixture — only the fields otherRunningProject
// touches get varied per test; everything else is filler so the shape
// type-checks against the real Project interface.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'demo',
    slug: 'demo',
    path: '/tmp/demo',
    goal: 'ship it',
    verifyCommand: '',
    createdAt: 0,
    status: 'planned',
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    ...over,
  }
}

// Regression test for C4: concurrent project starts stranded the FIRST
// project in 'running' because nothing checked for an already-running
// project before starting a second one. otherRunningProject is the pure
// lookup the driver refuses on.
describe('otherRunningProject', () => {
  it('returns undefined when no other project is running', () => {
    const projects = [makeProject({ id: 'a', status: 'planned' }), makeProject({ id: 'b', status: 'done' })]
    expect(otherRunningProject(projects, 'a')).toBeUndefined()
  })

  it('finds an OTHER project that is running', () => {
    const projects = [makeProject({ id: 'a', status: 'planned' }), makeProject({ id: 'b', status: 'running' })]
    expect(otherRunningProject(projects, 'a')?.id).toBe('b')
  })

  it('does not count the project itself as "other" even if already running', () => {
    const projects = [makeProject({ id: 'a', status: 'running' })]
    expect(otherRunningProject(projects, 'a')).toBeUndefined()
  })
})

// Regression test for C5: a relative project.path passed expandUserPath
// through unchanged (non-empty, non-absolute) and reached the Rust bridge /
// Python engine unresolved. isUsableProjectDir requires an absolute POSIX
// path, same honest-refusal signal as the unusable-tilde ('') case.
describe('isUsableProjectDir', () => {
  it('accepts an absolute path', () => {
    expect(isUsableProjectDir('/Users/me/SC Projects/demo')).toBe(true)
  })

  it('rejects the empty string (unusable-tilde case)', () => {
    expect(isUsableProjectDir('')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isUsableProjectDir('my-project')).toBe(false)
    expect(isUsableProjectDir('./relative/path')).toBe(false)
  })
})

// The folder a chat or team turn is ABOUT (2026-11-11). A run in a project's
// room used to be handed the project's name and nothing of its folder.
describe('buildEngineProviders — the folder a turn is about', () => {
  it('a bound project hands the run its folder', () => {
    const p = attachProject('Site', '/Users/someone/site-about', '', '')
    expect(buildEngineProviders(settings, p.id).providers.projectDir).toBe('/Users/someone/site-about')
  })

  it('with no project bound there is no folder to show', () => {
    expect(buildEngineProviders(settings).providers.projectDir).toBe('')
    expect(buildEngineProviders(settings, 'nope').providers.projectDir).toBe('')
  })
})

// Why a build cannot start, asked BEFORE anything is changed (2026-11-11). A
// job typed in a project's room must not be added to the plan and announced as
// "working now" when the build would refuse to start a moment later.
describe('buildStartRefusal — why a build cannot start right now', () => {
  const me = { id: 'p-me', name: 'Site', status: 'done' } as Project
  const ready = { projects: [me], projectWrites: true, engineBusy: false, native: true, primaryReal: true }

  it('nothing in the way → no refusal', () => {
    expect(buildStartRefusal(me, ready)).toBe('')
  })

  it('another project is building → named, one build at a time', () => {
    const other = { id: 'p-other', name: 'Blog', status: 'running' } as Project
    expect(buildStartRefusal(me, { ...ready, projects: [me, other] })).toBe(
      '«Blog» is already running — one build at a time',
    )
  })

  it('file writes are denied → says where to grant them', () => {
    expect(buildStartRefusal(me, { ...ready, projectWrites: false })).toBe(
      'project file writes are denied — grant them in Settings → Approvals first',
    )
  })

  it('the engine is busy with another run → says so', () => {
    expect(buildStartRefusal(me, { ...ready, engineBusy: true })).toBe(
      '«Site» — engine busy, another run is in progress',
    )
  })

  it('outside the installed app, or with no real provider, a build cannot run', () => {
    expect(buildStartRefusal(me, { ...ready, native: false })).toBe('«Site» needs the installed app to run.')
    expect(buildStartRefusal(me, { ...ready, primaryReal: false })).toBe(
      "«Site» can't run — connect a real AI provider first.",
    )
  })
})
