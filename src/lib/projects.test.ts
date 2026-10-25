import { describe, expect, it, vi } from 'vitest'
import {
  addProject,
  appendTurn,
  attachProject,
  defaultProjectPath,
  defaultProjectRoster,
  extractVerifyCommand,
  getProjects,
  parsePlanBlock,
  projectBuildRoster,
  removeProject,
  slugify,
  staffRoster,
  unstaffedRefusal,
  updateProject,
  type Project,
} from './projects'
import type { StoredAgent } from './agents'
import { allowAllProviders } from './roster'

function makeAgent(over: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: 'a-1',
    name: 'Test Agent',
    role: 'does the thing',
    model: 'claude',
    skills: [],
    enabled: true,
    usage: 0,
    evalScore: 0,
    system: false,
    orb: '',
    assignedTo: '',
    ...over,
  }
}

describe('slugify', () => {
  it('lowercases and collapses non [a-z0-9] runs to a single dash', () => {
    expect(slugify('My Portfolio!')).toBe('my-portfolio')
  })

  it('trims leading/trailing dashes', () => {
    expect(slugify('  --Weird__Name--  ')).toBe('weird-name')
  })

  it('falls back to "project" for empty/unusable input', () => {
    expect(slugify('')).toBe('project')
    expect(slugify('!!!')).toBe('project')
  })
})

describe('parsePlanBlock', () => {
  it('parses the happy path (numbered steps + brief)', () => {
    const text = [
      'Sure, here is the plan:',
      '===PLAN===',
      'brief: Build a small portfolio site',
      '1. Scaffold the project',
      '2. Add the homepage',
      '3. Deploy',
      '===END===',
      'Let me know if that works!',
    ].join('\n')
    expect(parsePlanBlock(text)).toEqual({
      brief: 'Build a small portfolio site',
      plan: ['Scaffold the project', 'Add the homepage', 'Deploy'],
    })
  })

  it('parses dashed lines', () => {
    const text = ['===PLAN===', 'brief: A dashed plan', '- step one', '- step two', '===END==='].join(
      '\n',
    )
    expect(parsePlanBlock(text)).toEqual({
      brief: 'A dashed plan',
      plan: ['step one', 'step two'],
    })
  })

  it('tolerates a missing brief line (brief defaults to empty)', () => {
    const text = ['===PLAN===', '1. only step', '===END==='].join('\n')
    expect(parsePlanBlock(text)).toEqual({ brief: '', plan: ['only step'] })
  })

  it('returns null when there is no parseable block', () => {
    expect(parsePlanBlock('just some narration, no block here')).toBeNull()
  })

  it('returns null when the block has zero steps', () => {
    const text = ['===PLAN===', 'brief: nothing to do', '===END==='].join('\n')
    expect(parsePlanBlock(text)).toBeNull()
  })
})

describe('extractVerifyCommand', () => {
  it('takes the backticked command a step names as the Tier-1 verify command', () => {
    const plan = [
      'Write PROJECT.md: one page describing the project goal and stack',
      'Implement the CLI entry point',
      'Run `npm test` as the Tier-1 verify command and fix failures until it passes',
    ]
    expect(extractVerifyCommand(plan, 'build a node CLI')).toBe('npm test')
  })

  it('accepts looser phrasing ("as the verify command", any case)', () => {
    const plan = ['use `pytest -q` as the verify command']
    expect(extractVerifyCommand(plan, '')).toBe('pytest -q')
  })

  it('takes the only backticked snippet of a verify-command step even when not adjacent', () => {
    const plan = ['Set up the Tier-1 verify command: `cargo test`']
    expect(extractVerifyCommand(plan, '')).toBe('cargo test')
  })

  it('picks the adjacent snippet when a verify-command step has several', () => {
    const plan = ['After `npm install`, run `npm test` as the Tier-1 verify command']
    expect(extractVerifyCommand(plan, '')).toBe('npm test')
  })

  it('refuses to guess between several non-adjacent snippets', () => {
    const plan = ['Run `npm install` and `npm run build` before the verify command']
    expect(extractVerifyCommand(plan, '')).toBe('')
  })

  it('infers npm test when package.json + tests appear in the goal', () => {
    const goal = 'Build a Node CLI. Include a package.json with a test script and real tests.'
    expect(extractVerifyCommand(['Write PROJECT.md', 'Build it'], goal)).toBe('npm test')
  })

  it('infers npm test when package.json + tests appear in the plan', () => {
    const plan = ['Add a package.json with a test script', 'Write unit tests for the parser']
    expect(extractVerifyCommand(plan, 'small tool')).toBe('npm test')
  })

  it('does not infer npm test from package.json alone (no tests stated)', () => {
    expect(extractVerifyCommand(['Add a package.json with dependencies'], 'a site')).toBe('')
  })

  it('does not infer npm test from tests alone (could be any stack)', () => {
    expect(extractVerifyCommand(['Write tests for the parser'], 'a python tool')).toBe('')
  })

  it('never invents a command the plan does not state', () => {
    expect(extractVerifyCommand(['Write PROJECT.md', 'Build the site', 'Polish'], 'a site')).toBe('')
  })

  it('an explicitly named command wins over the npm inference', () => {
    const plan = ['Add package.json and tests', 'Run `pytest` as the Tier-1 verify command']
    expect(extractVerifyCommand(plan, '')).toBe('pytest')
  })

  it('ignores backticked snippets in steps that never mention a verify command', () => {
    const plan = ['Run `npm run build` to produce the bundle']
    expect(extractVerifyCommand(plan, 'a site')).toBe('')
  })
})

