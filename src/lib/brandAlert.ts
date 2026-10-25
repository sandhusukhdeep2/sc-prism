// SC Prism — telling the user which AI passed its alert.
//
// Sukhdeep: "if it's hit the limit, it's supposed to let user know you hit the
// limit of this AI … so user can change the limit or refresh the limit … but
// user know this thing happening."
//
// The rule this follows: we had just finished removing an INVISIBLE limit that
// silently broke runs — a team spent 110,873 tokens against a 100,000 default,
// lost an agent and returned an empty answer, with nothing on screen to
// explain it. Adding a layer of invisible PER-AI limits on top of that would be
// going backwards. So an alert names the AI, says what we counted, says plainly
// that nothing was blocked, and offers something to do about it.
//
// And it must not nag. A notice that returns on every render is one the user
// learns to scroll past, which costs you the one time it mattered.

import { brandBudgetStatus, type Brand } from './providerBudget'

export interface BrandSpend {
  brand: Brand
  label: string
  spent: number
  budget: number
  /** Our count is a floor, not a measurement — a subscription CLI reports no usage. */
  estimated: boolean
}

export interface AlertAction {
  id: 'raise' | 'reset' | 'dismiss'
  label: string
}

export interface BrandAlert {
  brand: Brand
  title: string
  body: string
  /** The alert level that fired, so acknowledging it is specific to that level. */
  level: number
  actions: AlertAction[]
}

export function brandAlerts(
  spends: readonly BrandSpend[],
  opts: { acknowledged?: Record<string, number> } = {},
): BrandAlert[] {
  const ack = opts.acknowledged ?? {}
  const out: BrandAlert[] = []

  for (const s of spends) {
    if (!s.budget || s.budget <= 0) continue
    const st = brandBudgetStatus({
      brand: s.brand,
      spent: s.spent,
      budget: s.budget,
      estimated: s.estimated,
    })
    if (st.level !== 'reached') continue
    // Acknowledged AT THIS LEVEL. Raising the alert and passing the new one is
    // a new fact and fires again; re-rendering the same one is not.
    if (ack[s.brand] === s.budget) continue

    const counted = `${s.spent.toLocaleString()} tokens`
    out.push({
      brand: s.brand,
      level: s.budget,
      title: `${s.label} passed your token alert`,
      body:
        `We have counted ${s.estimated ? 'at least ' : ''}${counted} on ${s.label}, ` +
        `against the ${s.budget.toLocaleString()} alert you set. ` +
        `Nothing was blocked and no run was stopped — this is your own alert, ` +
        `counting our own spend. ` +
        (s.estimated
          ? `${s.label} runs through a subscription CLI, which reports no usage, ` +
            `so the real figure is higher by an unknown amount. `
          : '') +
        `We cannot see your provider's actual balance.`,
      actions: [
        { id: 'raise', label: 'Raise the alert' },
        { id: 'reset', label: 'Reset the count' },
        { id: 'dismiss', label: 'Keep going' },
      ],
    })
  }

  // Most over first: if two fired, the one further past its alert is the one
  // worth reading first.
  out.sort((a, b) => {
    const sa = spends.find((x) => x.brand === a.brand)!
    const sb = spends.find((x) => x.brand === b.brand)!
    return sb.spent / sb.budget - sa.spent / sa.budget
  })
  return out
}
