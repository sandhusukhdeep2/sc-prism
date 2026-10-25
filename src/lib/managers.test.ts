import { describe, expect, it, vi } from 'vitest'
import {
  COMPANION_MANAGER_ID,
  DARK_WAKE_SKIP_LINE,
  DEFAULT_CADENCE_MIN,
  OLD_STARTER_CHARTER,
  STARTER_CHARTER,
  addJob,
  approveDispatch,
  beatDue,
  beatsTodayTokens,
  cadenceLabel,
  darkWakeBeat,
  defaultTeamRoster,
  dueJobs,
  ensureSeeded,
  getManagers,
  heartbeatConsentCopy,
  heartbeatNoticeDue,
  jobKind,
  ladderBrief,
  managerDisplayName,
  migrateCharter,
  managerIdFor,
  nextDispatchAction,
  parkJob,
  beatLineWithNote,
  parseWakeReply,
  recordBeat,
  recordJobRun,
  recordManagerBeat,
  rejectDispatch,
  seedFromSetup,
  setManagerEnabled,
  shouldDefaultOn,
  shouldSkipWake,
  topRung,
  trimReport,
  updateHeartbeat,
  wakeNowBlockReason,
  type Beat,
  type Heartbeat,
  type LadderState,
  type ManagerJob,
  type ManagersState,
} from './managers'
import { allowAllProviders } from './roster'
import { DEFAULT_SETTINGS, type Settings } from './settings'
import type { InterviewState } from './interview'

const interview: InterviewState = {
  business: 'Finance practice',
  companyName: 'Sukh',
  website: '',
  departments: ['operations', 'finance', 'compliance'],
  teamSize: '20+ people',
  budget: '$1k+/mo',
  sensitiveWords: ['client PII'],
  verifyCommand: 'npm test',
  compliance: ['GDPR', 'SOC 2'],
  roles: ['developer'],
  priorities: ['speed', 'cost', 'compliance'],
  signoffs: ['push-main'],
  neverTouch: ['prod DB'],
  adaptive: [],
}

function settingsWith(enabled: string[]): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: DEFAULT_SETTINGS.providers.map((p) => ({
      ...p,
      enabled: enabled.includes(p.id),
    })),
  }
}

describe('seedFromSetup', () => {
  it('creates one disabled manager per enabled provider (plus the companion)', () => {
    const s = seedFromSetup(settingsWith(['local', 'claude-cli', 'gemini']), interview)
    expect(s.managers.map((m) => m.providerId).sort()).toEqual([
      'claude-cli',
      'gemini',
      'local',
      'primary', // the companion (heartbeat carrier) rides along
    ])
    expect(s.managers.every((m) => !m.enabled)).toBe(true)
    expect(s.seeded).toBe(true)
  })

  it('seeds the companion manager with a DISABLED heartbeat (consent is explicit)', () => {
    const s = seedFromSetup(settingsWith(['local']), interview)
    const c = s.managers.find((m) => m.id === COMPANION_MANAGER_ID)!
    expect(c.providerId).toBe('primary')
    // 2h (DEFAULT_CADENCE_MIN), not the old 30m — 2026-08-15 §2.
    expect(c.heartbeat).toMatchObject({ enabled: false, everyMinutes: 120, lastBeat: 0, beats: [] })
    expect(c.heartbeat!.charter.length).toBeGreaterThan(0)
  })

  it('seeds interview-driven jobs on the right managers', () => {
    const s = seedFromSetup(settingsWith(['local', 'claude-cli', 'gemini']), interview)
    const titles = s.jobs.map((j) => j.title)
    expect(titles).toContain('Compliance check') // compliance regimes exist
    expect(titles).toContain('Summarize new notes')
    expect(titles).toContain('Vault health')
    const summarize = s.jobs.find((j) => j.title === 'Summarize new notes')!
    expect(summarize.managerId).toBe(managerIdFor('local')) // private → local
    const compliance = s.jobs.find((j) => j.title === 'Compliance check')!
    expect(compliance.department).toBe('compliance')
    expect(compliance.prompt).toContain('GDPR')
  })

  it('skips the compliance job when no regimes were given', () => {
    const s = seedFromSetup(settingsWith(['local']), { ...interview, compliance: [] })
    expect(s.jobs.map((j) => j.title)).not.toContain('Compliance check')
  })
})

describe('dueJobs', () => {
  const base = seedFromSetup(settingsWith(['local']), interview)
  const withEnabled = (enabled: boolean): ManagersState => ({
    ...base,
    managers: base.managers.map((m) => ({ ...m, enabled })),
  })

  it('returns nothing while managers are disabled', () => {
    expect(dueJobs(withEnabled(false), Date.now())).toEqual([])
  })

  it('returns overdue jobs for enabled managers', () => {
    const s = withEnabled(true)
    const now = 10 * 24 * 60 * 60_000 // far past every interval (lastRun = 0)
    expect(dueJobs(s, now).length).toBeGreaterThan(0)
  })

  it('respects the interval after a run', () => {
    const s = withEnabled(true)
    const job = s.jobs[0]
    const ran: ManagersState = {
      ...s,
      jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, lastRun: 1_000_000 } : j)),
    }
    const justAfter = 1_000_000 + 60_000 // 1 minute later — not due
    expect(dueJobs(ran, justAfter).map((j) => j.id)).not.toContain(job.id)
  })
})

describe('trimReport', () => {
  it('appends under the cap unchanged', () => {
    expect(trimReport('a', 'b', 100)).toBe('ab')
  })

  it('trims from the oldest content, preferring an entry boundary', () => {
    const old = '## old entry\nxxxx\n' + 'y'.repeat(100)
    const out = trimReport(old, '\n## new entry\nzz', 80)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).toContain('## new entry')
    expect(out.startsWith('\n## new entry') || !out.includes('## old entry')).toBe(true)
  })
})

// --- Part B: dispatch jobs ---

const dispatchJob = (over: Partial<ManagerJob> = {}): ManagerJob => ({
  id: 'jd1',
  managerId: 'mgr-local',
  title: 'tidy vault',
  department: 'operations',
  prompt: 'tidy orphan notes',
  everyMinutes: 5,
  lastRun: 0,
  runs: [],
  kind: 'dispatch',
  approval: 'ask',
  pendingSince: 0,
  approvedAt: 0,
  ...over,
})

describe('jobKind', () => {
  it('defaults a legacy job (no kind field) to report', () => {
    const legacy = { ...dispatchJob(), kind: undefined }
    expect(jobKind(legacy)).toBe('report')
    expect(jobKind(dispatchJob())).toBe('dispatch')
  })
})

