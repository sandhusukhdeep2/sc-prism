// SC Prism — onboarding progress (persisted under `scprism.onboarding`).
// Tracks which steps the user has completed and whether the whole flow is done.
// Written as a .ts module (no JSX) so it uses createElement directly.

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { isNative, storeGet, storeSet } from './nativeEngine'

// GitHub sync is optional (Settings → GitHub) — deliberately NOT a step here.
export const ONBOARDING_STEPS = [
  'welcome',
  'providers',
  'companion',
  'vault',
  'grants',
  'interview',
  'review',
] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

// Where the primary CTA of each step should navigate next.
const NEXT_ROUTE: Record<OnboardingStep, string> = {
  welcome: '/providers',
  providers: '/companion-wakes',
  companion: '/vault-setup',
  vault: '/companion-grants',
  grants: '/interview',
  interview: '/governance-review',
  review: '/',
}

const STORAGE_KEY = 'scprism.onboarding'

interface OnboardingState {
  completedSteps: OnboardingStep[]
  done: boolean
}

const EMPTY: OnboardingState = { completedSteps: [], done: false }

function normalizeState(parsed: Partial<OnboardingState> | null | undefined): OnboardingState {
  if (!parsed) return EMPTY
  const steps = Array.isArray(parsed.completedSteps)
    ? parsed.completedSteps.filter((s): s is OnboardingStep =>
        (ONBOARDING_STEPS as readonly string[]).includes(s),
      )
    : []
  return { completedSteps: steps, done: Boolean(parsed.done) }
}

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalizeState(raw ? (JSON.parse(raw) as Partial<OnboardingState>) : undefined)
  } catch {
    return EMPTY
  }
}

export interface OnboardingContextValue {
  completedSteps: OnboardingStep[]
  done: boolean
  completeStep: (step: OnboardingStep) => void
  nextRoute: (step: OnboardingStep) => string
  finish: () => void
  /** Leave the wizard WITHOUT marking setup complete. */
  pause: () => void
  reset: () => void
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null)

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OnboardingState>(loadState)
  const [hydrated, setHydrated] = useState(!isNative())

  // Disk copy wins on startup — localStorage can lose the last writes on a
  // force-quit (see settings.ts for the full story).
  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    void storeGet('onboarding').then((raw) => {
      if (cancelled) return
      if (raw) {
        try {
          setState(normalizeState(JSON.parse(raw) as Partial<OnboardingState>))
        } catch {
          // corrupt disk copy: keep localStorage state
        }
      }
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // non-fatal
    }
    if (hydrated) void storeSet('onboarding', JSON.stringify(state))
  }, [state, hydrated])

  const value = useMemo<OnboardingContextValue>(
    () => ({
      completedSteps: state.completedSteps,
      done: state.done,
      completeStep: (step) =>
        setState((s) =>
          s.completedSteps.includes(step)
            ? s
            : { ...s, completedSteps: [...s.completedSteps, step] },
        ),
      nextRoute: (step) => NEXT_ROUTE[step],
      // Close means close. Every wizard page's ✕ used to call finish(),
      // which marked setup DONE for someone who had connected nothing and
      // completed no step (pre-launch audit, 2026-09-03).
      pause: () => setState((s) => ({ ...s })),
      finish: () =>
        setState((s) => ({
          done: true,
          completedSteps: s.completedSteps.includes('review')
            ? s.completedSteps
            : [...s.completedSteps, 'review'],
        })),
      reset: () => setState(EMPTY),
    }),
    [state],
  )

  return createElement(OnboardingContext.Provider, { value }, children)
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext)
  if (!ctx) throw new Error('useOnboarding must be used within <OnboardingProvider>')
  return ctx
}
