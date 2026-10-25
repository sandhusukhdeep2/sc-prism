# Telegram two-way — approve from your phone (2026-08-11)

Sukhdeep chose "reports only" for v1 (2026-07-29). Now the pieces that make
two-way worth it exist: mid-run BLOCKING approval (the run pauses and waits),
ask-first tools, and an always-on heartbeat that can hit a hold at 3am while
he is nowhere near the Mac. Today that pause can only end at the desk or by
timing out unapproved.

## Scope

Inbound decisions ONLY — Approve / Deny on things already parked:
blocking-approval holds, and manager dispatch jobs awaiting an OK. NOT chat,
NOT task-giving (that stays in the app, where the live view is).

## How it works

- Outbound (existing): the notifier already sends outcome-only lines. A
  request message gains inline buttons carrying an opaque request id.
- Inbound: poll `getUpdates` with an offset (long-poll, native side, same
  custody as the token — it never touches the webview). A callback answers
  ONLY if: the chat id matches the configured one, the request id is still
  genuinely pending, and the request has not already been decided. Anything
  else gets an honest reply ("that request already timed out").
- A decision writes the SAME artifact a desk click writes (the approvals
  pending/decision file the engine's broker reads) — one decision path, no
  parallel logic that could drift.
- The desk shows the decision arrived from Telegram, with who/when, so the
  app never silently disagrees with the phone.

## Security (binding)

The bot token stays native-side. Only the configured chat id can decide —
a message from any other chat is ignored and logged honestly. Request ids are
unguessable and single-use. Polling stops when reports are off. No message
content beyond the outcome-only lines already agreed goes out; a request
message names the tool/job, never model output or vault content.

## Honesty rules (binding)

The phone can only decide what is REALLY pending. A decision made after a
timeout says so rather than pretending it worked. The app and the phone show
the same state; the desk records the source of every decision.

## Tests

Wrong chat id ignored; unknown/expired request id gets the honest reply;
double-tap decides once; a phone decision produces the identical artifact a
desk click produces; polling only runs while reports are on; token never
crosses into the webview.