describe('nextDispatchAction', () => {
  it('report jobs always run (the driver path is unchanged for them)', () => {
    expect(nextDispatchAction({ ...dispatchJob(), kind: undefined })).toBe('run')
  })
  it('an approved dispatch runs regardless of other flags', () => {
    expect(nextDispatchAction(dispatchJob({ approvedAt: 111 }))).toBe('run')
  })
  it('an auto dispatch runs without approval', () => {
    expect(nextDispatchAction(dispatchJob({ approval: 'auto' }))).toBe('run')
  })
  it('an ask dispatch parks first, then waits while parked', () => {
    expect(nextDispatchAction(dispatchJob())).toBe('park')
    expect(nextDispatchAction(dispatchJob({ pendingSince: 222 }))).toBe('wait')
  })
})

describe('dueJobs with dispatch flags', () => {
  const state = (job: ManagerJob) => ({
    managers: [{ id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: true }],
    jobs: [job],
    seeded: true,
  })
  it('includes an approved dispatch even when its timer is not due', () => {
    const j = dispatchJob({ lastRun: Date.now(), approvedAt: 1 }) // timer NOT elapsed
    expect(dueJobs(state(j), Date.now()).map((x) => x.id)).toEqual(['jd1'])
  })
  it('excludes a parked dispatch even when its timer is due', () => {
    const j = dispatchJob({ pendingSince: 1 }) // lastRun 0 → timer due
    expect(dueJobs(state(j), Date.now())).toEqual([])
  })
  it('excludes an approved dispatch when its manager is disabled (approval goes latent until re-enable)', () => {
    const j = dispatchJob({ approvedAt: 1 })
    const s = {
      managers: [{ id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: false }],
      jobs: [j],
      seeded: true,
    }
    expect(dueJobs(s, Date.now())).toEqual([])
  })
})

describe('dispatch store actions', () => {
  it('park → approve → run-record round-trips the flags', () => {
    setManagerEnabled('mgr-x', true) // ensure the store singleton is alive
    addJob('mgr-x', 'dispatch me', 'general', 'do the thing', 5, 'dispatch', 'ask')
    const id = getManagers().jobs[0].id

    parkJob(id, 1000)
    expect(getManagers().jobs[0].pendingSince).toBe(1000)

    approveDispatch(id, 2000)
    expect(getManagers().jobs[0].pendingSince).toBe(0)
    expect(getManagers().jobs[0].approvedAt).toBe(2000)

    recordJobRun(id, 3000, true, 'done')
    const j = getManagers().jobs[0]
    expect(j.lastRun).toBe(3000)
    expect(j.pendingSince).toBe(0)
    expect(j.approvedAt).toBe(0)
    expect(j.runs[0]).toEqual({ at: 3000, ok: true, summary: 'done' })
  })

  it('reject clears the flags, reschedules via lastRun, and records NO run', () => {
    addJob('mgr-x', 'reject me', 'general', 'do the thing', 5, 'dispatch', 'ask')
    const id = getManagers().jobs[0].id
    parkJob(id, 1000)
    rejectDispatch(id, 5000)
    const j = getManagers().jobs[0]
    expect(j.pendingSince).toBe(0)
    expect(j.approvedAt).toBe(0)
    expect(j.lastRun).toBe(5000)
    expect(j.runs).toEqual([])
  })

  it('addJob defaults to a report job when kind is omitted', () => {
    addJob('mgr-x', 'plain report', 'general', 'report on things', 5)
    expect(jobKind(getManagers().jobs[0])).toBe('report')
  })
})

// --- Part C1: team job kind ---

const teamJob = (over: Partial<ManagerJob> = {}): ManagerJob => ({
  id: 'jt1',
  managerId: 'mgr-local',
  title: 'team tidy vault',
  department: 'operations',
  prompt: 'tidy orphan notes',
  everyMinutes: 5,
  lastRun: 0,
  runs: [],
  kind: 'team',
  approval: 'ask',
  pendingSince: 0,
  approvedAt: 0,
  roster: '',
  tokenBudget: 0,
  ...over,
})

describe('jobKind team', () => {
  it('returns team only for the exact kind "team"', () => {
    expect(jobKind(teamJob())).toBe('team')
  })
  it('still defaults an unknown kind string to report (not team)', () => {
    expect(jobKind({ ...teamJob(), kind: 'bogus' as unknown as 'team' })).toBe('report')
  })
})

describe('nextDispatchAction team (mirrors the dispatch transitions exactly)', () => {
  it('an approved team job runs regardless of other flags', () => {
    expect(nextDispatchAction(teamJob({ approvedAt: 111 }))).toBe('run')
  })
  it('an auto team job runs without approval', () => {
    expect(nextDispatchAction(teamJob({ approval: 'auto' }))).toBe('run')
  })
  it('an ask team job parks first', () => {
    expect(nextDispatchAction(teamJob())).toBe('park')
  })
  it('a parked ask team job waits', () => {
    expect(nextDispatchAction(teamJob({ pendingSince: 222 }))).toBe('wait')
  })
})

// A MANAGER CHOOSES ITS CREW; it does not read it off a hard-coded table.
//
// This used to pin `researcher` to 'local' and `critic` to Gemini, then DROP
// any seat whose provider could not answer. On Sukhdeep's Mac — Gemini off,
// Claude's CLI failing its probe — that produced a "team" of one local
// researcher, which is what he saw and what he objected to: the default
// fallback should not be local, and the manager should be deciding.
describe('defaultTeamRoster — the crew a manager can actually field', () => {
  it('leads with the manager’s OWN model, then spreads the rest across others', () => {
    // Three AIs available: three seats, three different models. A crew is more
    // than one opinion, and two seats on one model is one opinion typed twice.
    const roster = defaultTeamRoster('claude-cli', allowAllProviders, [
      'local',
      'claude-cli',
      'gemini',
    ])
    expect(roster).toBe('lead:claude-cli,researcher:local,critic:gemini')
  })

  it('never pins the researcher to local just because local exists', () => {
    const roster = defaultTeamRoster('gemini', allowAllProviders, ['local', 'gemini', 'claude'])
    // The lead holds gemini; the other two take the remaining models — local is
    // one option among them, not a fixed destiny for the research seat.
    expect(roster.startsWith('lead:gemini,')).toBe(true)
    expect(new Set(roster.split(',').map((s) => s.split(':')[1])).size).toBe(3)
  })

  it('DOUBLES UP rather than deleting a seat when diversity runs out', () => {
    // The old behaviour: two of these seats vanished and the manager fielded a
    // team of one. A smaller team than you hoped for is a disappointment; a
    // team of one because two seats were quietly deleted is a broken product.
    const onlyLocal = (token: string) => (token === 'local' ? '' : 'not connected')
    expect(defaultTeamRoster('claude-cli', onlyLocal, ['local', 'claude-cli', 'gemini'])).toBe(
      'lead:local,researcher:local,critic:local',
    )
  })

  it('fills every seat even when only two AIs can answer', () => {
    const noGemini = (token: string) => (token === 'gemini' ? 'Gemini is switched off' : '')
    const roster = defaultTeamRoster('claude-cli', noGemini, ['local', 'claude-cli', 'gemini'])
    expect(roster.split(',')).toHaveLength(3)
    expect(roster).not.toMatch(/gemini/)
  })

  it('drops the manager’s own model from the lead when IT cannot answer', () => {
    const noClaude = (token: string) => (token.startsWith('claude') ? 'not signed in' : '')
    const roster = defaultTeamRoster('claude-cli', noClaude, ['local', 'claude-cli'])
    expect(roster).toBe('lead:local,researcher:local,critic:local')
  })

  it('yields "" when nothing is connected — the dispatcher refuses on that', () => {
    expect(defaultTeamRoster('local', () => 'nothing is connected')).toBe('')
  })
})