describe('defaultProjectPath', () => {
  it('builds the literal ~/SC Projects/<slug> path', () => {
    expect(defaultProjectPath('my-portfolio')).toBe('~/SC Projects/my-portfolio')
  })
})

describe('addProject', () => {
  it('creates a project with safe defaults', () => {
    const p = addProject('My Portfolio', 'Ship a portfolio site', 'npm test')
    expect(p.name).toBe('My Portfolio')
    expect(p.slug).toBe('my-portfolio')
    expect(p.path).toBe('~/SC Projects/my-portfolio')
    expect(p.goal).toBe('Ship a portfolio site')
    expect(p.verifyCommand).toBe('npm test')
    expect(p.status).toBe('new')
    expect(p.brief).toBe('')
    expect(p.plan).toEqual([])
    expect(p.stepIndex).toBe(0)
    expect(p.refinePass).toBe(0)
    expect(p.transcript).toEqual([])
    expect(p.verdictIds).toEqual([])
    expect(p.lastNote).toBe('')
    expect(typeof p.createdAt).toBe('number')
    expect(getProjects().projects.find((x) => x.id === p.id)).toEqual(p)
  })

  it('honors an explicit path override', () => {
    const p = addProject('Custom', 'goal', 'npm test', '/tmp/custom-dir')
    expect(p.path).toBe('/tmp/custom-dir')
  })
})

describe('updateProject', () => {
  it('patches an existing project in place', () => {
    const p = addProject('Patch Me', 'goal', 'npm test')
    updateProject(p.id, { status: 'running', stepIndex: 2 })
    const updated = getProjects().projects.find((x) => x.id === p.id)!
    expect(updated.status).toBe('running')
    expect(updated.stepIndex).toBe(2)
    expect(updated.name).toBe('Patch Me') // untouched fields survive
  })
})

describe('appendTurn', () => {
  it('appends to the transcript', () => {
    const p = addProject('Turns', 'goal', 'npm test')
    appendTurn(p.id, { role: 'user', text: 'hello' })
    appendTurn(p.id, { role: 'ai', text: 'hi there' })
    const updated = getProjects().projects.find((x) => x.id === p.id)!
    expect(updated.transcript).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'ai', text: 'hi there' },
    ])
  })
})

describe('removeProject', () => {
  it('removes the project by id', () => {
    const p = addProject('Remove Me', 'goal', 'npm test')
    expect(getProjects().projects.some((x) => x.id === p.id)).toBe(true)
    removeProject(p.id)
    expect(getProjects().projects.some((x) => x.id === p.id)).toBe(false)
  })
})

describe('attachProject', () => {
  it('creates a project with mode "existing" and verbatim trimmed path', () => {
    const p = attachProject('Existing', '/home/user/existing-repo', 'Enhance feature', 'npm test')
    expect(p.name).toBe('Existing')
    expect(p.slug).toBe('existing')
    expect(p.path).toBe('/home/user/existing-repo')
    expect(p.goal).toBe('Enhance feature')
    expect(p.verifyCommand).toBe('npm test')
    expect(p.status).toBe('new')
    expect(p.mode).toBe('existing')
    expect(p.baseBranch).toBe('')
    expect(p.runBranch).toBe('')
    expect(p.brief).toBe('')
    expect(p.plan).toEqual([])
    expect(p.stepIndex).toBe(0)
    expect(p.refinePass).toBe(0)
    expect(p.transcript).toEqual([])
    expect(p.verdictIds).toEqual([])
    expect(p.lastNote).toBe('')
    expect(typeof p.createdAt).toBe('number')
    expect(getProjects().projects.find((x) => x.id === p.id)).toEqual(p)
  })

  it('trims the path but preserves it verbatim', () => {
    const p = attachProject('Trim Test', '  /home/user/project  ', 'goal', 'npm test')
    expect(p.path).toBe('/home/user/project')
  })
})

