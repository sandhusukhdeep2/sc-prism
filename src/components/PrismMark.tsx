// The SC Prism mark: one instruction enters, the prism splits it into a crew.
//
// The three exit rays are the app's three provider colours — cloud blue, the
// second cloud coral, on-device green — the same hues an agent's model wears
// everywhere else in the product, so the logo states what the app does rather
// than decorating it. The entering beam and the prism take `currentColor`, so
// the mark inverts correctly on a dark topbar without a second asset.
//
// It replaces a gold-stroked box glyph that pointed at `--gold`, a token the
// v2 visual system retired.
export default function PrismMark({
  size = 20,
  title,
}: {
  size?: number
  /** Give it an accessible name only where it is the sole brand statement. */
  title?: string
}) {
  return (
    <svg
      width={(size * 30) / 24}
      height={size}
      viewBox="0 0 30 24"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: 'block', color: 'inherit' }}
    >
      <g fill="none" strokeWidth="2.15" strokeLinecap="round">
        <path d="M1.5 12H7.1" stroke="currentColor" />
        <path d="M18.1 10.6 27.6 6.3" stroke="var(--v2-blue)" />
        <path d="M18.6 12H28" stroke="var(--v2-coral)" />
        <path d="M18.1 13.4 27.6 17.7" stroke="var(--v2-local)" />
      </g>
      <path
        d="M12.7 3.6 18.4 12 12.7 20.4 9.2 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