describe('addJob team params', () => {
  it('stores a trailing roster and tokenBudget for a team job', () => {
    addJob(
      'mgr-x',
      'team job',
      'general',
      'go team',
      5,
      'team',
      'auto',
      'lead:local,researcher:local,critic:gemini',
      20_000,
    )
    const j = getManagers().jobs[0]
    expect(j.kind).toBe('team')
    expect(j.approval).toBe('auto')
    expect(j.roster).toBe('lead:local,researcher:local,critic:gemini')
    expect(j.tokenBudget).toBe(20_000)
  })

  it('defaults roster to "" and tokenBudget to 0 when the trailing params are omitted', () => {
    addJob('mgr-x', 'plain dispatch', 'general', 'go', 5, 'dispatch', 'ask')
    const j = getManagers().jobs[0]
    expect(j.roster).toBe('')
    expect(j.tokenBudget).toBe(0)
  })
})

describe('sanitize back-compat on load', () => {
  it('normalizes a legacy stored job to report/ask with zeroed flags', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [{ id: 'old1', managerId: 'mgr-l', title: 't', department: 'd', prompt: 'p', everyMinutes: 5, lastRun: 0, runs: [] }],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    const j = fresh.getManagers().jobs[0]
    expect(j.kind).toBe('report')
    expect(j.approval).toBe('ask')
    expect(j.pendingSince).toBe(0)
    expect(j.approvedAt).toBe(0)
    expect(j.roster).toBe('')
    expect(j.tokenBudget).toBe(0)
  })

  it('leaves a stored report job unchanged (byte-identical behavior)', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [{ id: 'old2', managerId: 'mgr-l', title: 't', department: 'd', prompt: 'p', everyMinutes: 5, lastRun: 0, runs: [], kind: 'report', approval: 'ask', pendingSince: 0, approvedAt: 0 }],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().jobs[0].kind).toBe('report')
  })

  it('leaves a stored dispatch job unchanged (byte-identical behavior)', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [{ id: 'old3', managerId: 'mgr-l', title: 't', department: 'd', prompt: 'p', everyMinutes: 5, lastRun: 0, runs: [], kind: 'dispatch', approval: 'auto', pendingSince: 0, approvedAt: 0 }],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    const j = fresh.getManagers().jobs[0]
    expect(j.kind).toBe('dispatch')
    expect(j.approval).toBe('auto')
  })

  it('normalizes a stored team job: kind kept, invalid roster/tokenBudget reset to defaults', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [
          {
            id: 'old4',
            managerId: 'mgr-l',
            title: 't',
            department: 'd',
            prompt: 'p',
            everyMinutes: 5,
            lastRun: 0,
            runs: [],
            kind: 'team',
            roster: 123, // invalid — not a string
            tokenBudget: 'lots', // invalid — not a number
          },
        ],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    const j = fresh.getManagers().jobs[0]
    expect(j.kind).toBe('team')
    expect(j.roster).toBe('')
    expect(j.tokenBudget).toBe(0)
  })

  it('keeps a valid stored team roster/tokenBudget as-is', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [
          {
            id: 'old5',
            managerId: 'mgr-l',
            title: 't',
            department: 'd',
            prompt: 'p',
            everyMinutes: 5,
            lastRun: 0,
            runs: [],
            kind: 'team',
            roster: 'lead:local,researcher:local,critic:gemini',
            tokenBudget: 50_000,
          },
        ],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    const j = fresh.getManagers().jobs[0]
    expect(j.roster).toBe('lead:local,researcher:local,critic:gemini')
    expect(j.tokenBudget).toBe(50_000)
  })

  it('normalizes an unrecognized kind string to report (not team, not dispatch)', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [{ id: 'old6', managerId: 'mgr-l', title: 't', department: 'd', prompt: 'p', everyMinutes: 5, lastRun: 0, runs: [], kind: 'bogus' }],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().jobs[0].kind).toBe('report')
  })
})

// --- Heartbeat (2026-07-29 spec) ---

const heartbeat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  enabled: true,
  charter: 'watch the projects and vault',
  everyMinutes: 30,
  lastBeat: 1_000_000,
  beats: [],
  today: { day: '', beats: 0, tokens: 0 },
  consent: 'on',
  autoOnAt: 0,
  ...over,
})

const beat = (over: Partial<Beat> = {}): Beat => ({
  at: 1_000_000,
  action: 'worked',
  line: 'tidied the vault index',
  ok: true,
  tokens: 100,
  ...over,
})

describe('beatDue', () => {
  it('never due while off — even far past the interval (default OFF honesty)', () => {
    expect(beatDue(Number.MAX_SAFE_INTEGER, heartbeat({ enabled: false }))).toBe(false)
    expect(beatDue(Number.MAX_SAFE_INTEGER, undefined)).toBe(false)
  })
  it('due exactly at the boundary (>= discipline, mirrors dueJobs)', () => {
    expect(beatDue(1_000_000 + 30 * 60_000, heartbeat())).toBe(true)
  })
  it('not due one ms before the boundary', () => {
    expect(beatDue(1_000_000 + 30 * 60_000 - 1, heartbeat())).toBe(false)
  })
  it('lastBeat 0 (never beat) is due immediately once enabled', () => {
    expect(beatDue(Date.now(), heartbeat({ lastBeat: 0 }))).toBe(true)
  })
})

