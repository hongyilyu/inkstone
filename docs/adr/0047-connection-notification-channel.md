# Run-less server→client notifications ride the originating connection

A detached, non-Run Core task that produces a durable result delivers it live by
**framing a JSON-RPC notification onto the originating connection's `out_tx`** —
the same per-connection outbound channel that carries responses and run events.
The notification is keyed by its **`method` string**, not by a run; the Web
Client routes it through a **generic by-method dispatch** (no typed SDK method
per notification) to an app-edge handler that patches local state.

The first message on this channel is **`thread/titled {thread_id, title}`**: the
one-shot title Worker (ADR-0046) pushes the generated title to the connection
that created the thread, so the sidebar updates **without** waiting for the next
`thread/list` read.

## Context

ADR-0046 generates a Thread's title at `thread/create` via a fire-and-forget,
**non-Run** Worker. The title lands in `threads.title`, but **delivery is lazy**:
a connected Client only sees it on its next `thread/list` (cold load /
reconnect). A session that just created a Thread keeps showing the
truncated-prompt placeholder until it refetches. ADR-0046 deferred live delivery
to this follow-up.

The constraint that forced the deferral: **Core has no global connection
registry.** Each WS connection owns its own `out_tx`
(`main.rs::handle_socket`). Every server→client push that exists today is
**run-keyed** — the per-run hub (ADR-0022, `hub.rs`, `Hubs: HashMap<Uuid,
RunHub>`) is reached only because a Client called `run/subscribe(run_id)`, which
spawns a tail forwarder holding a *clone* of that connection's `out_tx`. The
**proposal notifications** (ADR-0025, `reply.rs::send_proposal_pending`) look
like a separate push but ride that same per-run subscription — they are
**not** global. The titler is **not a run**: it mints no hub, no `run_id`, no
subscription. So it has no existing path to any connected Client.

This is the first of a *family* of run-less deliveries Core will need — a
detached task finishes and the **waiting** connection wants the result. The
strongest near-term sibling was **provider OAuth completion**
(`provider.rs`), whose handler then said *"the Client learns the outcome by
re-querying `provider/status` on focus"* — now shipped as the second consumer
(ADR-0049). Cross-tab sync (entity / thread /
settings changed in another tab) is a further, weaker member. This ADR
establishes the channel; `thread/titled` ships on it here, and provider OAuth
completion (ADR-0049) followed as the second consumer.

## Decision

- **Reach = the originating connection.** The producing handler already holds
  the creating connection's `out_tx` (`thread_create::handle`). It is cloned into
  the detached task; on a successful result the task frames a notification and
  `out_tx.send`s it. **No `AppState` change, no global registry, no
  `dispatch`-signature change, no new `handle_socket` select arm.** The title's
  sidebar lives in the creating tab, which shares that connection; OAuth's
  waiting app tab is the initiating one — both real consumers are
  **same-connection**, so per-connection reach serves them.

- **Generic on message type.** Three layers:
  - **Core:** a generic framer `reply::send_notification(out_tx, method,
    params)` building `{jsonrpc, method, params}` — generalizing the shape
    `send_proposal_pending` already hand-builds. A typed `send_thread_titled`
    wraps it for this message.
  - **Web SDK:** `onFrame` gains a generic fallthrough — a
    `setNotificationHandler(method, handler)` registry called for any
    non-`run/event`, non-`proposal/*` method. The typed `WsClient` interface
    does **not** grow a method per notification.
  - **App edge:** the only per-message code is a registered handler. For
    `thread/titled` it patches the `["threads"]` TanStack cache in place
    (replace `title` where `id` matches; order is stable because
    `update_thread_title` deliberately does not bump `last_activity_at`).

- **Best-effort / at-most-once / DB-is-truth.** A dead `out_tx` (tab closed)
  makes the send a silent no-op (`let _ = out_tx.send(...)`); the next
  `thread/list` self-heals. No replay, no ack, no buffering, no terminal-event
  guarantee. This is a **different delivery contract** from the run-event hub
  (exactly-once, ordered, replayable, snapshot-on-attach). The two are
  deliberately **not** unified: the hub's guarantees are load-bearing for a live
  Run stream; a title nudge over DB-backed truth needs none of them.

- **Wire shape.** `ThreadTitledNotification { thread_id: string, title: string }`,
  a Core-emitted notification. It crosses the contract-parity gate
  (ADR-0009 as-built, extended to non-payload messages in PR #198): Rust struct +
  TS Effect Schema + an `emitted` fixture (instance serialized through the real
  serde path) + a registry entry, all atomic.

## Considered and rejected

- **A global broadcast channel** (`AppState.notifier: broadcast::Sender<String>`;
  each connection subscribes on connect; the titler fans out to all). Rejected
  for now: its only capability beyond originating-connection reach is **live
  multi-tab sync**, which has no consumer yet and self-heals via the lazy
  `thread/list` fallback. Both actual near-term consumers (title, OAuth) are
  same-connection. Building a global registry + per-connection subscribe + a new
  `handle_socket` select arm + threading `notifier` through `dispatch` is infra
  for hypothetical consumers (§2 simplicity, §3 surgical). If true cross-tab live
  sync is ever wanted, this ADR is superseded then — the generic by-method
  dispatch on the Client side already accommodates a wider fan-out without
  changing the message surface.

- **Ride the creating Run's hub** (publish the title as a new `RunEvent` through
  the run the Client is already subscribed to). Rejected: it couples title
  lifetime (≤15s) to run lifetime — a short Run removes its hub before the title
  lands, dropping the event into the void — and pollutes the `RunEvent` union
  with a non-run event. ADR-0046 mints no hub for the titler precisely to keep
  the two decoupled.

- **A title-specific SDK stream** (`titleNotifications(): Stream<…>`, mirroring
  `proposalNotifications()`). Rejected: it bakes "title" into the SDK's typed
  surface, so every future run-less message (OAuth, sync) widens the `WsClient`
  interface again. The generic by-method dispatch keeps the typed surface flat;
  a new message is a struct + a registered handler, no SDK interface change.

- **Invalidate-and-refetch on the Client** (`invalidateQueries(["threads"])`
  instead of an in-place patch). Rejected as the apply: the notification *is* the
  new truth (one string; nothing else about the thread changed, order unchanged),
  so a full `thread/list` round-trip per title — N refetches for a burst, plus a
  placeholder flash — is wasteful. Patch in place.

- **Accept lazy-only** (close the item; do nothing). Rejected: it leaves a
  just-created thread showing the placeholder until a refetch, which was the
  defect this follow-up exists to fix. (The placeholder remains the correct
  *fallback* when the push can't be delivered.)

## Related

- [ADR-0046](./0046-generated-thread-title.md) — the one-shot titler whose lazy
  delivery this completes; its "Delivery is lazy" decision is superseded by the
  live push here (the placeholder is retained as the pre-title and
  push-failed fallback).
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — the run-event
  hub: the *other* delivery contract (exactly-once / replayable), deliberately
  kept separate from this best-effort channel.
- [ADR-0025](./0025-proposal-park-and-resume.md) — proposal notifications: the
  per-run-subscription precedent this channel intentionally does **not** copy
  (it rides a subscription; this rides the bare connection).
- [ADR-0009](./0009-protocol-strategy.md) — the wire protocol + the
  contract-parity gate the new notification crosses.
- [ADR-0049](./0049-provider-connected-notification.md) — the second consumer: provider OAuth completion now rides this channel (the sibling this ADR named).
- Follow-ups (zero code here): the title transient-failure retry/regenerate
  affordance (issue #206 deferred item 2); global broadcast / true multi-tab
  live sync.
