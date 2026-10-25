import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Skills from './Skills'
import { create as createSkill } from '../lib/skills'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import type { Verdict } from '../engine/types'

/**
 * The skill stats LABEL says exactly what it counts (owed follow-up #2).
 *
 * "12 uses · 58% pass" could not tell you what the 58% was of, and once a third
 * outcome exists that is a lie by omission. An ATTENTION run — the
 * deterministic checks ran over real written files and PASSED, only the LLM
 * reviewer dissented — is held OUT of the rate's denominator and stated on its
 * own, and the rate names the denominator it does use.
 */

function verdict(over: Partial<Verdict>): Verdict {
  return {
    taskId: 't-1',
    task: 'do the thing',
    route: {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via gateway',
      reason: 'routine',
      routeLabel: 'local · qwen2.5-coder',
    },
    tier1: { tests: '11/11', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.5, passed: false, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.01,
    durationMs: 1000,
    modelRoute: '100 tok in / 50 out',
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'verdicts/t-1.json', validated: false, committed: false },
    passed: false,
    native: {
      hooksFired: [],
      hookDecisions: [],
      blocks: 0,
      approvals: 0,
      memoryInjected: 0,
      disclosed: ['zappy-scan'],
      rejectedWrites: 0,
      cacheHits: 0,
      cacheMisses: 0,
      spansPath: '',
    },
    at: '2026-08-14T00:00:00.000Z',
    ...over,
  } as Verdict
}

function seed(verdicts: Verdict[]) {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: {},
      verdicts,
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
    }),
  )
}

function renderSkills() {
  return render(
    <MemoryRouter initialEntries={['/skills']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Skills />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** Open the skill's drawer, where the stats line renders. The card title and
 * the drawer heading share the text, so click the first (the card). */
function openDrawer(name: string) {
  fireEvent.click(screen.getAllByText(name)[0])
}

describe('Skills — the stats line names its denominator and the held-out count', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('states the rate OF the decided runs and the attention runs separately', () => {
    seed([
      verdict({ taskId: 't-3', passed: false, outcome: 'attention' }),
      verdict({ taskId: 't-2', passed: false, outcome: 'failed' }),
      verdict({ taskId: 't-1', passed: true, outcome: 'passed' }),
    ])
    createSkill({ name: 'zappy-scan', description: 'd', whenToUse: 'w', provenance: 'hand-written' })
    renderSkills()
    openDrawer('zappy-scan')

    expect(document.body.textContent).toContain('3 uses · 50% pass of 2 decided · 1 needed a look (not counted)')
    // The old, denominator-free claim is gone.
    expect(document.body.textContent).not.toMatch(/3 uses · 33% pass/)
  })

  it('an all-attention skill says it has no decided runs rather than "0% pass"', () => {
    seed([
      verdict({ taskId: 't-2', passed: false, outcome: 'attention' }),
      verdict({ taskId: 't-1', passed: false, outcome: 'attention' }),
    ])
    createSkill({ name: 'zappy-scan', description: 'd', whenToUse: 'w', provenance: 'hand-written' })
    renderSkills()
    openDrawer('zappy-scan')

    expect(document.body.textContent).toContain('2 uses · no decided runs · 2 needed a look (not counted)')
    expect(document.body.textContent).not.toContain('0% pass')
  })

  it('marks the attention run in the recent list instead of listing it as a plain failure', () => {
    seed([verdict({ taskId: 't-1', task: 'build the todo CLI', passed: false, outcome: 'attention' })])
    createSkill({ name: 'zappy-scan', description: 'd', whenToUse: 'w', provenance: 'hand-written' })
    const { container } = renderSkills()
    openDrawer('zappy-scan')

    expect(container.querySelector('.sk-dot--attention')).not.toBeNull()
    expect(container.querySelector('.sk-dot--err')).toBeNull()
    expect(document.body.textContent).toContain('needed a look')
  })

  it('a history with no recorded outcomes reads exactly as it did before', () => {
    seed([
      verdict({ taskId: 't-2', passed: false }),
      verdict({ taskId: 't-1', passed: true }),
    ])
    createSkill({ name: 'zappy-scan', description: 'd', whenToUse: 'w', provenance: 'hand-written' })
    const { container } = renderSkills()
    openDrawer('zappy-scan')

    expect(document.body.textContent).toContain('2 uses · 50% pass of 2 decided')
    expect(document.body.textContent).not.toContain('needed a look')
    expect(container.querySelector('.sk-dot--attention')).toBeNull()
  })
})