describe('parseWakeReply', () => {
  it('NOTHING_NEEDED → rested, carrying the honest line after the dash', () => {
    expect(parseWakeReply('NOTHING_NEEDED — quiet day')).toEqual({
      action: 'rested',
      line: 'quiet day',
    })
  })
  it('a bare NOTHING_NEEDED still rests with a fallback line (rested beats say why)', () => {
    expect(parseWakeReply('NOTHING_NEEDED')).toEqual({ action: 'rested', line: 'nothing needed' })
  })
  it('anything else is work — the beat line is the first line only', () => {
    expect(parseWakeReply('Drafted a vault summary.\nAnd more detail below.')).toEqual({
      action: 'worked',
      line: 'Drafted a vault summary.',
    })
  })
  it('leading whitespace is trimmed before classifying', () => {
    expect(parseWakeReply('\n\n  NOTHING_NEEDED — all reports fresh').action).toBe('rested')
  })
  it('caps the beat line at 160 chars (same cap as a run summary)', () => {
    expect(parseWakeReply('x'.repeat(500)).line).toHaveLength(160)
  })

  // Protocol tightening (audit): the rest token is exact + whole-reply only,
  // and a blank reply is a distinct non-event the driver records ok:false.
  it('a blank reply is a rested non-event with the honest blank line', () => {
    expect(parseWakeReply('')).toEqual({ action: 'rested', line: 'blank reply — nothing recorded' })
  })
  it('a whitespace-only reply classifies the same as blank', () => {
    expect(parseWakeReply('  \n\t \n')).toEqual({
      action: 'rested',
      line: 'blank reply — nothing recorded',
    })
  })
  it('NOTHING_NEEDED followed by prose on the same line is WORK — content is never dropped', () => {
    expect(parseWakeReply('NOTHING_NEEDED is wrong — found a risk')).toEqual({
      action: 'worked',
      line: 'NOTHING_NEEDED is wrong — found a risk',
    })
  })
  it('a NOTHING_NEEDED_X token is WORK — only the exact word (then end/dash/colon) rests', () => {
    expect(parseWakeReply('NOTHING_NEEDED_X did Y')).toEqual({
      action: 'worked',
      line: 'NOTHING_NEEDED_X did Y',
    })
  })
  it('a rest-line followed by extra paragraphs is WORK — the remainder must be blank', () => {
    expect(
      parseWakeReply('NOTHING_NEEDED — quiet day\n\nActually, here is a page of analysis…').action,
    ).toBe('worked')
  })
  it('a genuine rest-line with only trailing whitespace after it still rests', () => {
    expect(parseWakeReply('NOTHING_NEEDED — quiet day\n\n  ')).toEqual({
      action: 'rested',
      line: 'quiet day',
    })
  })
  it('a colon separator rests too (NOTHING_NEEDED: …)', () => {
    expect(parseWakeReply('NOTHING_NEEDED: all fresh')).toEqual({
      action: 'rested',
      line: 'all fresh',
    })
  })
})

// Audit (2026-08-11): `${replyLine}${proposalNote}`.slice(0, 280) guillotined
// the note — and the note is the honest half. A refusal naming three ~40-char
// run ids runs ~150 chars, so it was being cut mid-id, leaving a truncated id
// that resolves to nothing.
describe('beatLineWithNote — the note is budgeted, not guillotined', () => {
  const NOTE = ` · proposal ignored (cited evidence I can't verify: ${['a', 'b', 'c']
    .map((c) => c.repeat(40))
    .join(', ')})`

  it('keeps the whole note and trims the reply line instead', () => {
    const out = beatLineWithNote('x'.repeat(160), NOTE)
    expect(out).toHaveLength(280)
    expect(out.endsWith(NOTE)).toBe(true)
    expect(out).toContain('…') // the trim is visible, not silent
  })

  it('leaves a line that already fits completely untouched', () => {
    expect(beatLineWithNote('Tidied the vault index.', ' · proposed a new agent: x')).toBe(
      'Tidied the vault index. · proposed a new agent: x',
    )
  })

  it('no note → the plain capped line (an ordinary beat is byte-identical)', () => {
    expect(beatLineWithNote('Tidied the vault index.', '')).toBe('Tidied the vault index.')
    expect(beatLineWithNote('x'.repeat(400), '')).toHaveLength(280)
  })

  it('a note longer than the whole budget is truncated alone', () => {
    expect(beatLineWithNote('reply', 'y'.repeat(400))).toBe('y'.repeat(280))
  })
})

describe('recordBeat', () => {
  it('prepends newest-first and advances lastBeat', () => {
    const next = recordBeat(heartbeat({ beats: [beat({ at: 1 })] }), beat({ at: 2_000_000 }))
    expect(next.lastBeat).toBe(2_000_000)
    expect(next.beats.map((b) => b.at)).toEqual([2_000_000, 1])
  })
  it('trims to 40 beats', () => {
    const full = heartbeat({ beats: Array.from({ length: 40 }, (_, i) => beat({ at: i })) })
    const next = recordBeat(full, beat({ at: 9_999_999 }))
    expect(next.beats).toHaveLength(40)
    expect(next.beats[0].at).toBe(9_999_999)
    expect(next.beats.map((b) => b.at)).not.toContain(39) // oldest fell off
  })
  it('rolls the per-day accumulator and resets it on a local day change', () => {
    const day1 = new Date(2026, 6, 28, 9, 0).getTime()
    const day2 = new Date(2026, 6, 29, 9, 0).getTime()
    const afterDay1 = recordBeat(heartbeat(), beat({ at: day1, tokens: 7 }))
    expect(afterDay1.today).toMatchObject({ beats: 1, tokens: 7 })
    const sameDay = recordBeat(afterDay1, beat({ at: day1 + 60_000, tokens: 3 }))
    expect(sameDay.today).toMatchObject({ beats: 2, tokens: 10 })
    const afterDay2 = recordBeat(sameDay, beat({ at: day2, tokens: 5 }))
    expect(afterDay2.today).toMatchObject({ beats: 1, tokens: 5 }) // new local day → reset
  })
})

