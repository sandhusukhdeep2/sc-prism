// ChatRunStream — the project-room centerpiece (spec 2026-08-29, Sukhdeep:
// "I need it in a chat, like a cloud coworker — which file you are accessing,
// which agent of which AI is working on it, and what they are doing").
//
// While a run is live in the active room, this block sits INSIDE the chat
// scroll and carries the seat-attributed action stream: every row a real
// engine span rendered by the SAME RunStream the stage uses — one renderer,
// nothing invented, no second implementation to drift. When the run ends the
// block disappears and the verdict card (with its measured facts) is the
// durable record in the thread. Empty spans render nothing: never a shell.
import { useEffect, useState } from 'react'
import RunStream from './RunStream'
import { revealVaultNote, type EngineSpan } from '../lib/nativeEngine'
import { useSettings } from '../lib/settings'
import './ChatRunStream.css'

export default function ChatRunStream({ spans }: { spans: EngineSpan[] }) {
  const { settings } = useSettings()
  // RunStream takes an injected clock so a live span's elapsed time is
  // testable; here the real clock ticks once a second while the block lives.
  const [now, setNow] = useState(0)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (spans.length === 0) return null
  return (
    <div className="msg msg--activity" data-testid="chat-run-stream">
      <div className="chatstream__head mono">
        the crew, live — every line a real recorded action
      </div>
      <RunStream
        spans={spans}
        now={now || Date.now()}
        onRevealNote={(rel) => void revealVaultNote(settings.vaultPath, rel)}
      />
    </div>
  )
}
