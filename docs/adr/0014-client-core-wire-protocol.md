# Client↔Core wire protocol: a single loopback WebSocket carrying JSON-RPC 2.0

Client ↔ Core is a bidirectional logical session. For the Web MVP, that session is implemented as one persistent **WebSocket** on loopback, carrying **JSON-RPC 2.0** Request / Response / Notification messages. Requests handle reads and mutations (including `run/cancel`). Notifications carry live Run progress, Proposal availability, and lightweight invalidation signals. **Run progress is durable in tier 2 through Message text and the Run Log; wire Run Events are live notifications.** After reconnect, the Client refetches state; an active Run resumes through `run/subscribe`'s snapshot-then-tail path.

There is no second transport. Core's HTTP listener also serves the Web Client's static assets on the same TCP port; that is asset hosting, not API, and is covered by [ADR-0015](./0015-web-client-packaging.md).

## What's on the wire

Every frame is a JSON-encoded JSON-RPC 2.0 message. Three shapes:

- **Request**: `{"jsonrpc":"2.0", "id": <request_id>, "method": "...", "params": {...}}`. Either side may send. The receiver replies with a Response carrying the matching `id`.
- **Response**: `{"jsonrpc":"2.0", "id": <request_id>, "result": {...}}` or `{"jsonrpc":"2.0", "id": <request_id>, "error": {"code": <int>, "message": "...", "data": {...}}}`.
- **Notification**: `{"jsonrpc":"2.0", "method": "...", "params": {...}}` — no `id`, no reply expected.

JSON-RPC 2.0 is a small conventional envelope that fits the shapes Inkstone needs. It does not solve schema evolution, reconnect semantics, durability boundaries, ordering, or cancellation guarantees — those are decided in the rest of this ADR. The shapes are minimal and hand-written on both sides per [ADR-0009](./0009-protocol-strategy.md); contract tests in `tests/contract` exercise the round-trip.

## Method namespaces

Slash-style names, taking cues from LSP and Zed's ACP. They are not literal ACP/LSP — Inkstone's domain (Threads, Runs, parked Proposals, multi-tab fan-out) does not collapse onto either spec.

- `thread/*` — Thread CRUD, history, and archive lifecycle. `thread/list`, `thread/list_archived`, `thread/create`, `thread/get`, `thread/rename`, `thread/archive`, `thread/unarchive`.
- `run/*` — Runs. `run/post_message` (creates and starts a Run, returns `run_id`), `run/get_history`, `run/cancel`, `run/retry`, `run/subscribe`.
- `proposal/*` — Proposal review. `proposal/get`, `proposal/decide` (accept | reject | edit).
- `entity/*` — Canonical Entity reads and user-initiated writes. `entity/list` (type-parameterized — one Entity Type per call, e.g. `entity/list(type:"todo")` / `entity/list(type:"person")`), `entity/backlinks`, `entity/mutate` (user-initiated create/update/delete, applied directly per [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md)), shaped per the schema ADR. There is no `entity/changed` Notification and no per-resource subscribe method: self-invalidation after a Client's own `entity/mutate` suffices for single-user (ADR-0033).
- `provider/*` — LLM-provider credential connection. `provider/status` (which providers are connected), `provider/login_start` (begin an OAuth login, returns the authorize URL). Added by [ADR-0023](./0023-provider-oauth-core-owned-credentials.md); see the as-built amendment below. Named `provider/*`, not `auth/*`, because [ADR-0007](./0007-local-first-single-user.md) reserves "auth" for the (absent) human-auth concern.

The only typed subscribe verb is `run/subscribe`, scoped to a single active Run's stream — there is no generic `session/subscribe` with topic strings. Every other live signal rides a socket-wide Notification (see below) that the Client treats as a refetch hint. Adding a subscribe method when a slice needs one is cheaper than registering topics.

## Server-pushed Notifications

Categories Core sends without a Client request:

- **Run Events** — `run/event` notifications carrying `{run_id, event}`. Subtypes per CONTEXT.md: `text_delta`, `tool_call`, `done`, `cancelled`, `error`. One stream per Run, identified by `run_id`. The durable Run Log has a monotonic `run_seq` per Run; the live wire event does not expose it today.
- **Proposal pending / changed** — `proposal/pending` when a Run parks on a Proposal awaiting decision; `proposal/changed` when a pending Proposal is decided or otherwise mutated (ADR-0025).
- **Mutation events** — `thread/titled` (a Run named a Thread), `provider/connected` ([ADR-0049](./0049-provider-connected-notification.md)), and the proposal Notifications above. One Notification per Core-side mutation, not coalesced. The Client uses these to invalidate cached views; tab B sees tab A's edits without polling. **These Notifications are live-only and not persisted.** A Client that misses one because it was disconnected refetches state on reconnect; it does not replay missed invalidation hints.

The `request_id` of the Request that *initiated* a stream is not reused as the stream identifier. Streams are identified by their domain id (`run_id`, `proposal_id`). This decouples stream lifetime from the Request that opened it.

## Durability boundaries

- **Run history + Run Log**: durable in tier 2 (per [ADR-0012](./0012-run-lifecycle-ownership.md) and [ADR-0028](./0028-run-status-materialized-transitions.md)). The live `run/event` Notification is not itself the durable record; `run/subscribe` reconstitutes active-Run text from persisted Message text, and `run/get_history` remains deferred until a consumer needs durable coarse-event replay.
- **Proposal state**: durable in tier 2.
- **Thread / Run / Entity state**: durable in tier 2.
- **Invalidation Notifications** (`proposal/pending`, `proposal/changed`, `thread/titled`, `provider/connected`): live-only. Not persisted. The Client treats them as "refetch this view" hints, nothing more.

The wire does **not** commit Inkstone to a workspace-wide event log. If a future Workflow needs durable, resumable replay of mutation events, that is the right time to introduce a change feed — not now.

## Subscriptions

A Client opens a Run stream with the one typed subscribe method:

- `run/subscribe(run_id, since_run_seq?)` — live Run-Event stream. The `since_run_seq` is optional and only useful for resuming an active Run's stream after a reconnect; for a Run that has already completed, prefer `run/get_history`. **MVP note:** [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) implements `run/subscribe` as *snapshot-then-tail* (Core emits the current persisted assistant text as a snapshot, then the live tail). The `since_run_seq` cursor and `run/get_history` are deferred under that ADR — the snapshot covers the only active-Run resume case the MVP exercises.

Every other live signal — `proposal/pending`, `proposal/changed`, `thread/titled` — rides a socket-wide Notification with no per-resource subscribe method; the Client handles whichever ones it cares about. Closing the WebSocket ends the Run stream and silences the Notifications; the reconnect path (below) re-attaches.

## Reconnect

After a WebSocket drop, the Client:

1. Reconnects the socket. The `WsClient` transport Layer does this on its own with an exponential-then-fixed retry ramp ([ADR-0051](./0051-connection-liveness-signal.md)); the application code does not hand-roll a reconnect.
2. Refetches relevant state via normal queries (`thread/list`, `thread/get` for the open Thread, `entity/list` per Entity Type, `proposal/get` for the pending Proposal if any).
3. **For an active Run**, calls `run/subscribe(run_id)` to resume the live stream.

> **MVP amendment ([ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md)).** Step 3 is a single `run/subscribe(run_id)` call: Core replies with a *snapshot* of the Run's current persisted assistant text, then streams the live tail from a per-run hub. A separate `run/get_history` + `since_run_seq` catch-up call is deferred until a consumer needs durable coarse-event replay. The reloaded Client therefore resyncs an active Run through the same subscribe path as a fresh one.

There is no workspace-global replay cursor. The only "since cursor" in the protocol is the per-Run `run_seq`, scoped to a single active Run's stream — and even that is just a small ordering tool for the active-Run case.

## Liveness