describe('beatsTodayTokens', () => {
  // Local-time day boundary: construct instants from local date parts so the
  // test is timezone-independent. Beats flow through recordBeat, the only
  // writer of the per-day accumulator this helper now reads.
  const noon = new Date(2026, 6, 29, 12, 0).getTime()
  const earlyToday = new Date(2026, 6, 29, 0, 30).getTime()
  const lateYesterday = new Date(2026, 6, 28, 23, 59).getTime()
  const recordAll = (entries: readonly (readonly [number, number])[]): Heartbeat =>
    entries.reduce((hb, [at, tokens]) => recordBeat(hb, beat({ at, tokens })), heartbeat())

  it("sums ONLY today's beats (real sums, day boundary respected)", () => {
    const hb = recordAll([
      [lateYesterday, 999],
      [earlyToday, 40],
      [noon, 100],
    ])
    expect(beatsTodayTokens(hb, noon)).toEqual({ count: 2, tokens: 140 })
  })
  it('no beats today → zero count, zero tokens (a stale accumulator honestly reads zero)', () => {
    const hb = recordAll([[lateYesterday, 999]])
    expect(beatsTodayTokens(hb, noon)).toEqual({ count: 0, tokens: 0 })
  })
  it('survives the MAX_BEATS trim: 50 beats in one day → the day line shows 50 while the array holds 40', () => {
    const hb = recordAll(
      Array.from({ length: 50 }, (_, i) => [earlyToday + i * 60_000, 10] as const),
    )
    expect(hb.beats).toHaveLength(40) // the LOG stays capped
    expect(beatsTodayTokens(hb, noon)).toEqual({ count: 50, tokens: 500 }) // the day line does not under-report
  })
})

describe('managerDisplayName', () => {
  const companion = seedFromSetup(settingsWith(['local']), interview).managers.find(
    (m) => m.id === COMPANION_MANAGER_ID,
  )!
  it('companionName wins for the companion at render time', () => {
    expect(managerDisplayName(companion, { ...DEFAULT_SETTINGS, companionName: ' Astra ' })).toBe('Astra')
  })
  it('falls back to the seeded name when no companionName is set', () => {
    expect(managerDisplayName(companion, DEFAULT_SETTINGS)).toBe('Companion')
  })
  it('never renames a non-companion manager', () => {
    const local = { id: 'mgr-local', providerId: 'local', name: 'Local manager', enabled: false }
    expect(managerDisplayName(local, { ...DEFAULT_SETTINGS, companionName: 'Astra' })).toBe('Local manager')
  })
})

describe('heartbeat store actions', () => {
  it('ensureSeeded seeds the companion OFF; updateHeartbeat + recordManagerBeat round-trip', () => {
    ensureSeeded(settingsWith(['local']), interview)
    const seededHb = getManagers().managers.find((m) => m.id === COMPANION_MANAGER_ID)!.heartbeat!
    expect(seededHb.enabled).toBe(false) // OFF by default — consent required

    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true, everyMinutes: 15 })
    recordManagerBeat(COMPANION_MANAGER_ID, beat({ at: 5_000 }))
    const hb = getManagers().managers.find((m) => m.id === COMPANION_MANAGER_ID)!.heartbeat!
    expect(hb.enabled).toBe(true)
    expect(hb.everyMinutes).toBe(15)
    expect(hb.lastBeat).toBe(5_000)
    expect(hb.beats[0]).toEqual(beat({ at: 5_000 }))
  })
})

describe('updateHeartbeat guardrails (audit)', () => {
  const companionHb = () =>
    getManagers().managers.find((m) => m.id === COMPANION_MANAGER_ID)!.heartbeat!

  it('caps the charter at 2000 chars in the mutator', () => {
    ensureSeeded(settingsWith(['local']), interview)
    updateHeartbeat(COMPANION_MANAGER_ID, { charter: 'c'.repeat(5_000) })
    expect(companionHb().charter).toHaveLength(2_000)
  })

  it('clamps a non-finite or sub-5-minute cadence to the default (a real value passes)', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { everyMinutes: Infinity })
    expect(companionHb().everyMinutes).toBe(120) // Infinity would mean "never beat" while showing ON
    updateHeartbeat(COMPANION_MANAGER_ID, { everyMinutes: 0 })
    expect(companionHb().everyMinutes).toBe(120)
    updateHeartbeat(COMPANION_MANAGER_ID, { everyMinutes: 15 })
    expect(companionHb().everyMinutes).toBe(15)
  })

  it('the OFF→ON transition stamps lastBeat = now, so the first wake comes one cadence later — never instantly', () => {
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: false })
    const t0 = Date.now()
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true })
    const hb = companionHb()
    expect(hb.lastBeat).toBeGreaterThanOrEqual(t0)
    expect(beatDue(Date.now(), hb)).toBe(false) // NOT due at the click
  })

  it('a patch on an already-ON heartbeat never resets the cadence position', () => {
    const before = companionHb().lastBeat
    updateHeartbeat(COMPANION_MANAGER_ID, { enabled: true, charter: 'still on' })
    expect(companionHb().lastBeat).toBe(before)
  })
})

