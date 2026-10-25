# Cold-start connectivity check — minimal design

**Date:** 2026-07-12 · **Status:** approved scope (re-scoped from a fuller draft at Sukhdeep's request) · **Owner:** Sukhdeep

## Problem

The persisted `connected` flag on a provider is *user intent* ("I set this service up"), not liveness. Nothing probes at launch, so a dead local server (LM Studio / Ollama not running) is invisible: the app opens normally and, in native mode, a chat message can fall back to the simulated engine without saying so. Sukhdeep hit exactly this: local server down, app silent.

The probe primitive already exists and is trusted: `pingProvider(baseUrl, apiKey, providerId) → 'ok' | 'auth' | 'unreachable'` in `src/lib/settings.ts` — native CORS-free ping via the Rust `ping_provider` command, per-provider paths/auth, CLI-bridge binary check. It is currently only wired to the Test buttons in Providers and Settings.

## Scope (deliberately minimal)

Two user-visible behaviors, nothing else:

1. **Launch probe.** Once per cold start, probe every `connected` service. If anything is not `ok`, show a red status dot in the app shell and one banner on the Workspace.
2. **Honest chat error.** In native mode, a chat send against an unreachable primary produces an explicit error card with recovery actions — never a silent simulated answer.

**Cut from the earlier draft (do not build):** periodic 60s polling, window-focus re-probes, per-service dot cluster, companion/co-founder announcement, "Switch primary" quick action, engine-side health service. Rationale: the user journey touches connectivity at exactly two moments — app open and message send. Everything else was polish ahead of need.

## Design

### 1. Connectivity store — `src/lib/connectivity.tsx` (new)

`ConnectivityProvider` + `useConnectivity()`, same context pattern as `SettingsProvider`. In-memory only — never persisted (a persisted status is the same staleness bug we are fixing).

```ts
type ServiceHealth = { status: 'checking' | 'ok' | 'auth' | 'unreachable'; lastChecked: number }
interface ConnectivityValue {
  health: Record<string, ServiceHealth>   // keyed by provider id; only connected services present
  anyDown: boolean                        // any connected service in 'auth' | 'unreachable' ('checking' is not "down")
  primaryDown: boolean                    // the primary specifically in 'auth' | 'unreachable'
  probeAll: () => Promise<void>           // one in-flight sweep at a time; re-entrant calls coalesce
  probeOne: (id: string) => Promise<ProviderStatus>
}
```

`probeAll` fans `Promise.allSettled` over `pingProvider` for every provider with `connected === true` (plus the primary, always). `pingProvider` is reused untouched.

**When probes run** (exhaustive list):
- once on mount, after the settings hydration gate resolves (cold start);
- on banner **Retry**;
- `probeOne(primaryId)` inside the send guard (§3);
- when a send-time call failure marks the primary `unreachable` (store update, no extra probe).

No timers, no focus listeners. A recovered service clears on the next **Retry** (any service) or the next message send (primary only — the send guard probes just the primary).

### 2. Surfacing

- **Shell dot** (`AppShell.tsx`): one small indicator in the chrome, rendered only when `anyDown`. Red if any service is `unreachable`, amber if the worst state is `auth`. Tooltip lists the affected service names + state ("LM Studio — unreachable · checked 12:04"). Click navigates to `/providers`. When everything is `ok`: nothing rendered — no new chrome in the healthy state.
- **Workspace banner**: rendered on the Workspace when `anyDown`. Text names the service and state plainly — *"Local AI (LM Studio) is unreachable — is the server running?"* / *"OpenAI rejected your API key."* Actions: **Retry** (calls `probeAll`, shows spinner on the dot/banner) and **Open Providers**. Dismissible; a dismissal lasts until the next cold start or the next healthy→down transition.
- CLI-bridge providers: binary present = `ok` (existing semantics). Their sign-in problems surface only through the send-time error path (§3); the tooltip for a CLI service reads "installed — sign-in verified on first call".

### 3. Honest chat error (native only)

In `AppStore.sendIntent`, native path, before dispatching to the real engine:

1. If the store says the primary is `unreachable`, run one fresh `probeOne(primary)` — never block on stale state.
2. Still unreachable → append an **error chat message** (new message kind, styled like a red-tinted system card, not a fake assistant reply): *"Local AI (LM Studio) is unreachable — nothing was sent. Start the server and retry."* Actions on the card: **Retry** (re-probe; if ok, resend the original text) and **Open Providers**. The intent is NOT dispatched; no Verdict, no sim fallback.
3. If the probe says `ok` but the real call then fails (server died mid-flight, CLI sign-in expired), the failure routes to the same error card instead of the sim fallback, and the store marks that provider `unreachable`.

Browser mode is untouched: it runs the simulation by design and keeps its existing labeling.

### 4. Out of scope, recorded for later

- Periodic / focus-driven re-probing, per-service dots, companion announcements — revisit only if the minimal version proves insufficient in daily use.
- **Project-workspace write surface** (tasks writing real code files outside the vault, e.g. scaffolding a portfolio site) — agreed as the *next* design conversation; it is the larger journey gap this feature was trimmed to make room for.

## Testing (Vitest, `pingProvider` mocked)

- Store: cold-start `probeAll` sets per-service statuses; concurrent `probeAll` calls coalesce to one sweep; send-time failure marks the provider unreachable.
- Banner: renders when a service is down, names it correctly for `unreachable` vs `auth`; Retry triggers a sweep; dismissal persists until a new down-transition.
- Send guard: dead primary → error card appended, engine NOT invoked, no sim message; probe-ok-then-call-fail → same error card; browser mode bypasses the guard.
- Shell dot: hidden when healthy, red/amber per worst state.

## Acceptance

Open the app with LM Studio stopped → within a few seconds the shell shows a red dot and the Workspace names the dead server. Send a message anyway → an explicit "unreachable — nothing was sent" card, not a simulated answer. Start LM Studio, hit Retry → dot and banner clear, resend works. `verify.sh` stays green.
