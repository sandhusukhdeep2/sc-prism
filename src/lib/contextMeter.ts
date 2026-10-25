// SC Prism — pure per-thread context-size estimate + level/threshold model.
//
// Phase 2 (compaction) needs to know, cheaply and without any I/O, roughly
// how "full" a chat thread is so the Workspace can show a meter and later
// tasks can decide when to offer/force a compaction pass. This module owns
// exactly that: a rough token estimate (~4 chars/token, the standard rule of
// thumb — no tokenizer dependency) and the level/threshold math. No engine,
// no store, no UI — just numbers in, numbers out.

import type { ChatMessage } from '../store/AppStore'
import { verdictLabel } from './compaction'

/** Default per-thread token budget. Tunable — later tasks may override per call. */
export const THREAD_CONTEXT_BUDGET = 24_000

/** Rough, standard estimate: ~4 chars per token. '' -> 0. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * The text that counts toward a thread's size, per `ChatMessage` variant.
 * Exhaustive over the union (the `never` default below fails to compile if a
 * new variant is added without updating this function).
 */
export function messageText(m: ChatMessage): string {
  switch (m.kind) {
    case 'user':
    case 'assistant':
    case 'divider':
    case 'error':
    case 'notice':
      return m.text
    case 'seat':
      return `${m.agent}: ${m.text}`
    case 'verdict':
      // Same three-valued label compaction actually writes (ATTENTION included),
      // so the size estimate measures the line the summariser really emits.
      return `verdict ${m.verdict.taskId} ${verdictLabel(m.verdict)}`
    default: {
      const _exhaustive: never = m
      return _exhaustive
    }
  }
}

/** Sum of `estimateTokens(messageText(m))` across a thread's messages. */
export function threadTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0)
}

export type MeterLevel = 'green' | 'amber' | 'red'

export interface Meter {
  tokens: number
  budget: number
  pct: number // round(tokens/budget*100), clamped 0..100
  level: MeterLevel // pct < 60 green; 60..85 amber; > 85 red
  remaining: number // max(0, budget - tokens)
  offerCompact: boolean // pct >= 60
  autoCompact: boolean // pct >= 75
  hardCompact: boolean // pct >= 90
}

/** Maps a thread's estimated size to a meter (level + thresholds). */
export function meterFor(messages: ChatMessage[], budget: number = THREAD_CONTEXT_BUDGET): Meter {
  const tokens = threadTokens(messages)
  const rawPct = Math.round((tokens / budget) * 100)
  const pct = Math.min(100, Math.max(0, rawPct))
  const level: MeterLevel = pct < 60 ? 'green' : pct <= 85 ? 'amber' : 'red'
  return {
    tokens,
    budget,
    pct,
    level,
    remaining: Math.max(0, budget - tokens),
    offerCompact: pct >= 60,
    autoCompact: pct >= 75,
    hardCompact: pct >= 90,
  }
}