describe('heartbeat sanitize back-compat on load', () => {
  it('a pre-heartbeat store stays valid (no heartbeat conjured)', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat).toBeUndefined()
  })

  it('a MALFORMED heartbeat degrades to disabled with safe defaults', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [
          {
            id: 'mgr-companion',
            providerId: 'primary',
            name: 'Companion',
            enabled: false,
            heartbeat: { enabled: 'yes', everyMinutes: 'weekly', lastBeat: 'never', beats: 'nope' },
          },
        ],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat).toEqual({
      enabled: false, // 'yes' is not consent — degrade to OFF
      charter: '',
      everyMinutes: 120,
      lastBeat: 0,
      beats: [],
      today: { day: '', beats: 0, tokens: 0 }, // no beats → nothing to recompute
      // Garbage can only degrade toward the state that REQUIRES the visible
      // consent notice before anything runs — never toward a silent on.
      consent: 'undecided',
      autoOnAt: 0,
    })
  })

  it('a valid stored heartbeat round-trips unchanged (enabled kept)', async () => {
    const hb = heartbeat({ beats: [beat()] })
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-companion', providerId: 'primary', name: 'Companion', enabled: false, heartbeat: hb }],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat).toEqual(hb)
  })

  it('caps a stored over-long charter and clamps an Infinity cadence (JSON 1e999) to the default', async () => {
    // JSON.parse('1e999') → Infinity, the one way a stored cadence can be a
    // non-finite number — the isFinite guard must degrade it to the default,
    // never to a heartbeat that shows ON but is silently never due.
    localStorage.setItem(
      'scprism.managers',
      '{"managers":[{"id":"mgr-companion","providerId":"primary","name":"Companion","enabled":false,' +
        `"heartbeat":{"enabled":true,"charter":"${'c'.repeat(5_000)}","everyMinutes":1e999,"lastBeat":0,"beats":[]}}],` +
        '"jobs":[],"seeded":true}',
    )
    vi.resetModules()
    const fresh = await import('./managers')
    const hb = fresh.getManagers().managers[0].heartbeat!
    expect(hb.charter).toHaveLength(2_000)
    expect(hb.everyMinutes).toBe(120)
  })

  it('recomputes a missing/malformed per-day accumulator from the stored beats (pre-accumulator store)', async () => {
    const at = new Date(2026, 6, 29, 9, 0).getTime()
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [
          {
            id: 'mgr-companion',
            providerId: 'primary',
            name: 'Companion',
            enabled: false,
            // f417ce4-era heartbeat: no `today` field at all.
            heartbeat: {
              enabled: true,
              charter: 'watch',
              everyMinutes: 30,
              lastBeat: at,
              beats: [beat({ at: at + 60_000, tokens: 5 }), beat({ at, tokens: 10 })],
            },
          },
        ],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.today).toEqual({
      day: '2026-07-29',
      beats: 2,
      tokens: 15,
    })
  })

  it('keeps a well-formed stored accumulator AS-IS — it may honestly exceed the trimmed beats array', async () => {
    const hb = heartbeat({ today: { day: '2026-07-29', beats: 96, tokens: 12_345 } })
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-companion', providerId: 'primary', name: 'Companion', enabled: false, heartbeat: hb }],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.today).toEqual({
      day: '2026-07-29',
      beats: 96,
      tokens: 12_345,
    })
  })

  it('ensureSeeded back-fills the companion into an already-seeded old store', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [{ id: 'mgr-l', providerId: 'local', name: 'L', enabled: true }],
        jobs: [{ id: 'keep', managerId: 'mgr-l', title: 't', department: 'd', prompt: 'p', everyMinutes: 5, lastRun: 0, runs: [] }],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    fresh.ensureSeeded(settingsWith(['local']), interview)
    const s = fresh.getManagers()
    const c = s.managers.find((m) => m.id === fresh.COMPANION_MANAGER_ID)
    expect(c?.heartbeat?.enabled).toBe(false) // still OFF — back-fill grants nothing
    expect(s.managers.map((m) => m.id)).toContain('mgr-l') // existing state kept
    expect(s.jobs.map((j) => j.id)).toEqual(['keep'])
  })
})

// --- Always-on manager (2026-08-05 spec §Part 3) ---
//
// The heartbeat default-enables itself once setup completes. Two things make
// that honest rather than a silent token spend, and both are pinned here: the
// user's own decision is persisted separately from `enabled` (so a "decided
// off" survives every later launch), and the flip raises a notice obligation
// that only a real answer clears.

describe('shouldDefaultOn — the setup-completion flip', () => {
  it('fires for a user who has never decided, once setup is done', () => {
    expect(shouldDefaultOn(heartbeat({ enabled: false, consent: 'undecided', autoOnAt: 0 }), true)).toBe(true)
  })

  it('does NOT fire before setup is done', () => {
    expect(shouldDefaultOn(heartbeat({ enabled: false, consent: 'undecided', autoOnAt: 0 }), false)).toBe(false)
  })

  it('does NOT fire for a user who turned it OFF — that decision is sticky', () => {
    expect(shouldDefaultOn(heartbeat({ enabled: false, consent: 'off', autoOnAt: 0 }), true)).toBe(false)
  })

  it('does NOT fire for a user who already turned it ON himself', () => {
    expect(shouldDefaultOn(heartbeat({ enabled: true, consent: 'on', autoOnAt: 0 }), true)).toBe(false)
  })

  it('does NOT fire twice — a heartbeat already default-enabled once is done', () => {
    expect(shouldDefaultOn(heartbeat({ consent: 'undecided', autoOnAt: 1_700_000 }), true)).toBe(false)
  })

  it('no heartbeat at all → nothing to flip', () => {
    expect(shouldDefaultOn(undefined, true)).toBe(false)
  })
})

describe('heartbeatNoticeDue — the disclosure obligation', () => {
  it('is owed from the app flip until the user answers', () => {
    expect(heartbeatNoticeDue(heartbeat({ autoOnAt: 5, consent: 'undecided' }))).toBe(true)
  })

  it('clears once he answers — either way', () => {
    expect(heartbeatNoticeDue(heartbeat({ autoOnAt: 5, consent: 'on' }))).toBe(false)
    expect(heartbeatNoticeDue(heartbeat({ autoOnAt: 5, consent: 'off' }))).toBe(false)
  })

  it('is never owed for a heartbeat the user enabled himself (no app flip)', () => {
    expect(heartbeatNoticeDue(heartbeat({ autoOnAt: 0, consent: 'on' }))).toBe(false)
    expect(heartbeatNoticeDue(undefined)).toBe(false)
  })

  it('the consent copy states BOTH consent facts: what he does and that it costs real tokens', () => {
    const copy = heartbeatConsentCopy('Sukh', 30)
    expect(copy).toContain('every 30m')
    expect(copy).toContain('real tokens')
    expect(copy).toContain('ONE small piece of work')
  })
})

describe('wakeNowBlockReason — an honest disabled button', () => {
  const ok = { hb: heartbeat({ enabled: true }), primaryReal: true, waking: false, engineBusy: false }

  it('null when a wake really can run right now', () => {
    expect(wakeNowBlockReason(ok)).toBeNull()
  })

  it('names the OFF heartbeat', () => {
    expect(wakeNowBlockReason({ ...ok, hb: heartbeat({ enabled: false }) })).toBe(
      'heartbeat is off — turn it on first',
    )
  })

  it('names a missing provider', () => {
    expect(wakeNowBlockReason({ ...ok, primaryReal: false })).toMatch(/no AI connected/)
  })

  it('names a wake already running — not the vaguer "engine busy"', () => {
    expect(wakeNowBlockReason({ ...ok, waking: true, engineBusy: true })).toBe(
      'a wake is already running',
    )
  })

  it('names a busy engine', () => {
    expect(wakeNowBlockReason({ ...ok, engineBusy: true })).toBe(
      'the engine is busy with another run',
    )
  })

  it('a companion with no heartbeat at all says so', () => {
    expect(wakeNowBlockReason({ ...ok, hb: undefined })).toBe('no heartbeat on this companion')
  })
})

