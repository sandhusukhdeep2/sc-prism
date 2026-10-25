// Shared onboarding stepper. Extracted from the inline `SetupStepper` that was
// duplicated byte-for-byte across the setup pages (GitHub, Vault, Interview,
// Governance). Renders the same `.step` markup those pages' CSS already styles.

// GitHub sync is OPTIONAL and lives in Settings — it is not a setup step.
export const SETUP_STEPS = ['Providers', 'Companion', 'Vault', 'Grants', 'Interview', 'Review'] as const

export default function Stepper({
  active,
  steps = SETUP_STEPS,
}: {
  active: number
  steps?: readonly string[]
}) {
  return (
    <div className="step">
      {steps.map((label, i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'todo'
        return (
          <span key={label} className="step__group">
            <span className={`step__item step__item--${state}`}>
              <span className={`step__dot step__dot--${state}`}>{state === 'done' ? '✓' : ''}</span>
              {label}
            </span>
            {i < steps.length - 1 && <span className="step__sep">&middot;</span>}
          </span>
        )
      })}
    </div>
  )
}
