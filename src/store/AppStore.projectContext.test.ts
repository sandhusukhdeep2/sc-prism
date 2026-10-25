import { describe, expect, it } from 'vitest'
import { activeProjectContext, buildEngineProviders } from './AppStore'
import { setInterview } from '../lib/interview'
import type { Settings } from '../lib/settings'
import type { Project } from '../lib/projects'

// Same minimal fixture shape as AppStore.managers.test.ts / AppStore.project.test.ts —
// buildEngineProviders touches settings.companionName + settings.engineFlags.*
// (via buildCompanionContext).
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
  vaultPath: '~/vault',
  vaultMode: 'local',
} as unknown as Settings

// Minimal-but-valid Project fixture, same pattern as AppStore.project.test.ts's
// makeProject — only the fields activeProjectContext touches get varied.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'Webs',
    slug: 'webs',
    path: '/tmp/webs',
    goal: 'ship a marketing site',
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

// --- Part 1a: activeProjectContext (pure, unit-testable without the store) ---

describe('activeProjectContext', () => {
  it('no active project → empty string (context stays untouched)', () => {
    expect(activeProjectContext(null)).toBe('')
  })

  it('a project with a goal and a plan → block names it, its status, goal, and numbered plan steps', () => {
    const project = makeProject({
      name: 'Webs',
      status: 'running',
      goal: 'ship a marketing site',
      plan: ['scaffold the repo', 'write the landing page', 'deploy'],
    })
    const block = activeProjectContext(project)
    expect(block).toContain('"Webs"')
    expect(block).toContain('running')
    expect(block).toContain('ship a marketing site')
    expect(block).toContain('1. scaffold the repo')
    expect(block).toContain('2. write the landing page')
    expect(block).toContain('3. deploy')
    expect(block).toContain('Answer and act in the context of THIS project unless the user changes topic.')
  })

  it('a project with no plan → block omits the Plan line entirely', () => {
    const project = makeProject({ name: 'Webs', status: 'new', goal: 'ship it', plan: [] })
    const block = activeProjectContext(project)
    expect(block).not.toContain('Plan:')
    expect(block).toContain('"Webs"')
    expect(block).toContain('ship it')
  })

  it('a project with no goal falls back to the brief', () => {
    const project = makeProject({ name: 'Webs', goal: '', brief: 'a small marketing site for launch' })
    const block = activeProjectContext(project)
    expect(block).toContain('a small marketing site for launch')
  })
})

// --- Part 1a: buildCompanionContext (via buildEngineProviders) — no active
// project must stay byte-identical to today's context. ---

describe('buildEngineProviders context — no active project', () => {
  it('omitting activeProjectId (or passing "") produces the exact same context as before this feature existed', () => {
    setInterview({
      business: '',
      companyName: '',
      website: '',
      departments: [],
      teamSize: '',
      budget: '',
      roles: [],
      priorities: [],
      signoffs: [],
      neverTouch: [],
      compliance: [],
      verifyCommand: '',
      sensitiveWords: [],
    })
    const noArg = buildEngineProviders(settings).providers.context
    const explicitUndefined = buildEngineProviders(settings, undefined).providers.context
    const explicitEmpty = buildEngineProviders(settings, '').providers.context
    const unresolvedId = buildEngineProviders(settings, 'no-such-project-id').providers.context

    expect(explicitUndefined).toBe(noArg)
    expect(explicitEmpty).toBe(noArg)
    // An id that doesn't resolve to a real project is the same as no project —
    // never surfaces a broken/partial block.
    expect(unresolvedId).toBe(noArg)
    expect(noArg).not.toContain('You are working on the project')
  })
})