describe('the default-on store transition + the sticky OFF decision', () => {
  const seedStore = (hb: Record<string, unknown>) =>
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [
          { id: 'mgr-companion', providerId: 'primary', name: 'Companion', enabled: false, heartbeat: hb },
        ],
        jobs: [],
        seeded: true,
      }),
    )

  it('applySetupDefaultOn enables it, stamps lastBeat (no surprise instant wake) and raises the notice', async () => {
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    const fresh = await import('./managers')
    const now = 1_700_000_000_000
    expect(fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, now)).toBe(true)
    const hb = fresh.getManagers().managers[0].heartbeat!
    expect(hb.enabled).toBe(true)
    // lastBeat = now → the first check is one FULL cadence away, per the prior
    // audit's fix for the manual enable. Not due the instant setup finishes.
    expect(hb.lastBeat).toBe(now)
    expect(fresh.beatDue(now + 1000, hb)).toBe(false)
    expect(hb.autoOnAt).toBe(now)
    expect(hb.consent).toBe('undecided') // still owed — the notice is what settles it
    expect(fresh.heartbeatNoticeDue(hb)).toBe(true)
  })

  it('is a no-op the second time — the flip happens once in a lifetime', async () => {
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, 1_000)).toBe(true)
    expect(fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, 9_999)).toBe(false)
    expect(fresh.getManagers().managers[0].heartbeat!.lastBeat).toBe(1_000)
  })

  it('a user who turned it OFF stays off across a RELOAD — never silently re-enabled', async () => {
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    const first = await import('./managers')
    first.applySetupDefaultOn(first.COMPANION_MANAGER_ID, 1_000)
    // He answers the notice with "turn it off".
    first.answerHeartbeatNotice(first.COMPANION_MANAGER_ID, false)
    expect(first.getManagers().managers[0].heartbeat).toMatchObject({
      enabled: false,
      consent: 'off',
    })

    // RELOAD: fresh module registry, state rehydrated from the persisted copy.
    vi.resetModules()
    const reloaded = await import('./managers')
    const hb = reloaded.getManagers().managers[0].heartbeat!
    expect(hb.consent).toBe('off') // the decision survived
    expect(reloaded.applySetupDefaultOn(reloaded.COMPANION_MANAGER_ID, 2_000)).toBe(false)
    expect(reloaded.getManagers().managers[0].heartbeat!.enabled).toBe(false)
    expect(reloaded.heartbeatNoticeDue(hb)).toBe(false) // and it is not re-asked
  })

  it('"keep it on" records a real ON decision and clears the notice for good', async () => {
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    const fresh = await import('./managers')
    fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, 1_000)
    fresh.answerHeartbeatNotice(fresh.COMPANION_MANAGER_ID, true)
    const hb = fresh.getManagers().managers[0].heartbeat!
    expect(hb).toMatchObject({ enabled: true, consent: 'on' })
    expect(fresh.heartbeatNoticeDue(hb)).toBe(false)
  })

  it('an explicit user flip (the card switch / orb pause) records the decision both ways', async () => {
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    const fresh = await import('./managers')
    fresh.updateHeartbeat(fresh.COMPANION_MANAGER_ID, { enabled: true })
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('on')
    fresh.updateHeartbeat(fresh.COMPANION_MANAGER_ID, { enabled: false })
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('off')
    // ...and a non-enable patch leaves the decision alone.
    fresh.updateHeartbeat(fresh.COMPANION_MANAGER_ID, { everyMinutes: 60 })
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('off')
  })

  it('back-fills consent for pre-consent stores WITHOUT inventing a decision', async () => {
    // ON before the field existed → he turned it on himself (the only way).
    seedStore({ enabled: true, charter: 'c', everyMinutes: 30, lastBeat: 5, beats: [] })
    vi.resetModules()
    let fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('on')

    // OFF with beats → it ran, then he stopped it: a real OFF decision.
    seedStore({
      enabled: false,
      charter: 'c',
      everyMinutes: 30,
      lastBeat: 5,
      beats: [{ at: 5, action: 'rested', line: 'quiet', ok: true, tokens: 0 }],
    })
    vi.resetModules()
    fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('off')
    expect(fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, 9)).toBe(false)

    // OFF with no beats → never decided: eligible for the announced flip.
    seedStore({ enabled: false, charter: 'c', everyMinutes: 30, lastBeat: 0, beats: [] })
    vi.resetModules()
    fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.consent).toBe('undecided')
    expect(fresh.applySetupDefaultOn(fresh.COMPANION_MANAGER_ID, 9)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2026-08-15 §1 — don't work on a sleeping Mac
// ---------------------------------------------------------------------------

describe('the dark-wake skip', () => {
  it('skips ONLY on a proven dark wake — an unknown state always runs', () => {
    expect(shouldSkipWake('dark')).toBe(true)
    expect(shouldSkipWake('full')).toBe(false)
    // The whole degrade-safe rule: we could not tell, so we do the work.
    expect(shouldSkipWake('unknown')).toBe(false)
  })

  it('records an honest, free beat that says WHY the gap is there', () => {
    const b = darkWakeBeat(1_000, 'a maintenance (dark) wake — capabilities: CPU Network')
    expect(b).toMatchObject({ at: 1_000, action: 'rested', ok: true, tokens: 0 })
    expect(b.line).toContain(DARK_WAKE_SKIP_LINE)
    expect(b.line).toContain('CPU Network') // the machine's own words, not ours
    // With nothing to quote it still says the honest sentence, not a blank.
    expect(darkWakeBeat(2_000).line).toBe(DARK_WAKE_SKIP_LINE)
  })
})

// ---------------------------------------------------------------------------
// 2026-08-15 §2 — cadence in hours
// ---------------------------------------------------------------------------

describe('cadence in hours', () => {
  it('a NEW companion is seeded at the 2h default', () => {
    expect(DEFAULT_CADENCE_MIN).toBe(120)
    const s = seedFromSetup(settingsWith(['local']), interview)
    expect(s.managers.find((m) => m.id === COMPANION_MANAGER_ID)!.heartbeat!.everyMinutes).toBe(120)
  })

  it('an EXISTING install keeps the cadence it already chose — the new default never overrules it', async () => {
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [
          {
            id: 'mgr-companion',
            providerId: 'primary',
            name: 'Companion',
            enabled: true,
            heartbeat: { enabled: true, charter: 'mine', everyMinutes: 15, lastBeat: 5, beats: [] },
          },
        ],
        jobs: [],
        seeded: true,
      }),
    )
    vi.resetModules()
    const fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.everyMinutes).toBe(15)
    localStorage.clear()
  })

  it('says the cadence in hours once it is one', () => {
    expect(cadenceLabel(120)).toBe('every 2h')
    expect(cadenceLabel(1440)).toBe('every 1d')
    expect(heartbeatConsentCopy('Sukh', 120)).toContain('every 2h')
  })
})