There is no application-level heartbeat. Socket liveness is derived purely from the transport Layer's own connect / reconnect / disconnect lifecycle ([ADR-0051](./0051-connection-liveness-signal.md)): the Layer exposes a `connected | reconnecting | disconnected` signal and reconnects unboundedly when the link drops. A dead Client is noticed by Core when its next attempted send fails; neither side pings.

## Error model

Errors live in JSON-RPC 2.0's `{code, message, data}` shape. Reserve a code range for Inkstone-specific errors and name them:

- `parse_error`, `invalid_request`, `method_not_found`, `invalid_params`, `internal_error` — JSON-RPC reserved (`-32700` to `-32603`).
- `unknown_thread`, `unknown_run`, `run_already_terminal`, `proposal_not_pending`, `provider_login_failed`, `protocol_version_mismatch`, `subscription_not_found` — Inkstone-reserved (e.g. `-32000` to `-32099`). Concrete codes for the implemented ones are pinned in [ADR-0029](./0029-request-handler-seam.md): `unknown_thread` `-32001`, `proposal_not_pending` `-32002`, `provider_login_failed` `-32003`.

### Cancellation

`run/cancel` is a normal Request:

```
Client → Core: Request run/cancel { run_id }
Core   → Client: Response { result: "accepted" | "already_terminal" | "unknown_run" }
Core   → Client (later, if accepted): Notification run/event { kind: "cancelled" }
```

The Response answers "did Core accept the cancel command?" — including the case where the Run had already finished before the cancel arrived (`already_terminal`), or the `run_id` was wrong. The terminal Notification answers "is the Run actually over?" Two distinct facts, two distinct messages.

The Client's UX uses both: on Response `accepted`, show "cancelling…"; on terminal Notification, show "cancelled." On Response `already_terminal`, show "already complete" or just refresh the Run state. Silent fire-and-forget cancellation was rejected: the Response carries information the terminal Notification cannot (was the cancel redundant, was the run_id valid).

Cancellation is a first-class terminal Run Event, not an `error` with a cancellation message. A cancelled Run is user-ended, not failed; keeping the wire shape distinct matches Run status and the Run Log and avoids making Clients parse cancellation out of error text.

If the Worker already streamed assistant text before cancellation wins, Core keeps that partial text in the Thread and marks the assistant Message `incomplete`, not `completed`. The terminal Run Event is still `cancelled`; Clients render the partial text as an unfinished cancelled response rather than deleting it or treating it as a clean answer.

## Version handshake

There is no version-handshake message in the MVP. A Client opens the WebSocket and starts issuing methods directly — no `session/hello`, no `protocol_version` exchange, no `schema_hash`. In production the SPA is embedded in the Core binary (see [ADR-0015](./0015-web-client-packaging.md)) so version mismatch is impossible by construction; in dev, Client and Core build from the same `packages/protocol` source. Re-add an explicit handshake and a `protocol_version_mismatch` error if dev drift turns out to be painful in practice.

## What this ADR does *not* decide

- **Schema for `params` and `result` payloads.** Each method's shape is part of the protocol package and evolves with the slice. Pinned in code, not here.
- **Tier-2 schema for Runs / Proposals / Entities.** Separate ADR.
- **Whether Core spawns the browser** vs. user navigates manually. UX detail.
- **TLS / WSS.** ADR-0007 binds Core to loopback; plain `ws://` is acceptable. If Core ever opens beyond loopback, that ADR supersedes this one and TLS becomes mandatory.

## Considered and rejected

