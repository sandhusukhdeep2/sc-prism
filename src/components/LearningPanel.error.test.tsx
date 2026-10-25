import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'

// P8 (honesty): a thrown learning/adopt step must READ as a failure, not hang on
// the default "Checks whether…" prompt. runNativeLearn swallows invoke errors and
// returns null, so to exercise the THROW path (a bridge/vault-path failure that
// escapes) we partial-mock nativeEngine and make runNativeLearn reject, keeping
// the real formatters so the surfaced copy is the production string.
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readTrainingCount: async () => 42,
    readAdoptedRouter: async () => null,
    runNativeLearn: async () => {
      throw new Error('bridge exploded')
    },
  }
})

import LearningPanel from './LearningPanel'

function renderPanel() {
  return render(
    <SettingsProvider>
      <LearningPanel />
    </SettingsProvider>,
  )
}

describe('LearningPanel — a thrown learning step reads as a failure (P8)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('surfaces the honest "Couldn\'t run…" message instead of hanging when runNativeLearn throws', async () => {
    renderPanel()

    const btn = await screen.findByRole('button', { name: /run learning step/i })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    // Without the try/catch, learnRan stays false and the result line reverts to
    // the default prompt — this assertion fails on revert.
    expect(await screen.findByText(/couldn't run the learning step — try again/i)).toBeInTheDocument()
    // The button is usable again (not stuck on "Running…").
    await waitFor(() => expect(screen.getByRole('button', { name: /run learning step/i })).not.toBeDisabled())
  })
})