// ---------------------------------------------------------------------------
// 2026-08-15 §3 — the charter is a priority ladder
// ---------------------------------------------------------------------------

describe('the charter migration', () => {
  const seedCharter = (charter: string) =>
    localStorage.setItem(
      'scprism.managers',
      JSON.stringify({
        managers: [
          {
            id: 'mgr-companion',
            providerId: 'primary',
            name: 'Companion',
            enabled: false,
            heartbeat: { enabled: false, charter, everyMinutes: 30, lastBeat: 0, beats: [] },
          },
        ],
        jobs: [],
        seeded: true,
      }),
    )

  it('the new starter charter IS the ladder, in order, with the rest protocol intact', () => {
    expect(STARTER_CHARTER).toContain('1. Waiting on the user')
    expect(STARTER_CHARTER).toContain('2. Vault upkeep')
    expect(STARTER_CHARTER).toContain('3. Project prep')
    expect(STARTER_CHARTER).toContain('4. Business work')
    // The concrete upkeep list his own vault-health report produced.
    for (const item of ['index verdicts', 'triage log.md', 'archive stale reports', 'flag broken links']) {
      expect(STARTER_CHARTER).toContain(item)
    }
    // The rest protocol is UNCHANGED — the exact token parseWakeReply reads.
    expect(STARTER_CHARTER).toContain('NOTHING_NEEDED')
    expect(parseWakeReply('NOTHING_NEEDED — everything is quiet')).toEqual({
      action: 'rested',
      line: 'everything is quiet',
    })
  })

  it('migrates an UNTOUCHED old charter to the ladder', () => {
    expect(migrateCharter(OLD_STARTER_CHARTER)).toBe(STARTER_CHARTER)
    // Surrounding whitespace is still the same untouched default.
    expect(migrateCharter(`\n${OLD_STARTER_CHARTER}  `)).toBe(STARTER_CHARTER)
  })

  it('NEVER overwrites a charter the user edited — one changed word is enough', () => {
    const edited = OLD_STARTER_CHARTER.replace('companion', 'assistant')
    expect(migrateCharter(edited)).toBe(edited)
    expect(migrateCharter('watch the vault and tell me about invoices')).toBe(
      'watch the vault and tell me about invoices',
    )
    expect(migrateCharter('')).toBe('')
  })

  it('an existing install LOADS migrated (old default) or untouched (edited)', async () => {
    seedCharter(OLD_STARTER_CHARTER)
    vi.resetModules()
    let fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.charter).toBe(fresh.STARTER_CHARTER)

    seedCharter('my own words about my own business')
    vi.resetModules()
    fresh = await import('./managers')
    expect(fresh.getManagers().managers[0].heartbeat!.charter).toBe(
      'my own words about my own business',
    )
    localStorage.clear()
  })
})

describe('the priority ladder', () => {
  const state = (over: Partial<LadderState> = {}): LadderState => ({
    needsYou: 0,
    vaultNotes: 0,
    projects: 0,
    businessContext: false,
    ...over,
  })

  it('picks the HIGHEST rung that has anything at all', () => {
    // Everything available → rung 1 wins.
    expect(
      topRung(state({ needsYou: 2, vaultNotes: 40, projects: 3, businessContext: true })),
    ).toBe('needs-you')
    expect(topRung(state({ vaultNotes: 40, projects: 3, businessContext: true }))).toBe('vault')
    expect(topRung(state({ projects: 3, businessContext: true }))).toBe('projects')
    expect(topRung(state({ businessContext: true }))).toBe('business')
  })

  it('RESTS when no rung has anything — resting is an outcome, not a failure', () => {
    expect(topRung(state())).toBe('rest')
  })

  it('the brief names every EMPTY rung, so nothing is written about state that does not exist', () => {
    const brief = ladderBrief(state())
    expect(brief).toContain('nothing is waiting on you right now')
    expect(brief).toContain('no notes yet')
    expect(brief).toContain('none yet')
    expect(brief).toContain('NONE recorded')
    expect(brief).toContain('The highest rung with anything to look at is rest')
    // …and reports real counts when there are some.
    expect(ladderBrief(state({ needsYou: 1, vaultNotes: 12, projects: 2 }))).toContain('1 item')
    expect(ladderBrief(state({ needsYou: 1, vaultNotes: 12, projects: 2 }))).toContain('12 notes')
  })
})

// THE LINE SUKHDEEP ACTUALLY SEES. The beat line is what shows in the orb
// popover and the beat log — one line standing for the whole wake. It used to
// be "the first line of the reply", which is only the summary when the model
// answers straight away. The first wake that ever completed its research opened
// with "Let me think about the ladder:", and that became the report.
describe('the beat line is the summary, not the scratchpad heading', () => {
  it('reads the SUMMARY marker the charter asks for, past the thinking', () => {
    const reply = [
      'Let me think about the ladder:',
      '',
      '1. Waiting on the user — 0 items. Nothing.',
      '2. Vault upkeep — the health job has not reported since 08-14.',
      '',
      'SUMMARY: the vault-health job has been dead 11 days — 5 straight no-reply failures',
      '',
      'Detail: routes=local on every failure, so the local provider is the suspect.',
    ].join('\n')
    expect(parseWakeReply(reply)).toEqual({
      action: 'worked',
      line: 'the vault-health job has been dead 11 days — 5 straight no-reply failures',
    })
  })

  it('strips the markdown a model dresses the marker in', () => {
    expect(parseWakeReply('**SUMMARY:** *indexed two verdicts*').line).toBe('indexed two verdicts')
    expect(parseWakeReply('- SUMMARY — tidied the log').line).toBe('tidied the log')
  })

  it('a plain answer is NOT punished for skipping the keyword', () => {
    expect(parseWakeReply('Indexed two verdicts and archived one stale report.')).toEqual({
      action: 'worked',
      line: 'Indexed two verdicts and archived one stale report.',
    })
  })

  it('NOTHING_NEEDED still wins — resting is a real outcome, not a summary', () => {
    expect(parseWakeReply('NOTHING_NEEDED — 0 items waiting')).toEqual({
      action: 'rested',
      line: '0 items waiting',
    })
  })

  it('stops hunting rather than picking a line out of the middle of an essay', () => {
    const buried = [...Array(60).fill('thinking...'), 'SUMMARY: too late to count'].join('\n')
    expect(parseWakeReply(buried).line).toBe('thinking...')
  })

  it('an empty marker falls through instead of recording a blank beat', () => {
    expect(parseWakeReply('SUMMARY:   \nreal first line').line).toBe('SUMMARY:')
  })
})
