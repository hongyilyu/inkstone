# Local-first, single-user

Inkstone runs on the user's machine and serves exactly one human per install. Multi-user, multi-tenant, and shared-server models are out of scope and will not be designed for. Going multi-tenant requires a new ADR that supersedes this one.

## What this means concretely

- **Single user per install.** Not "per Workspace" — per install. Multiple Workspaces in one install are fine; multiple humans sharing a Workspace is not supported.
- **Local-first by default.** Everything Inkstone owns runs on the user's machine: Core, Worker, SQLite, Vault. LLM providers are a controlled exception — the LLM call has to leave the machine — but no other Inkstone component requires a remote service.
- **Network exposure is loopback-only by default.** When Core listens for Clients (Web, TUI, etc.), it binds to localhost. Reaching Inkstone from another device on the LAN, or from outside, is not in scope until an explicit decision opens it.
- **No human auth flow.** "It's my machine" is the authentication. There is no login, no user table, no session token for the human user. (LLM provider credentials are a separate concern with their own handling.)

## Why explicit rejection rather than "may revisit"

A "may revisit later" framing gives every future feature an excuse to half-design for multi-user "just in case" — a `created_by` column here, a tenant-scoped query there. Each one feels harmless individually; together they erode the constraint without any single decision having recorded the change.

Naming the rejection makes those moments visible: any PR that adds multi-user scaffolding contradicts this ADR and has to either argue against it or supersede it.

## Why not skip the ADR

The constraint is implicit in the current architecture, but the temptation to drift is concrete and recurring (sharing with a partner, accessing from a phone over the LAN, multi-device sync). Without an explicit anchor, those conversations have to re-derive the trade-off each time.

## Considered and rejected

- **Multi-tenant from day one.** Cost in schema, auth, secrets isolation, and network exposure is significant; benefit is hypothetical for a personal project.
- **Single-user but with multi-user-friendly schema.** Half-measures collect cost without delivering capability; if multi-user is needed later, the rewrite is justifiable on its own merits at that point.
