import { describe, it, expect, vi } from 'vitest'
import { runInterviewTurn, type InterviewTurnDeps } from './projectInterview'
import { DEFAULT_TURN_BUDGET } from './runBudget'
import type { EngineProviders } from './nativeEngine'
import type { Project } from './projects'

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    path: '~/SC Projects/test-project',
    goal: 'do the thing',
    verifyCommand: 'npm test',
    createdAt: Date.now(),
    status: 'new',
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

const fakeProviders: EngineProviders = { baseUrl: '', apiKey: '' }

interface Harness {
  deps: InterviewTurnDeps
  appendTurn: ReturnType<typeof vi.fn>
  updateProject: ReturnType<typeof vi.fn>
  onTurn: ReturnType<typeof vi.fn>
  runTask: ReturnType<typeof vi.fn>
}

function makeDeps(over: Partial<InterviewTurnDeps> = {}): Harness {
  const appendTurn = vi.fn()
  const updateProject = vi.fn()
  const onTurn = vi.fn()
  const runTask = vi.fn()
  const deps: InterviewTurnDeps = {
    native: true,
    buildProviders: () => ({ providers: fakeProviders, primaryReal: true }),
    resolveVault: async () => '/vault',
    runTask,
    isRealCompletion: (s): s is string => typeof s === 'string' && s.length > 0,
    appendTurn,
    updateProject,
    onTurn,
    ...over,
  }
  return { deps, appendTurn, updateProject, onTurn, runTask }
}

/** Text of the LAST turn recorded — the message the user actually reads. */
function lastTurnText(appendTurn: ReturnType<typeof vi.fn>): string {
  const calls = appendTurn.mock.calls
  return calls[calls.length - 1][1].text as string
}