describe('addProject v2 fields', () => {
  it('creates a new project with mode "new" and empty branches', () => {
    const p = addProject('New Project', 'Build something', 'npm test')
    expect(p.mode).toBe('new')
    expect(p.baseBranch).toBe('')
    expect(p.runBranch).toBe('')
  })

  it('creates a new project with no roster (single-doer, off by default)', () => {
    const p = addProject('No Team', 'Build something', 'npm test')
    expect(p.roster).toBe('')
  })
})

describe('defaultProjectRoster', () => {
  it('builds lead:<primary>,planner:gemini,developer:local', () => {
    expect(defaultProjectRoster('claude-cli')).toBe('lead:claude-cli,planner:gemini,developer:local')
  })

  it('mirrors whatever primary provider id is passed', () => {
    expect(defaultProjectRoster('gemini')).toBe('lead:gemini,planner:gemini,developer:local')
  })
})

// The default install-time task-division: the enabled system agents (sys-*)
// on their configured models. Mirrors the SEED in agents.ts (Planner→claude,
// Implementer→local, Reviewer/Verifier→claude), which is what a project
// builds with by default — no per-project roster invented on create.
function systemTeam(): StoredAgent[] {
  return [
    makeAgent({ id: 'sys-planner', name: 'Planner', model: 'claude', system: true, assignedTo: 'system' }),
    makeAgent({ id: 'sys-implementer', name: 'Implementer', model: 'local', system: true, assignedTo: 'system' }),
    makeAgent({ id: 'sys-reviewer', name: 'Reviewer / Verifier', model: 'claude', system: true, assignedTo: 'system' }),
  ]
}

describe('projectBuildRoster', () => {
  it('per-project assigned agents win over everything (the specific-requirement exception)', () => {
    const p = addProject('Teamed', 'goal', 'npm test')
    const agents: StoredAgent[] = [
      makeAgent({ id: 'a-1', name: 'compliance-checker', model: 'claude', assignedTo: p.id }),
      makeAgent({ id: 'a-2', name: 'test-writer', model: 'local', assignedTo: p.id }),
      makeAgent({ id: 'a-3', name: 'unrelated', model: 'gemini', assignedTo: 'some-other-project' }),
      ...systemTeam(),
    ]
    expect(projectBuildRoster(p, agents, allowAllProviders)).toBe('compliance-checker:claude,test-writer:local')
  })

  it('per-project agents override an explicit project.roster too', () => {
    const p = addProject('Teamed', 'goal', 'npm test')
    updateProject(p.id, { roster: 'solo:local' })
    const updated = getProjects().projects.find((x) => x.id === p.id)!
    const agents: StoredAgent[] = [
      makeAgent({ id: 'a-1', name: 'compliance-checker', model: 'claude', assignedTo: p.id }),
      ...systemTeam(),
    ]
    expect(projectBuildRoster(updated, agents, allowAllProviders)).toBe('compliance-checker:claude')
  })

  it('excludes disabled assigned agents (agentRoster already skips them)', () => {
    const p = addProject('Teamed', 'goal', 'npm test')
    const agents: StoredAgent[] = [
      makeAgent({ id: 'a-1', name: 'on-agent', model: 'claude', assignedTo: p.id, enabled: true }),
      makeAgent({ id: 'a-2', name: 'off-agent', model: 'local', assignedTo: p.id, enabled: false }),
    ]
    expect(projectBuildRoster(p, agents, allowAllProviders)).toBe('on-agent:claude')
  })

  it('uses an explicit project.roster override when set (no per-project agents), over the system team', () => {
    const p = addProject('Solo', 'goal', 'npm test')
    updateProject(p.id, { roster: 'solo:local' })
    const updated = getProjects().projects.find((x) => x.id === p.id)!
    const agents: StoredAgent[] = [
      makeAgent({ id: 'a-1', name: 'unrelated', model: 'claude', assignedTo: 'a-different-project' }),
      ...systemTeam(),
    ]
    expect(projectBuildRoster(updated, agents, allowAllProviders)).toBe('solo:local')
  })

  it('DEFAULTS to the enabled system agents’ roster (the install-time task-division) when no per-project agents and no override', () => {
    const p = addProject('DefaultTeam', 'goal', 'npm test')
    expect(projectBuildRoster(p, systemTeam(), allowAllProviders)).toBe(
      'planner:claude,implementer:local,reviewer-verifier:claude',
    )
  })

  it('excludes disabled system agents from the default team', () => {
    const p = addProject('DefaultTeam', 'goal', 'npm test')
    const agents = systemTeam()
    agents[1].enabled = false // Implementer off
    expect(projectBuildRoster(p, agents, allowAllProviders)).toBe('planner:claude,reviewer-verifier:claude')
  })

  it('does not treat non-system assigned/library agents as the default team', () => {
    const p = addProject('DefaultTeam', 'goal', 'npm test')
    const agents: StoredAgent[] = [
      // library agent (assignedTo '') and another project's agent — neither is
      // a system agent, so with no per-project agents + no override the team is
      // empty → '' (single-doer), not these strays.
      makeAgent({ id: 'lib-1', name: 'library', model: 'claude', assignedTo: '' }),
      makeAgent({ id: 'other-1', name: 'other', model: 'local', assignedTo: 'another-project' }),
    ]
    expect(projectBuildRoster(p, agents, allowAllProviders)).toBe('')
  })

  it('falls back to \'\' when there are no agents at all (single-doer, honest)', () => {
    const p = addProject('NoTeam', 'goal', 'npm test')
    expect(projectBuildRoster(p, [], allowAllProviders)).toBe('')
  })
})

