# Companion capability grants — onboarding step (2026-07-29)

Approved by Sukhdeep in the guided walk (scope, Telegram depth, UX each picked explicitly).

## What

A new wizard step `grants` between `vault` and `interview` (`/companion-grants`):
after the Companion is named and the vault is chosen, it asks for its job
permissions **one card per screen** (progress dots). Continue to Interview
appears ONLY after the last card is answered. Every grant writes a real,
revocable setting the moment it's answered — nothing decorative, nothing runs
during onboarding.

## Cards (in order)

1. **Files** — shows the REAL chosen vault path + `~/SC Projects`. Vault is
   required (stated honestly, no toggle). `projectWrites` is grantable;
   deny ⇒ Projects page disabled until granted in Settings.
2. **Web** — grant/deny ⇒ `webResearch` (exists today, default off).
3. **Tools (MCP)** — posture `mcpApproval: 'ask' | 'auto'` (default ask ⇒ runs
   pass `--require-approval all`); optional inline first-server add
   (name + command + real Test) if plumbing is a simple invoke, else an honest
   pointer to Settings → Tools.
4. **Approvals** — `approvalMode` approve/auto (exists) + new
   `approvalBlocking` toggle ⇒ runs pass `--approval-blocking`
   (+ `--approval-timeout 300`). Copy states the bound: silent = honestly
   not run, never hangs.
5. **Telegram (reports only, v1)** — bot token + chat id + **Send test
   message**; card confirms ONLY on a real delivered message. Keys stored like
   provider keys (never rendered again). `telegramReports` on ⇒ notifier
   sends: run finished (pass/fail), new "Needs you" items. One-way; acting
   happens in the app.
6. **Summary** — lists every grant verbatim; unlocks Continue → Interview.

## Storage & revocation

New settings keys: `projectWrites` (default true), `mcpApproval` ('ask'),
`approvalBlocking` (false), `telegramBotToken` / `telegramChatId` ('') ,
`telegramReports` (false). All surface in Settings for revocation: Telegram
card (token/chat/test/toggle), blocking toggle beside Approvals, projectWrites
in the same section. Wizard rerun re-asks.

## Plumbing

- Rust `send_telegram(token, chat_id, text)` via existing reqwest →
  `api.telegram.org/bot<t>/sendMessage`; token never touches webview network.
- Notifier: fire-and-forget on run completion + needs-you count increase
  (dedupe on increase only), only when `telegramReports`.
- Run flags: app-side run invocations add approval flags per settings.
- Engine untouched — gates already exist (9a5cf02 + 65b5376).

## Tests

Grants flow: Continue locked until all answered; each card writes its key;
deny paths verified. Settings normalize defaults. Telegram: URL/arg build unit
(Rust), send mocked in TS; test-message success path pinned. Wizard dots show
the new step.

## Honesty rules (binding)

Card copy names the exact setting it writes; denied = truly off; Telegram
green only after real delivery; no fabricated confirmations anywhere.
