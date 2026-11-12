// THE CHAT FOLDS A RUN'S OWN TURNS (2026-11-12).
//
// The owner's reference — the coworker app he uses daily — shows a run's
// activity as one line that opens into its steps, with the answer standing on
// its own under it. A team run here posted every seat's board turn as a full
// bubble, so the answer sat under a screen of working-out.
//
// This is a VIEW fold, exactly like `collapseRepeats`: the stored thread keeps
// every turn, untouched; what renders is one line per run of turns that opens
// in place. Nothing is summarised by a model and nothing is dropped.
import type { ChatMessage } from '../store/AppStore'

export type SeatTurn = Extract<ChatMessage, { kind: 'seat' }>

/** A run of consecutive seat turns, standing in the transcript as one item. */
export interface SeatFold {
  /** Stable for a given run of turns: the first turn's id. */
  id: string
  kind: 'seats'
  seats: SeatTurn[]
}

export type FoldedMessage<M extends ChatMessage = ChatMessage> = M | SeatFold

/**
 * Fold each run of two or more consecutive seat turns into one `seats` item.
 * One seat's single turn is not a crowd and stays a bubble. Order is kept.
 */
export function foldSeatTurns<M extends ChatMessage>(messages: readonly M[]): FoldedMessage<M>[] {
  const out: FoldedMessage<M>[] = []
  let run: SeatTurn[] = []
  const flush = () => {
    if (run.length >= 2) out.push({ id: `fold-${run[0].id}`, kind: 'seats', seats: run })
    else for (const turn of run) out.push(turn as unknown as M)
    run = []
  }
  for (const m of messages) {
    if (m.kind === 'seat') {
      run.push(m as unknown as SeatTurn)
      continue
    }
    flush()
    out.push(m)
  }
  flush()
  return out
}

/** The one line that stands for a fold: how many turns, from which seats. */
export function seatFoldSummary(seats: readonly SeatTurn[]): { line: string; names: string[] } {
  const names: string[] = []
  for (const s of seats) if (!names.includes(s.agent)) names.push(s.agent)
  const turns = `${seats.length} turn${seats.length === 1 ? '' : 's'}`
  const from = `${names.length} seat${names.length === 1 ? '' : 's'}`
  return { line: `${turns} from ${from}`, names }
}
