// Shared money formatter — one source of truth so cost figures read identically
// across surfaces (Stats, Console, …). Whole dollars show no cents; sub-dollar
// amounts show two decimals (so a $0.02 marginal cost stays legible).
export const fmtMoney = (n: number): string => (n >= 1 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)
