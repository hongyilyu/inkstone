# Provider OAuth: Core-owned credentials, reused pi-ai flow, Core-orchestrated refresh

The first real provider (ChatGPT/Codex) authenticates with OAuth. We reuse `pi-ai`'s pure OAuth functions for the hard parts (PKCE login, token exchange, refresh-with-rotation), but **Core owns the credential bytes** on disk, **Core orchestrates refresh** (serialized, before each Worker spawn), and the Worker manifest carries **only a short-lived access token** — never the refresh token. The login flow runs in a stateless TypeScript **Auth Helper** process Core spawns; its result is handed back to Core, which writes it.

This ADR records that division because it is hard to reverse (it shapes the manifest, the credential store, and the Worker's trust surface), surprising without context (the obvious "Worker authenticates itself" path is explicitly rejected), and the result of a real trade-off against reimplementing OAuth in Rust and against vendoring `pi-coding-agent`'s storage.

## Context

- ADR-0001/0013: the Worker is TypeScript, per-Run, ephemeral, and holds **no durable state** — everything durable is Core's tier 2.
- ADR-0002: Clients talk only to Core.
- ADR-0007: Inkstone is local-first, single-user, no human auth — but **provider credentials are explicitly carved out as "a separate concern with their own handling."**
- ADR-0018: the Worker is a generic interpreter driven by a manifest Core ships at spawn.
- `pi-ai` (`@earendil-works/pi-ai`) exposes **pure** OAuth functions: `loginOpenAICodex` (PKCE + `:1455` loopback + token exchange), `refreshOpenAICodexToken`, and `getOAuthApiKey(providerId, creds)` (refresh-if-expired → `{ newCredentials, apiKey }`). None of them touch disk — persisting the result is the caller's job. The file-storage wrapper (`AuthStorage`, `proper-lockfile`) lives in the heavier `pi-coding-agent` package.

## Decision

1. **Depend on `pi-ai` + `pi-agent-core` only** — not `pi-coding-agent`. Reuse pi-ai's pure OAuth functions wholesale; do not reimplement PKCE, token exchange, or refresh-rotation in Rust.

2. **Core owns the credential bytes.** Credentials are stored in a `0600` JSON file beside `db.sqlite` (the Credential Store), holding `{ access, refresh, expires, accountId }` for `openai-codex`. Core is the **single writer** — no other process writes credential bytes, so no file-locking is needed.

3. **Core orchestrates refresh, serialized.** Before spawning a Worker, Core reads the stored `expires`. If still valid (common path), Core ships only the access token in the manifest. If expired (rare path), Core invokes the Auth Helper in `refresh` mode under a single in-process `tokio::Mutex`, with a **double-checked expiry** after acquiring the lock (so a second concurrent expired Run reuses the just-refreshed token rather than refreshing again). The rotated credentials are persisted before the Worker spawns.

4. **The manifest carries only the access token.** The refresh token (the long-lived secret) never crosses the process boundary into a Worker. The codex provider re-derives `accountId` from the access-token JWT at call time, so the access token alone is sufficient for a Run.

5. **Two stateless TypeScript entry points** in `packages/worker`: the run interpreter (gets an access token, runs the chat loop) and the Auth Helper (`login` / `refresh` modes, runs pi-ai's OAuth). Neither holds durable state; Core owns the file and all orchestration.

6. **Login orchestration rides Core's client surface (ADR-0014).** The Web Client never runs OAuth itself: it asks Core to start login, Core spawns the Auth Helper, the helper's `:1455` loopback handles the OpenAI callback and prints the credential JSON on stdout, and Core writes it. See the ADR-0014 amendment for the wire methods.

## Why the Worker holding an access token does not violate ADR-0013

ADR-0013 frames the Worker as holding no **durable** state — anything that must survive tear-down lives in Core's tier 2. The access token in the manifest is **not durable Worker state**: it is short-lived, Core-owned, re-supplied fresh on every spawn, and discarded when the Worker exits. The durable secret (the refresh token) stays in Core's Credential Store. ADR-0007's explicit carve-out — provider credentials are a separate concern, neither SQLite-canonical nor Vault — means the Credential Store sits outside the tier-2/tier-3 model without contradicting it, and ADR-0003's chokepoint (no Worker access to SQLite or the Vault) is untouched.

## Considered and rejected

- **(A) Reimplement OAuth in Rust (Core owns flow end-to-end).** Core generates PKCE, binds `:1455`, exchanges the code, and refreshes — no TS auth process. Rejected: the refresh path rotates the refresh token on every call, and the Run-time token use already happens TS-side (pi-ai makes the provider call), so the genuinely fiddly part would be hand-rolled in Rust for no reuse. The flow constants would also drift from pi's tested copy.

- **(B) Worker refreshes; manifest carries full credentials.** Each Worker calls `getOAuthApiKey` and emits a `credentials_rotated` write-back frame on rotation. Rejected: two concurrent expired Runs each hold the same refresh token and race — the first refresh invalidates the token the second is using, failing the second Run. Serializing that race would require pushing a lock across the stdio boundary (reinventing the in-process mutex badly), and it copies the long-lived refresh token into every Worker.

- **(C) Vendor `pi-coding-agent`'s `AuthStorage`.** Reuse pi's file storage + `proper-lockfile`. Rejected: a heavy dependency pulled in purely for storage we get for free by making Core the single writer. File-locking exists in pi only because multiple agent processes write the same file; Core-as-single-writer removes the need entirely.

## Related

- [ADR-0001](./0001-core-worker-split.md) / [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is ephemeral and holds no durable state; this ADR resolves the apparent tension with the access token in the manifest.
- [ADR-0002](./0002-clients-talk-only-to-core.md) — login orchestration goes through Core's client surface, not the Web Client running OAuth directly.
- [ADR-0007](./0007-local-first-single-user.md) — provider credentials are the explicitly carved-out "separate concern" this ADR handles.
- [ADR-0003](./0003-worker-via-tool-protocol.md) — the Worker's no-SQLite/no-Vault chokepoint stays intact; the Credential Store is Core's.
- [ADR-0014](./0014-client-core-wire-protocol.md) — amended with `auth/login_start` and `auth/status`.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — the manifest this ADR extends with an access token.
