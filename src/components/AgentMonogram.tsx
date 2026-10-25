// An agent's face, and it MEANS something.
//
// Agents used to wear a spectral 3D orb picked by hashing their name — pretty,
// and completely uninformative: two agents on different models looked alike,
// and an agent whose provider was switched off looked exactly as alive as one
// that could answer. The face now carries the two facts you need at a glance,
// the same way the reference design does:
//
//   · its COLOUR is the model the agent runs on (the same hue that model wears
//     in the thread, the crew board and the run stream);
//   · an agent that CANNOT run wears the idle grey instead, so a dead seat is
//     visible before you rely on it.
import { modelColor } from '../lib/modelColor'
import './AgentMonogram.css'

/** The initials shown on the disc: one letter, or two for a two-word name. */
export function monogram(name: string): string {
  const words = name.trim().split(/[\s/_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

export default function AgentMonogram({
  name,
  model,
  sitsOut = '',
  size = 38,
}: {
  name: string
  /** The agent's model token — 'local', 'claude', 'gemini', … */
  model: string
  /** Non-empty when this agent cannot take a seat; it then reads as idle. */
  sitsOut?: string
  size?: number
}) {
  const idle = Boolean(sitsOut)
  return (
    <span
      className={'amono' + (idle ? ' amono--idle' : '')}
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        fontSize: Math.round(size * 0.36),
        background: idle ? 'var(--v2-idle)' : modelColor(model),
      }}
      title={idle ? `${name} — ${sitsOut}` : `${name} · ${model}`}
      aria-hidden
    >
      {monogram(name)}
    </span>
  )
}
