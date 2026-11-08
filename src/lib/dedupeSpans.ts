// One copy of each span. A project's board unions the finished steps' spans
// with the live step's, and while a build runs those two sources overlap
// (`currentRunSpans` spans the whole LiveRun, which is the whole build), so a
// seat's "N tokens" doubled mid-build and halved when the build ended. Spans
// carry `span_id` exactly as telemetry.py writes it; a line without one (older)
// is kept as is — never synthesized, never dropped.
import type { EngineSpan } from './nativeEngine'

export function dedupeSpans(spans: readonly EngineSpan[]): EngineSpan[] {
  const seen = new Set<string>()
  const out: EngineSpan[] = []
  for (const s of spans) {
    const id = s.span_id
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(s)
  }
  return out
}