// --- Kept LAST: resets the module registry, so must not run before the tests
// above that rely on the live singleton's accumulated state within this file. ---
describe('sanitize back-compat on load', () => {
  it('fills every missing field with safe defaults from a legacy stored shape', async () => {
    localStorage.setItem(
      'scprism.projects',
      JSON.stringify({
        projects: [
          { id: 'legacy-1', name: 'Legacy', slug: 'legacy' },
          { id: 42 }, // not even a string id — must be dropped entirely
          null,
        ],
      }),
    )
    vi.resetModules()
    const fresh = await import('./projects')
    const state = fresh.getProjects()
    expect(state.projects).toHaveLength(1)
    const p: Project = state.projects[0]
    expect(p.id).toBe('legacy-1')
    expect(p.name).toBe('Legacy')
    expect(p.slug).toBe('legacy')
    expect(p.path).toBe('')
    expect(p.goal).toBe('')
    expect(p.verifyCommand).toBe('')
    expect(p.createdAt).toBe(0)
    expect(p.status).toBe('new')
    expect(p.brief).toBe('')
    expect(p.plan).toEqual([])
    expect(p.stepIndex).toBe(0)
    expect(p.refinePass).toBe(0)
    expect(p.transcript).toEqual([])
    expect(p.verdictIds).toEqual([])
    expect(p.lastNote).toBe('')
    expect(p.mode).toBe('new')
    expect(p.baseBranch).toBe('')
    expect(p.runBranch).toBe('')
    expect(p.roster).toBe('')
  })

  it('keeps a string roster as-is', async () => {
    localStorage.setItem(
      'scprism.projects',
      JSON.stringify({
        projects: [
          {
            id: 'has-roster',
            name: 'Teamed',
            slug: 'teamed',
            roster: 'lead:claude-cli,planner:gemini,developer:local',
          },
        ],
      }),
    )
    vi.resetModules()
    const fresh = await import('./projects')
    const state = fresh.getProjects()
    expect(state.projects[0].roster).toBe('lead:claude-cli,planner:gemini,developer:local')
  })

  it('drops a non-string roster to empty (back-compat, no crash)', async () => {
    localStorage.setItem(
      'scprism.projects',
      JSON.stringify({
        projects: [{ id: 'bad-roster', name: 'Bad', slug: 'bad', roster: 42 }],
      }),
    )
    vi.resetModules()
    const fresh = await import('./projects')
    const state = fresh.getProjects()
    expect(state.projects[0].roster).toBe('')
  })

  it('recovers orphaned running projects on load as attention with interrupt note', async () => {
    localStorage.setItem(
      'scprism.projects',
      JSON.stringify({
        projects: [
          {
            id: 'orphaned-run',
            name: 'Dead Run',
            slug: 'dead-run',
            path: '/home/user/project',
            goal: 'test',
            verifyCommand: 'npm test',
            createdAt: 1234567890,
            status: 'running',
            brief: 'old brief',
            plan: ['step 1'],
            stepIndex: 0,
            refinePass: 0,
            transcript: [],
            verdictIds: [],
            lastNote: 'previous note',
          },
        ],
      }),
    )
    vi.resetModules()
    const fresh = await import('./projects')
    const state = fresh.getProjects()
    expect(state.projects).toHaveLength(1)
    const p: Project = state.projects[0]
    expect(p.id).toBe('orphaned-run')
    expect(p.status).toBe('attention')
    expect(p.lastNote).toBe('run interrupted — press Start to resume')
  })
})