describe('runInterviewTurn', () => {
  it('plan-ready: promotes to planned with brief + plan, records both turns, fires onTurn', async () => {
    const project = makeProject({ status: 'interviewing' })
    const { deps, appendTurn, updateProject, onTurn, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response: '===PLAN===\nbrief: b\n1. Write PROJECT.md: one page describing the project goal and stack\n2. do it\n===END===',
    })

    await runInterviewTurn(project, 'hello there', deps)

    expect(appendTurn).toHaveBeenCalledWith(project.id, { role: 'user', text: 'hello there' })
    expect(appendTurn).toHaveBeenCalledWith(project.id, {
      role: 'ai',
      text: expect.stringContaining('===PLAN==='),
    })
    expect(onTurn).toHaveBeenCalledTimes(2)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    const patch = call![1]
    expect(patch.brief).toBe('b')
    expect(patch.plan[0]).toMatch(/PROJECT\.md/i)
  })

  it('missing PROJECT.md first step: the promoted plan[0] is the injected step', async () => {
    const project = makeProject({ status: 'interviewing' })
    const { deps, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response: '===PLAN===\nbrief: b\n1. do something else first\n2. then this\n===END===',
    })

    await runInterviewTurn(project, 'go', deps)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    const patch = call![1]
    expect(patch.plan[0]).toBe('Write PROJECT.md: one page describing the project goal and stack')
    expect(patch.plan[1]).toBe('do something else first')
    expect(patch.plan[2]).toBe('then this')
  })

  // ------------------------------------------------------------------------
  // Verify-command extraction (2026-08-29). The node-cli project's plan ENDED
  // with "Run `npm test` as the Tier-1 verify command…" yet verifyCommand
  // stayed '' — nothing in interview→plan→create ever set it. So every step's
  // Tier-1 skipped, the judge graded alone against 0.7, and early steps
  // ping-ponged at 0.63-0.70 through 20-minute refine laps. When the plan
  // lands, the command the plan ITSELF names is stored on the project —
  // never invented, never overwriting one the user already set.
  // ------------------------------------------------------------------------

  it('plan landing stores the verify command the plan names when the project has none', async () => {
    const project = makeProject({ status: 'interviewing', verifyCommand: '' })
    const { deps, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response: [
        '===PLAN===',
        'brief: a node CLI',
        '1. Write PROJECT.md: one page describing the project goal and stack',
        '2. Implement the CLI',
        '3. Run `npm test` as the Tier-1 verify command and fix failures until it passes',
        '===END===',
      ].join('\n'),
    })

    await runInterviewTurn(project, 'go', deps)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    expect(call![1].verifyCommand).toBe('npm test')
  })

  it('plan landing never overwrites a verify command the user already set', async () => {
    const project = makeProject({ status: 'interviewing', verifyCommand: 'make check' })
    const { deps, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response:
        '===PLAN===\nbrief: b\n1. Write PROJECT.md: one page describing the project goal and stack\n2. Run `npm test` as the Tier-1 verify command\n===END===',
    })

    await runInterviewTurn(project, 'go', deps)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    expect('verifyCommand' in call![1]).toBe(false)
  })

  it('plan landing stores nothing when the plan names no command', async () => {
    const project = makeProject({ status: 'interviewing', verifyCommand: '' })
    const { deps, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response:
        '===PLAN===\nbrief: b\n1. Write PROJECT.md: one page describing the project goal and stack\n2. Build the site\n===END===',
    })

    await runInterviewTurn(project, 'go', deps)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    expect('verifyCommand' in call![1]).toBe(false)
  })

  it('plan landing infers npm test from a goal naming package.json + tests', async () => {
    const project = makeProject({
      status: 'interviewing',
      verifyCommand: '',
      goal: 'Build a node CLI. Include a package.json with a test script and real tests.',
    })
    const { deps, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({
      response:
        '===PLAN===\nbrief: b\n1. Write PROJECT.md: one page describing the project goal and stack\n2. Build the CLI\n===END===',
    })

    await runInterviewTurn(project, 'go', deps)

    const call = updateProject.mock.calls.find((c) => c[1]?.status === 'planned')
    expect(call).toBeTruthy()
    expect(call![1].verifyCommand).toBe('npm test')
  })

  it('plain reply (no plan): no planned update; new -> interviewing; records ai turn', async () => {
    const project = makeProject({ status: 'new' })
    const { deps, appendTurn, updateProject, runTask } = makeDeps()
    runTask.mockResolvedValue({ response: 'What is your audience?' })

    await runInterviewTurn(project, 'hi', deps)

    expect(updateProject).toHaveBeenCalledWith(project.id, { status: 'interviewing' })
    expect(updateProject).not.toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ status: 'planned' }),
    )
    expect(appendTurn).toHaveBeenCalledWith(project.id, {
      role: 'ai',
      text: 'What is your audience?',
    })
  })

  it('not installed: records the "need the installed app" turn and never calls runTask', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({ native: false })

    await runInterviewTurn(project, 'hi', deps)

    expect(appendTurn).toHaveBeenCalledWith(project.id, {
      role: 'ai',
      text: 'Project interviews need the installed app.',
    })
    expect(runTask).not.toHaveBeenCalled()
  })

  it('no primary: records "No primary AI is connected" turn, never calls runTask', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({
      buildProviders: () => ({ providers: fakeProviders, primaryReal: false }),
    })

    await runInterviewTurn(project, 'hi', deps)

    expect(appendTurn).toHaveBeenCalledWith(project.id, {
      role: 'ai',
      text: 'No primary AI is connected yet — connect a real provider first.',
    })
    expect(runTask).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------------
  // FIX 2 (2026-08-16) — the three no-answer endings, told apart.
  //
  // ONE sentence used to cover all of them: "Couldn't reach the AI just now."
  // The user read it for a run in which every model call ANSWERED and WE
  // cancelled the run at our own 90s wall. He had no way to tell "too slow"
  // from "unreachable" without opening a span file. Never again:
  //   (a) we cancelled  → says so, names the elapsed, never says unreachable
  //   (b) unreachable   → says nothing came back, and that nothing was cancelled
  //   (c) stub          → says a placeholder came back, and that nothing stalled
  // ------------------------------------------------------------------------

  it('(b) unreachable: nothing came back — says so, and does NOT blame a timeout', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({ timeoutMs: 10_000 })
    runTask.mockResolvedValue(null)

    const ending = await runInterviewTurn(project, 'hi', deps)

    expect(ending).toEqual({ kind: 'unreachable' })
    const text = lastTurnText(appendTurn)
    expect(text).toContain('Couldn’t reach the AI')
    expect(text).toContain('no reply at all')
    expect(text).toContain('nothing was cancelled')
    expect(text).not.toMatch(/we (cancelled|stopped)/i)
  })

  it('(c) stub: a placeholder came back — names the engine\'s own reason, never "unreachable"', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({
      timeoutMs: 10_000,
      isRealCompletion: (x): x is string => typeof x === 'string' && !x.startsWith('[offline:'),
      offlineReason: () => 'the claude CLI did not answer within 180s',
    })
    runTask.mockResolvedValue({ response: '[offline:claude-cli:opus] the claude CLI did not answer within 180s' })

    const ending = await runInterviewTurn(project, 'hi', deps)

    expect(ending).toEqual({ kind: 'stub', reason: 'the claude CLI did not answer within 180s' })
    const text = lastTurnText(appendTurn)
    expect(text).toContain('placeholder')
    expect(text).toContain('the claude CLI did not answer within 180s')
    expect(text).not.toContain('Couldn’t reach')
    expect(text).not.toMatch(/we (cancelled|stopped)/i)
  })

  it('(c) bare stub with no named reason still says placeholder, not unreachable', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({
      timeoutMs: 10_000,
      isRealCompletion: (x): x is string => typeof x === 'string' && !x.startsWith('[offline:'),
    })
    runTask.mockResolvedValue({ response: '[offline:local:local-model] handled: nothing to call' })

    const ending = await runInterviewTurn(project, 'hi', deps)

    expect(ending).toEqual({ kind: 'stub', reason: '' })
    expect(lastTurnText(appendTurn)).toContain('placeholder')
  })

  it('(a) cancelled: names OUR cancellation + the elapsed, and never says unreachable', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({
      budget: { ...DEFAULT_TURN_BUDGET, stallMs: 10, ceilingMs: 5_000 },
    })
    runTask.mockImplementation(() => new Promise(() => {})) // answering, never finishes

    const ending = await runInterviewTurn(project, 'hi', deps)

    expect(ending.kind).toBe('cancelled')
    const text = lastTurnText(appendTurn)
    expect(text).toMatch(/^Stopped after \d+s — we cancelled this run\./)
    expect(text).toContain('The AI did not fail and was not unreachable.')
    expect(text).not.toMatch(/could not be reached/i)
    expect(text).not.toContain('Couldn’t reach')
  })

  it('(a) cancelled: cites the LOCAL model it saw, and why the run was local at all', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps({
      budget: { ...DEFAULT_TURN_BUDGET, stallMs: 10, ceilingMs: 5_000, localTypicalMs: 115_000 },
      lastStep: async () => ({ at: 1, route: 'local' as const, model: 'Qwen3.8-27B-4bit' }),
    })
    runTask.mockImplementation(() => new Promise(() => {}))

    await runInterviewTurn(project, 'hi', deps)

    const text = lastTurnText(appendTurn)
    expect(text).toContain('your local model (Qwen3.8-27B-4bit)')
    expect(text).toContain('averages 115s a call here')
    expect(text).toContain('reading your vault keeps the rest of a run local')
  })

  // H5 (2026-08-06 audit) — the turn used to race a bare timeout with NO run
  // id, so a slow interview was abandoned with its engine child still running.
  // Every run appends to the ONE spans.jsonl, so that draining subprocess's
  // spans were then attributed to whichever run registered next.
  it('hands the engine a real run id and KILLS that run on a timeout', async () => {
    const project = makeProject()
    const cancelRun = vi.fn()
    const { deps, runTask } = makeDeps({ timeoutMs: 10, cancelRun })
    runTask.mockImplementation(() => new Promise(() => {})) // never settles

    await runInterviewTurn(project, 'hi', deps)

    const runId = runTask.mock.calls[0][3]
    expect(typeof runId).toBe('string')
    expect(runId).toMatch(/^run-/)
    expect(cancelRun).toHaveBeenCalledWith(runId)
  })

  it('does NOT cancel when the AI answers in time', async () => {
    const project = makeProject()
    const cancelRun = vi.fn()
    const { deps, runTask } = makeDeps({ timeoutMs: 10_000, cancelRun })
    runTask.mockResolvedValue({ response: 'First question?' })

    await runInterviewTurn(project, 'hi', deps)

    expect(cancelRun).not.toHaveBeenCalled()
  })

  it('blank userText records no user turn (Begin interview flow)', async () => {
    const project = makeProject()
    const { deps, appendTurn, runTask } = makeDeps()
    runTask.mockResolvedValue({ response: 'First question?' })

    await runInterviewTurn(project, '', deps)

    expect(appendTurn).not.toHaveBeenCalledWith(project.id, { role: 'user', text: '' })
    const userCalls = appendTurn.mock.calls.filter((c) => c[1]?.role === 'user')
    expect(userCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FIX 1 (2026-08-16) — the budget is honest about what the run will cost.
//
// The reported failure, to scale: `opus` 27.0s + `opus` 27.2s + a vault_read +
// `Qwen3.8-27B-4bit` 64.8s + 67.5s = ~187s of work, every call answering,
// against a FLAT 90s wall. The vault read is why the tail was local: the egress
// floor (loop.VAULT_LOCAL_REASON) pins the remainder of a vault-reading run to
// the local model, and that must not be weakened — so the BUDGET pays for it.
//
// These use ms-scale numbers with the same SHAPE: each step finishes well inside
// the stall window, and the exchange as a whole runs far past it.
// ---------------------------------------------------------------------------
describe('runInterviewTurn — a progressing run outlives one flat wall', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('completes when every step progresses, even though the whole exchange is 6x the stall window', async () => {
    const project = makeProject()
    let step = 0
    const timer = setInterval(() => {
      step += 1
    }, 20) // a step "closes" every 20ms — the engine is demonstrably alive
    const { deps, appendTurn, runTask } = makeDeps({
      budget: { ...DEFAULT_TURN_BUDGET, stallMs: 50, ceilingMs: 5_000 },
      lastStep: async () => ({ at: step, route: 'local' as const, model: 'Qwen3.8-27B-4bit' }),
      cancelRun: vi.fn(),
    })
    runTask.mockImplementation(async () => {
      await sleep(300) // 6x the stall window, but never stalled
      return { response: 'First question?' }
    })

    const ending = await runInterviewTurn(project, 'hi', deps)
    clearInterval(timer)

    expect(ending).toEqual({ kind: 'reply', planReady: false })
    expect(deps.cancelRun).not.toHaveBeenCalled()
    expect(lastTurnText(appendTurn)).toBe('First question?')
  })

  it('a run that stops progressing IS still cancelled — the budget does not hide a stall', async () => {
    const project = makeProject()
    const cancelRun = vi.fn()
    const { deps, runTask } = makeDeps({
      budget: { ...DEFAULT_TURN_BUDGET, stallMs: 30, ceilingMs: 5_000 },
      lastStep: async () => ({ at: 7, route: 'local' as const }), // frozen: no new step ever
      cancelRun,
    })
    runTask.mockImplementation(() => new Promise(() => {}))

    const ending = await runInterviewTurn(project, 'hi', deps)

    expect(ending.kind).toBe('cancelled')
    if (ending.kind === 'cancelled') expect(ending.facts.reason).toBe('stalled')
    expect(cancelRun).toHaveBeenCalledTimes(1)
  })

  it('the ceiling still bites a run that progresses forever', async () => {
    const project = makeProject()
    const cancelRun = vi.fn()
    let step = 0
    const timer = setInterval(() => {
      step += 1
    }, 10)
    const { deps, runTask } = makeDeps({
      budget: { ...DEFAULT_TURN_BUDGET, stallMs: 25, ceilingMs: 90 },
      lastStep: async () => ({ at: step, route: 'cloud' as const }),
      cancelRun,
    })
    runTask.mockImplementation(() => new Promise(() => {}))

    const ending = await runInterviewTurn(project, 'hi', deps)
    clearInterval(timer)

    expect(ending.kind).toBe('cancelled')
    if (ending.kind === 'cancelled') expect(ending.facts.reason).toBe('ceiling')
    expect(cancelRun).toHaveBeenCalledTimes(1)
  })
})
