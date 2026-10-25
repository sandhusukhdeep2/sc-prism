// seatMessagesFromBoard — "multiple AIs in the same chat" (standing loop,
// 2026-08-29). After a team run, each seat's contribution becomes its own
// bubble in the room. The ONLY source is the persisted board JSONL — the
// audited agent-to-agent record the engine wrote (team.py, one line per
// message + a trailing synthesis line). Only REAL contributions qualify
// (is_real true — a stub never gets a bubble); the synthesis line is skipped
// (it lands as the assistant bubble through the existing path); a corrupt
// line is skipped, never fatal.

export interface SeatMessage {
  agent: string
  provider: string
  model: string
  text: string
  /** The board turn this contribution spoke in (engine's own `round`). */
  round: number
}

export function seatMessagesFromBoard(jsonl: string): SeatMessage[] {
  const out: SeatMessage[] = []
  for (const line of (jsonl ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof d.from !== 'string' || typeof d.content !== 'string') continue // synthesis / foreign lines
    if (d.is_real !== true) continue
    const text = d.content.trim()
    if (!text) continue
    out.push({
      agent: d.from,
      provider: typeof d.provider === 'string' ? d.provider : '',
      model: typeof d.model === 'string' ? d.model : '',
      text,
      round: typeof d.round === 'number' ? d.round : 0,
    })
  }
  return out
}