- **REST + WebSocket hybrid** — split-brain consistency, dual reconnect logic, no principled rule for which mutation belongs on which transport. Rejected.
- **SSE + REST** — `Last-Event-ID` is a built-in cursor, but two reconnect domains and awkward in a future TUI Client. Rejected.
- **gRPC / gRPC-Web** — strong streaming and types but pulls in codegen, contradicting [ADR-0009](./0009-protocol-strategy.md) for MVP. Revisit if drift incidents accumulate.
- **stdio (LSP convention)** — incompatible with browser Clients, the MVP target.
- **Multi-channel sockets (Jupyter ZMQ pattern)** — solves multi-frontend priority routing problems Inkstone doesn't have.
- **Bespoke envelope (`{request_id, op, args}` / `{event_type, payload}`)** — reinvents JSON-RPC 2.0 with less spec, fewer libraries, custom error model. Rejected.
- **Workspace-global event log with sequence cursor and permanent retention.** Tempting symmetry, but creates a durable application event log with no concrete need driving it. Per-Run event sequence numbers are sufficient for the only resumable case (an active Run's stream). Mutation events are live-only invalidation hints. Rejected; revisit if a Workflow needs durable change-feed replay.
- **Generic `session/subscribe(topic)` with topic strings.** A concrete typed verb (`run/subscribe`) plus socket-wide Notifications for the rest are smaller, typed, and avoid a topic-registry concept. Rejected.
- **Application-level heartbeat** (a `session/heartbeat` Request on an interval). The motivating case (laptop sleep silently zombying the WebSocket) is handled at the transport layer instead: the `WsClient` Layer's own reconnect detects and re-establishes a dead link ([ADR-0051](./0051-connection-liveness-signal.md)), and Core notices a dead Client when its next send fails. A bespoke heartbeat frame on top earns nothing. Rejected.
- **Fire-and-forget `run/cancel`.** Saves one frame per cancel but loses the ability to distinguish `accepted` vs `already_terminal` vs `unknown_run`. Rejected.
- **`session/hello` version handshake / `schema_hash` runtime fingerprint.** Premature for MVP; production embeds the SPA in Core and dev builds Client and Core from one `packages/protocol` source, so drift is rare and recoverable. Rejected for now.

## As-built amendment: `provider/*` methods (ADR-0023)

[ADR-0023](./0023-provider-oauth-core-owned-credentials.md) adds LLM-provider credential connection to the client surface. The namespace is `provider/*` (not `auth/*`) because [ADR-0007](./0007-local-first-single-user.md) reserves "auth" for the human-auth concern Inkstone deliberately does not have. Two request/response methods plus one Notification:

- **`provider/status`** → `{ providers: [{ id, connected }] }`. Reports which providers have stored credentials. Called by the settings view on mount and on window focus.
- **`provider/login_start`** `{ provider }` → `{ authorize_url }`. Core spawns the Provider Helper, which runs the OAuth `:1455` loopback and prints the authorize URL; Core relays it. The Client opens the URL in a **new tab**; the helper's loopback handles the OpenAI callback and writes credentials via Core, then serves its own success page.
- **`provider/connected`** `{ provider }` Notification ([ADR-0049](./0049-provider-connected-notification.md)). When Core's detached credential-drain task persists the rotated OAuth credentials, it frames this onto the originating connection so the Settings → Models card flips to Connected live, without waiting for the settings tab to regain focus. A focus-driven `provider/status` re-query remains the fallback path.

## Related
- [ADR-0002](./0002-clients-talk-only-to-core.md) — Clients only reach Core.
- [ADR-0007](./0007-local-first-single-user.md) — loopback only; "it's my machine" auth.
- [ADR-0008](./0008-monorepo-shape.md) — `packages/protocol` carries the wire types; `packages/ui-sdk` wraps them for Clients.
- [ADR-0009](./0009-protocol-strategy.md) — manual type mirroring + contract tests; honored here.
- [ADR-0012](./0012-run-lifecycle-ownership.md) — Core is the Run state authority that this protocol surfaces.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — symmetric ADR for the Worker side.
- [ADR-0015](./0015-web-client-packaging.md) — how the SPA reaches the browser in dev vs prod.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — amends this ADR's reconnect flow: `run/subscribe` is snapshot-then-tail over a per-run hub; `run/get_history` deferred.
- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — adds the `provider/*` methods amended above.
- [ADR-0049](./0049-provider-connected-notification.md) — adds the `provider/connected` Notification.
- [ADR-0051](./0051-connection-liveness-signal.md) — transport-layer reconnect + the `connected | reconnecting | disconnected` liveness signal that replaces an application heartbeat.
