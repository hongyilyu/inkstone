# Clients communicate with Core only

Every Client (Web, TUI, Desktop, Mobile, Capture Client) talks to Core through Core's client surface. Clients do not access the SQLite database, the Vault, the Worker, or LLM providers directly.

## Why

Core is the coordination authority for a Workspace: it owns durable state, enforces invariants across Vault and SQLite, mediates Run lifecycle, and brokers credentials. Letting any Client bypass it splits authority — two Clients editing the database concurrently, or holding their own LLM keys, would defeat Core's role and produce inconsistencies that are expensive to recover from.

## Consequences

The following shortcuts are explicitly disallowed:

- **Client → SQLite.** No direct reads or writes; all state goes through Core's client surface, which exposes intent-level operations rather than tables.
- **Client → Vault.** No direct file IO. File reads and writes are mediated so that ingestion bookkeeping and conflict checks are not bypassed.
- **Client → Worker.** Clients submit Runs to Core; Core dispatches to Worker. Clients do not start Workers, send Run Events, or hold a connection to a Worker.
- **Client → LLM provider.** API keys live with Core (or Worker, never on a Client). Clients receive streamed Run Events from Core, not raw provider responses.

This is a real cost — direct DB access in a TUI Client or holding an Anthropic key in the Web Client would be shorter paths to v0 — and we are declining those shortcuts on purpose.

## Related

- [ADR-0003](./0003-worker-via-tool-protocol.md) — the symmetrical rule for the Worker side.
