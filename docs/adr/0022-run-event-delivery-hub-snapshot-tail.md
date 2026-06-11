# Run event delivery: per-run hub, connection-decoupled, snapshot-then-tail subscribe

A Run's live event stream is owned by Core and observable by any connection, not bound to the WebSocket that started it. Core holds a **per-run hub** (a broadcast channel keyed by `run_id`); the Worker writes events into the hub, and any Client connection receives them by calling `run/subscribe(run_id)`. On subscribe, Core sends the **current persisted assistant text as a snapshot**, then streams subsequent live events (the **tail**). This is what makes a mid-stream page refresh recover: the reloaded tab is a new connection that re-subscribes, gets the snapshot, and resumes the live tail while the same Run keeps running. The MVP reconnect path defined in [ADR-0014](./0014-client-core-wire-protocol.md) is amended by this ADR — snapshot-then-tail replaces the `run/get_history` + `run/subscribe` two-call flow, and durable coarse-event replay (`run/get_history`, `since_run_seq`) is deferred until a consumer needs it.

## Context

Before this decision, Core forwarded a Worker's Run Events straight onto the originating connection's outbound channel: the Worker task captured the WebSocket sender of the connection that issued `run/post_message`, and wrote events to it directly. That binds a Run's *live* stream to a single socket. When that socket drops — a page refresh, a navigation, a laptop sleep — the forward loop breaks and the live stream is lost, even though the Worker is still running and Core is still persisting every delta to tier 2.