// The staffing gate (2026-08-30). A typed roster's role key must resolve to a
// REAL library/system agent — observed live 2026-08-29 (proj-site-launch):
// a "lead:claude" override reached the engine, whose parse_agents bound the
// fallback charter "Act as the team's lead." and the seat answered in a generic
// verifier voice with no FILE blocks, lap after lap. Same honesty pattern as
// the provider gate: dropped WITH a reason, refused when nothing is left.
describe('staffRoster', () => {
  it('passes a roster of real library slugs through byte-identical', () => {
    const roster = 'planner:claude,implementer:local,reviewer-verifier:claude'
    expect(staffRoster(roster, systemTeam())).toEqual({ roster, unstaffed: [] })
  })

  it('the default system-team roster is never bitten by the gate (built from the same library)', () => {
    const p = addProject('Staffed', 'goal', 'npm test')
    const built = projectBuildRoster(p, systemTeam(), allowAllProviders)
    expect(staffRoster(built, systemTeam()).roster).toBe(built)
  })

  it('REFUSES a role key that names no agent, with the reason', () => {
    expect(staffRoster('lead:claude', systemTeam())).toEqual({
      roster: '',
      unstaffed: [
        { role: 'lead', token: 'claude', reason: 'no agent in your library is named “lead”' },
      ],
    })
  })

  it('keeps the real seats and reports the fake one, in order', () => {
    const { roster, unstaffed } = staffRoster('planner:claude,lead:claude,implementer:local', systemTeam())
    expect(roster).toBe('planner:claude,implementer:local')
    expect(unstaffed).toEqual([
      { role: 'lead', token: 'claude', reason: 'no agent in your library is named “lead”' },
    ])
  })

  it('matches a display name case-insensitively (typed in the agent’s own words)', () => {
    expect(staffRoster('Planner:claude', systemTeam()).unstaffed).toEqual([])
  })

  it('matches a slugged name regardless of case (Reviewer-Verifier → “Reviewer / Verifier”)', () => {
    expect(staffRoster('Reviewer-Verifier:claude', systemTeam()).unstaffed).toEqual([])
  })

  it('normalizes a bare key to :local exactly like splitRoster (the launch path’s reading)', () => {
    expect(staffRoster('implementer', systemTeam()).roster).toBe('implementer:local')
  })

  it('an empty roster stays the honest single-doer, never a refusal', () => {
    expect(staffRoster('', systemTeam())).toEqual({ roster: '', unstaffed: [] })
  })
})

describe('unstaffedRefusal', () => {
  it('names every refused seat and the fix', () => {
    const { unstaffed } = staffRoster('lead:claude', systemTeam())
    expect(unstaffedRefusal(unstaffed)).toBe(
      'No seat could be staffed: lead sits out: no agent in your library is named “lead”. ' +
        'Name agents from your library, or clear the override to build with the system team.',
    )
  })
})

// One vault, everything in it (Sukhdeep, 2026-08-31: "the application should
// be building projects inside the Obsidian vault we chose — a company has ONE
// vault"). New projects default into <vault>/projects/<slug>; a caller with
// no vault falls back to the old home; existing projects keep their recorded
// paths untouched (addProject only defaults when no path is given).
describe('defaultProjectPath — vault-homed', () => {
  it('builds inside the chosen vault', () => {
    expect(defaultProjectPath('site-launch', '~/sc-vault')).toBe('~/sc-vault/projects/site-launch')
  })
  it('falls back to the classic home when no vault is known', () => {
    expect(defaultProjectPath('site-launch')).toBe('~/SC Projects/site-launch')
  })
})
