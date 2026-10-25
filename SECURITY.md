# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
use **Security → Report a vulnerability** on this repository, which opens a
private advisory visible only to the maintainer.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgement, and a fix or an explanation, as quickly as a
one-person project allows. If you want credit in the advisory, say so.

Especially welcome: any way to make a command, a tool, a model or a document
**get past a gate the README says it cannot get past** — the privacy floor, the
destructive-command denylist, the approval gate, the containment deny-list, or
the four gates on a crew-built tool.

## What SC Prism can do on your machine

SC Prism is an agent-orchestration tool. Read this before granting it anything.
When you grant the corresponding permissions, it can:

- run shell commands on your computer, with your user account's privileges;
- read, create, modify and delete files in folders you point it at;
- capture your screen and control your keyboard and mouse;
- send the contents of your messages, files and tool results to whichever
  third-party AI providers you configure, over the internet.

These capabilities are **off by default** and each requires an explicit grant.
You decide what to grant, to which agents, and on what data.

## Limits, stated plainly

- **Containment is a deny-list, not a sandbox.** A contained command still runs
  as your user and can read and write your ordinary files, reach the network and
  use your installed tools. What it cannot do is read your saved credentials or
  write SC Prism's own approval file. Verification commands you configure run
  outside containment. If `sandbox-exec` is unavailable, commands run uncontained
  and the record says `contained: false`.
- **The privacy floor matches words, not meaning.** Text containing terms such as
  "password", "credential", "api-key", "token" or "secret" — plus any words you add
  — is pinned to a local model. An unlabelled API key, an account number or an
  address that is not accompanied by one of those words will not be recognised.
  Do not rely on it as your only safeguard; for work that must never leave your
  machine, use local-only routing.
- Your use of a third-party AI provider through SC Prism is governed by that
  provider's terms and privacy policy.

SC Prism has no telemetry, no analytics and no accounts. Its network traffic goes
only where you send it: to the AI providers you connect; to web search
(DuckDuckGo unless you configure another endpoint) and the pages an agent fetches,
when you grant web research; and to integrations you switch on — Telegram
approvals, GitHub sync, and any MCP servers you add.

## Supported versions

Security fixes land on `main` and in the next release. Only the latest release is
supported.