The chat-driven MVP ([ADR-0010](./0010-mvp-slice-chat-driven-web-client.md)) wires the Web Client to Core for the first time, and multi-Thread chat means a user starts a Run in one Thread and switches to another while it streams. Both "refresh mid-stream" and "leave a running Thread and come back" require the live stream to outlive the connection that started it. The persisted-text half of this is already solved — Core writes each `text_delta` to `message_parts.text` *before* forwarding (per [ADR-0017](./0017-tier-2-schema-slice-1.md)'s live-streaming model) — so durability is not the gap. Only the **live forward** was connection-bound.

## Decision

- **Per-run hub.** `AppState` holds a map `run_id → RunHub`, where a `RunHub` carries a `tokio::sync::broadcast` sender plus a per-run gate (see below). The hub entry is created when the Worker is spawned and removed when the Run reaches a terminal state.
- **The Worker writes to the hub, not to a connection.** The Worker-forwarding task publishes each Run Event into `hub[run_id]`. The connection that issued `run/post_message` is no longer special; it receives events only by subscribing, exactly like any other connection.
- **`run/subscribe(run_id)` is snapshot-then-tail.** On subscribe, Core reads the Run's current persisted assistant text and status, emits that accumulated text as a `text_delta` Run Event (the snapshot), then — if the Run is still streaming — attaches a hub receiver and forwards the live tail; if the Run is already terminal, it emits the matching terminal Run Event and closes. A reloaded tab and the originating tab use the identical path.
- **`run/post_message` and `thread/create` are pure-subscribe.** They create and start the Run and return its ids; they stream nothing on the request frame. The Client always follows with `run/subscribe(run_id)` to receive events. This keeps "fresh send" and "reconnect resume" on one code path.
- **The snapshot remains a `text_delta`.** The snapshot rides as a `text_delta` carrying cumulative text; the Client appends it like any other delta. No snapshot-specific event variant is introduced for this feature. (As-built amendments: `error { message }` and later `cancelled` were added as terminal Run Events — see ADR-0006 and ADR-0014. They ride the identical hub/snapshot/tail path; the forwarder treats `error` and `cancelled` as terminal alongside `done`. This does not reopen the snapshot-as-`text_delta` decision above.)

## The exactly-once guarantee (snapshot/tail boundary)

A naive snapshot-then-attach loses events: a delta persisted *after* the snapshot read but *before* the receiver attaches appears in neither. The hub closes this with a **per-run gate** (an async mutex) that makes two critical sections mutually exclusive:

- **Worker, per event:** `lock gate → persist delta → publish to hub → unlock`.
- **Subscribe handler:** `lock gate → read snapshot → attach receiver → unlock`.

Because both take the same per-run gate, every delta falls wholly before or wholly after the subscribe instant: a delta persisted before subscribe is in the snapshot and the receiver is positioned after it (delivered once, via snapshot); a delta published after subscribe is caught by the attached receiver (delivered once, via tail). Exactly-once, with no per-delta sequence number and no schema change. The gate is per-run, so it never serializes unrelated Runs; the only contention is one Run's Worker against a simultaneous subscribe to that same Run, lasting one SQLite write.

If a slow subscriber overflows the bounded broadcast buffer (`broadcast::error::RecvError::Lagged`), the subscriber **re-snapshots** from tier 2 (the persisted text is always the floor) and resumes the tail. Lag degrades to "re-read the truth," never to lost text.

### Terminal-event ordering (as-built amendment, real-worker-codex slice 9)

The exactly-once gate above governs **`text_delta`** delivery. The **terminal** event (`done`/`error`/`cancelled`) has a second ordering constraint the original design did not pin: it must not reach a Client *before* tier 2 reflects the terminal state. The Worker originally published every event — terminal included — from inside the event loop, before the terminal SQLite transaction (`complete_run`/`error_run`) committed. That opened a sub-millisecond window: a Client reacting to `done` (most concretely, posting the next Run in the same Thread, whose history assembly filters on `status='completed'`) could read tier 2 *before* the prior Run's assistant Message flipped from `streaming` to `completed`, and so miss that turn.

The fix: the terminal `done`/`error`/`cancelled` event is published to the hub **after** the terminal transaction commits (and still before `hub::remove`). For `done`/`error`, the Worker loop owns both the transition and event; for `cancelled`, `run/cancel` owns both after winning the guarded transition. `text_delta` publishing is unchanged — still `lock gate → persist → publish → unlock` in the loop. This does not weaken the gate (the terminal event is not text and never rode the snapshot/tail dedup), and terminal delivery to late subscribers is still guaranteed by the forwarder's synthesize-on-`Closed` path. The net guarantee added: **any Client that observes a terminal Run Event is guaranteed that tier 2 has committed the Run's terminal state**, so a read triggered by the terminal event always sees terminal Messages.

## Consequences

- **`run/get_history` and `since_run_seq` are deferred.** [ADR-0014](./0014-client-core-wire-protocol.md) §Reconnect specifies a two-call active-Run resume (`run/get_history(run_id, since_run_seq)` then `run/subscribe`). The snapshot-then-tail subscribe covers the only resume case the MVP exercises (an active Run's text), so `run/get_history`, the `since_run_seq` cursor, and durable coarse-event *replay* are not built now. The `run_log` table (renamed from `run_events`; ADR-0028) still receives coarse lifecycle rows (`running`, `done`, `error`, `cancelled`, park/proposal milestones); nothing reads them back yet. When a consumer needs sub-Turn coarse-event replay (e.g. surfacing tool boundaries across a reconnect), add `run/get_history` then.
- **Concurrent subscriptions scale with in-flight Runs.** The Web Client keeps a subscription alive for any Thread with a running Run (so a backgrounded Thread keeps streaming), and drops it when the Run reaches `done`. For single-user echo this is one or two live subscriptions. A future real-LLM slice with many long-lived Runs may want a warm-keep / idle-eviction cache for thread-detail subscriptions; that optimisation is out of scope here.
- **The hub is in-memory and per-process.** It holds no durable state — tier 2 is the source of truth for text, and a hub entry's whole job is the live tail of a currently-streaming Run. A Core restart drops in-flight hubs; the Runs they served become `errored` per [ADR-0012](./0012-run-lifecycle-ownership.md)'s ownership rules, and their partial text is already persisted.

## Thread creation is message-first

A Thread is created only by a request that carries its first user message. `thread/create({prompt})` mints the Thread, starts its first Run, and returns `{thread_id, run_id}` in one round trip; `run/post_message` operates on an existing Thread and requires a `thread_id`. There is no message-less `thread/create`, so an empty Thread never exists: an idle Client that opens the page and does nothing writes nothing to Core, and there are no junk rows to prune. An empty or whitespace-only prompt is rejected by Core with `invalid_params` before any Thread or Run row is written (the Web Client also guards it client-side, but Core is the authority per [ADR-0002](./0002-clients-talk-only-to-core.md)).

This was chosen over a message-less `thread/create` that returns a `thread_id` up front: that shape creates an empty Thread on every "new chat" click and forces either thread-pruning bookkeeping or accumulating titleless runless rows. Message-first creation removes the empty-Thread state entirely at the cost of `post_message` always carrying a `thread_id` (never optional) — an acceptable trade for not modelling a lifecycle state that has no product meaning.

## Considered and rejected

- **Keep connection-bound forwarding; only persist for durability.** Refresh would reload completed text from tier 2 but a mid-stream refresh would freeze the partial bubble — the live stream dies with the socket. Rejected: it fails the "fire in Thread A, work in Thread B, come back to a live A" requirement and ChatGPT-style mid-stream refresh.
- **Full [ADR-0014](./0014-client-core-wire-protocol.md) reconnect now (`run/get_history` + `since_run_seq`).** More complete, but builds durable coarse-event replay and cursor machinery for a fidelity no MVP consumer needs. Snapshot-then-tail is the strict subset that serves the observable behavior. Deferred, not rejected outright.
- **Per-delta sequence numbers on the wire to dedup snapshot vs tail.** Would let the subscriber reconcile overlap without a gate, but adds a sequence column to the streaming path and the wire, and a dedup step on the Client. The per-run gate gives exactly-once with neither. Rejected.
- **Buffer/replay all events in the hub for late subscribers.** A per-run ring buffer duplicates what the persisted snapshot already provides. The snapshot from tier 2 is the durable floor; the hub only needs the live tail. Rejected as redundant.
- **Event-sourced delta log (t3code's model).** t3code persists each delta as a durable append-only event and folds them into a projected message text. Inkstone is explicitly not event-sourced ([ADR-0004](./0004-three-tier-storage-authority.md)); the current-state `message_parts.text` cell ([ADR-0017](./0017-tier-2-schema-slice-1.md)) is the analogous primitive, and the snapshot is a read of that cell. Rejected for Inkstone's architecture.
- **Message-less `thread/create` returning a `thread_id` up front.** Cleaner separation of "birth a Thread" from "run a message," but creates empty Threads on "new chat" and needs pruning. Rejected (see *Thread creation is message-first*).

## Related

- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — the chat-driven slice this delivery model serves; the Web Client wiring is its first consumer.
- [ADR-0012](./0012-run-lifecycle-ownership.md) — Core owns Run state; a dropped connection does not end a Run, and a Core restart errors in-flight Runs whose hubs are lost.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — the Worker is per-Run and Core-owned; this ADR pins where its emitted events land (the hub) rather than on a connection.
- [ADR-0014](./0014-client-core-wire-protocol.md) — the wire protocol this ADR amends: snapshot-then-tail replaces the two-call active-Run resume; `run/get_history` deferred.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — the tier-2 streaming-text model (append-in-place into the `text` part, coarse events in `run_log`) that the snapshot reads from; honored unchanged.
- [ADR-0025](./0025-proposal-park-and-resume.md) — adds a `parked` branch to `run/subscribe`: snapshot + status, no `done`, no tail, so a refreshed Client does not see a false terminal.
